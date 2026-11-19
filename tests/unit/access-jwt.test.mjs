import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  verifyAccessJwt,
  verifyMcpServiceToken,
  parseJwt,
  loadKeysFromCertsJson,
  resetAccessJwtCertCache,
  accessJwtEnabled,
  accessJwtMustBeConfigured,
  runningOnCloudflareWorkers,
  omitAccessClientSecret,
} from '../../src/adapters/http/access-jwt.js';
import workerMod from '../../src/worker.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signJwtRs256(payload, privateKey, { kid = 'test-kid' } = {}) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64url(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
  return `${input}.${b64url(sig)}`;
}

async function publicKeyToCryptoKey(publicKey) {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

test('accessJwtEnabled requiere ACCESS_TEAM_DOMAIN y ACCESS_AUD', () => {
  assert.equal(accessJwtEnabled({}), false);
  assert.equal(accessJwtEnabled({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' }), true);
});

test('verifyAccessJwt: en Node no hace nada si vars Access ausentes', async () => {
  const req = new Request('https://x/v1/health');
  assert.equal(runningOnCloudflareWorkers(), false);
  assert.equal(accessJwtMustBeConfigured({}), false);
  assert.equal(await verifyAccessJwt(req, {}), null);
  assert.equal(await verifyAccessJwt(req, {}, { onCloudflare: false }), null);
});

test('verifyAccessJwt: en producción, sin vars, responde 503 y no sigue', async () => {
  const req = new Request('https://x/v1/health');
  await assert.rejects(
    () => verifyAccessJwt(req, { ACCESS_JWT_REQUIRED: 'true' }),
    (e) => e.code === 'SERVER_MISCONFIGURED' && e.http === 503,
  );
  await assert.rejects(
    () => verifyAccessJwt(req, { ACCESS_TEAM_DOMAIN: 'team.example.com' }, { onCloudflare: true }),
    (e) => e.code === 'SERVER_MISCONFIGURED' && e.http === 503,
  );
  const res = await workerMod.fetch(new Request('https://local.test/v1/health'), {
    ACCESS_JWT_REQUIRED: 'true',
    PUBLISHER_MODE: 'mock',
  });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'SERVER_MISCONFIGURED');
  assert.equal(body.service, undefined);
});

test('verifyAccessJwt: valida firma y audience con claves de test', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cryptoKey = await publicKeyToCryptoKey(publicKey);
  const env = { ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'my-audience-tag' };
  const now = 1_700_000_000_000;
  const token = signJwtRs256({ aud: 'my-audience-tag', exp: Math.floor(now / 1000) + 3600 }, privateKey);
  const req = new Request('https://x/v1/health', { headers: { 'cf-access-jwt-assertion': token } });
  const payload = await verifyAccessJwt(req, env, {
    now,
    getCertKeys: async () => new Map([['test-kid', cryptoKey]]),
  });
  assert.equal(payload.aud, 'my-audience-tag');
});

test('verifyAccessJwt: rechaza iss distinto y nbf futuro cuando el token los trae', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cryptoKey = await publicKeyToCryptoKey(publicKey);
  const env = { ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'my-audience-tag' };
  const now = 1_700_000_000_000;
  const deps = { now, getCertKeys: async () => new Map([['test-kid', cryptoKey]]) };
  const badIss = signJwtRs256({
    aud: 'my-audience-tag', exp: Math.floor(now / 1000) + 60, iss: 'https://otro.example',
  }, privateKey);
  await assert.rejects(
    () => verifyAccessJwt(new Request('https://x/', { headers: { 'cf-access-jwt-assertion': badIss } }), env, deps),
    (e) => e.code === 'ACCESS_DENIED',
  );
  const early = signJwtRs256({
    aud: 'my-audience-tag',
    exp: Math.floor(now / 1000) + 60,
    nbf: Math.floor(now / 1000) + 30,
    iss: 'https://team.example.com',
  }, privateKey);
  await assert.rejects(
    () => verifyAccessJwt(new Request('https://x/', { headers: { 'cf-access-jwt-assertion': early } }), env, deps),
    (e) => e.code === 'ACCESS_DENIED' && e.message.includes('aún no válido'),
  );
});

test('verifyAccessJwt: rechaza un JWT que no es RS256', async () => {
  const header = b64url(JSON.stringify({ alg: 'none', kid: 'test-kid' }));
  const body = b64url(JSON.stringify({ aud: 'expected', exp: Math.floor(Date.now() / 1000) + 60 }));
  const token = `${header}.${body}.`;
  const req = new Request('https://x/', { headers: { 'cf-access-jwt-assertion': token } });
  await assert.rejects(
    () => verifyAccessJwt(req, { ACCESS_TEAM_DOMAIN: 't', ACCESS_AUD: 'expected' }, { getCertKeys: async () => new Map() }),
    (e) => e.code === 'ACCESS_DENIED',
  );
});

test('verifyMcpServiceToken exige aud propio, common_name e iss y no el correo', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cryptoKey = await publicKeyToCryptoKey(publicKey);
  const now = 1_700_000_000_000;
  const env = {
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: 'aud-ui',
    ACCESS_MCP_AUD: 'aud-mcp',
    MCP_SERVICE_TOKEN_CLIENT_ID: 'conector.access',
  };
  const deps = { now, getCertKeys: async () => new Map([['test-kid', cryptoKey]]) };
  const claims = {
    aud: 'aud-mcp',
    exp: Math.floor(now / 1000) + 60,
    iss: 'https://team.example.com',
    common_name: 'conector.access',
    sub: '',
  };
  const ok = await verifyMcpServiceToken(
    new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': signJwtRs256(claims, privateKey) } }),
    env,
    deps,
  );
  assert.equal(ok.common_name, 'conector.access');
  assert.equal(ok.email, undefined);

  const futureNbf = signJwtRs256({
    ...claims,
    nbf: Math.floor(now / 1000) + 30,
  }, privateKey);
  await assert.rejects(
    () => verifyMcpServiceToken(new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': futureNbf } }), env, deps),
    (e) => e.code === 'UNAUTHENTICATED' && e.http === 401,
  );
  const noExp = signJwtRs256({ ...claims, exp: undefined }, privateKey);
  await assert.rejects(
    () => verifyMcpServiceToken(new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': noExp } }), env, deps),
    (e) => e.code === 'UNAUTHENTICATED' && e.http === 401,
  );
  const noIss = signJwtRs256({ ...claims, iss: undefined }, privateKey);
  await assert.rejects(
    () => verifyMcpServiceToken(new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': noIss } }), env, deps),
    (e) => e.code === 'UNAUTHENTICATED' && e.http === 401,
  );

  const person = signJwtRs256({ ...claims, aud: 'aud-ui', email: 'ana@example.com', common_name: undefined }, privateKey);
  await assert.rejects(
    () => verifyMcpServiceToken(new Request('https://x/mcp', { headers: { 'cf-access-jwt-assertion': person } }), env, deps),
    (e) => e.code === 'UNAUTHENTICATED' && e.http === 401,
  );
  await assert.rejects(
    () => verifyMcpServiceToken(new Request('https://x/mcp'), {}),
    (e) => e.code === 'SERVER_MISCONFIGURED' && e.http === 503,
  );
});

test('omitAccessClientSecret quita el secreto, el bearer y las cabeceras cf-', () => {
  const req = new Request('https://x/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer abc',
      'CF-Access-Client-Secret': 'secreto-de-prueba',
      'cf-access-jwt-assertion': 'jwt',
    },
    body: '{}',
  });
  const next = omitAccessClientSecret(req);
  assert.equal(next.headers.get('cf-access-client-secret'), null);
  assert.equal(next.headers.get('authorization'), null);
  assert.equal(next.headers.get('cf-access-jwt-assertion'), null);
  assert.equal(next.headers.get('content-type'), 'application/json');
});

test('verifyAccessJwt: rechaza audience incorrecto', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cryptoKey = await publicKeyToCryptoKey(publicKey);
  const token = signJwtRs256({ aud: 'wrong', exp: Math.floor(Date.now() / 1000) + 60 }, privateKey);
  const req = new Request('https://x/', { headers: { 'cf-access-jwt-assertion': token } });
  await assert.rejects(
    () => verifyAccessJwt(req, { ACCESS_TEAM_DOMAIN: 't', ACCESS_AUD: 'expected' }, { getCertKeys: async () => new Map([['test-kid', cryptoKey]]) }),
    (e) => e.code === 'ACCESS_DENIED',
  );
});

test('loadKeysFromCertsJson importa certificado PEM (openssl)', async () => {
  const { execSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'influ-cert-'));
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${join(dir, 'k.pem')} -out ${join(dir, 'c.pem')} -days 1 -subj /CN=test`,
      { stdio: 'pipe' },
    );
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const keys = await loadKeysFromCertsJson({ public_certs: [{ kid: 'kid1', cert }] });
    assert.equal(keys.size, 1);
    assert.ok(keys.has('kid1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  resetAccessJwtCertCache();
});

test('parseJwt rechaza token truncado', () => {
  assert.equal(parseJwt('a.b'), null);
});