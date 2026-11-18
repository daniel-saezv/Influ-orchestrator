import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  verifyAccessJwt,
  parseJwt,
  loadKeysFromCertsJson,
  resetAccessJwtCertCache,
  accessJwtEnabled,
} from '../../src/adapters/http/access-jwt.js';

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

test('verifyAccessJwt: no hace nada si vars Access ausentes', async () => {
  const req = new Request('https://x/v1/health');
  assert.equal(await verifyAccessJwt(req, {}), null);
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