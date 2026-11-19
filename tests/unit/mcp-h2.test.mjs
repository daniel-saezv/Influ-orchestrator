import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim } from '../helpers/r2-shim.mjs';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import workerMod, { setAccessJwtDeps } from '../../src/worker.js';
import { MCP_TOOL_NAMES } from '../../src/adapters/mcp/influ-mcp.js';
import { setEncargoWebhookTransport } from '../../src/adapters/http/encargo-webhook.js';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUD = 'aud-mcp-h2';
const MCP_AUD = 'aud-mcp-conector-h2';
const MCP_CLIENT_ID = 'mcp-conector-h2.access';
const MCP_TOKEN = 'local-test-mcp-bearer-0123456789abcd';
const signer = createAccessSigner();
const accessKey = await cryptoKeyFromPublic(signer.publicKey);
setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', accessKey]]) });

const FORBIDDEN = ['aprobar', 'publicar', 'approve', 'publish', 'decision', 'decidir'];

function env(extra = {}) {
  return {
    DB: createD1Shim(join(ROOT, 'migrations')),
    MEDIA: createKvShim(),
    MEDIA_R2: createR2Shim(),
    BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef',
    APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
    PUBLISHER_MODE: 'mock',
    PUBLISHER_PROVIDER: 'youtube',
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: AUD,
    ACCESS_MCP_AUD: MCP_AUD,
    MCP_SERVICE_TOKEN_CLIENT_ID: MCP_CLIENT_ID,
    MCP_BEARER_TOKEN: MCP_TOKEN,
    ...extra,
  };
}

function serviceJwt(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signer.sign({
    aud: MCP_AUD,
    exp: now + 3600,
    nbf: now - 30,
    iss: 'https://team.example.com',
    common_name: MCP_CLIENT_ID,
    sub: '',
    type: 'app',
    ...overrides,
  });
}

function mcpRequest(token, body, jwt = serviceJwt()) {
  return new Request('https://local.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'cf-access-client-secret': 'no-debe-registrarse-ni-reenviarse',
      ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readRpc(res) {
  const text = await res.text();
  const dataLines = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean);
  if (dataLines.length) return dataLines.map((line) => JSON.parse(line));
  return [JSON.parse(text)];
}

async function rpc(dbEnv, token, method, params, id = 1) {
  const res = await workerMod.fetch(mcpRequest(token, { jsonrpc: '2.0', id, method, params }), dbEnv, { waitUntil() {} });
  const messages = res.status === 200 ? await readRpc(res) : null;
  return { status: res.status, messages, raw: messages ? null : await res.clone().json().catch(() => null) };
}

test('MCP exige el JWT del conector y el bearer; si falta la config no ejecuta', async () => {
  const dbEnv = env();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = signer.sign({ aud: AUD, exp, email: 'ana@example.com', iss: 'https://team.example.com', nbf: exp - 60 });
  const otherName = serviceJwt({ common_name: 'cli-bot.access' });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const missingJwt = await workerMod.fetch(mcpRequest(MCP_TOKEN, ping, null), dbEnv, { waitUntil() {} });
  const missingJwtBody = await missingJwt.json();
  assert.equal(missingJwt.status, 401);
  assert.equal(missingJwtBody.error.code, 'UNAUTHENTICATED');
  assert.equal(JSON.stringify(missingJwtBody).includes('no-debe-registrarse'), false);

  const uiAud = await workerMod.fetch(mcpRequest(MCP_TOKEN, ping, person), dbEnv, { waitUntil() {} });
  assert.equal(uiAud.status, 401);
  assert.equal((await uiAud.json()).error.code, 'UNAUTHENTICATED');

  const wrongName = await workerMod.fetch(mcpRequest(MCP_TOKEN, ping, otherName), dbEnv, { waitUntil() {} });
  assert.equal(wrongName.status, 401);

  const missingBearer = await workerMod.fetch(mcpRequest(null, ping), dbEnv, { waitUntil() {} });
  assert.equal(missingBearer.status, 401);
  assert.equal((await missingBearer.json()).error.code, 'UNAUTHENTICATED');

  const wrong = await workerMod.fetch(mcpRequest('otra-clave-que-no-es-la-buena', ping), dbEnv, { waitUntil() {} });
  assert.equal(wrong.status, 401);

  const unset = env({ MCP_BEARER_TOKEN: undefined });
  const open = await workerMod.fetch(mcpRequest(MCP_TOKEN, ping), unset, { waitUntil() {} });
  assert.equal(open.status, 401);

  for (const partial of [
    { ACCESS_MCP_AUD: '' },
    { MCP_SERVICE_TOKEN_CLIENT_ID: '' },
    { ACCESS_TEAM_DOMAIN: '' },
  ]) {
    const closed = await workerMod.fetch(mcpRequest(MCP_TOKEN, ping), env(partial), { waitUntil() {} });
    const closedBody = await closed.json();
    assert.equal(closed.status, 503, JSON.stringify(partial));
    assert.equal(closedBody.error.code, 'SERVER_MISCONFIGURED');
    assert.equal(closedBody.result, undefined);
  }
});

test('MCP con bearer: herramientas de la cola y ninguna de aprobar o publicar', async () => {
  const dbEnv = env();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = signer.sign({ aud: AUD, exp, email: 'ana@example.com' });
  const guide = await workerMod.fetch(new Request('https://local.test/v1/me', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
    body: JSON.stringify({ display_name: 'Ana', time_zone: 'Europe/Madrid' }),
  }), dbEnv);
  const guideBody = await guide.json();
  assert.equal(guide.status, 200);
  const accountId = guideBody.data.accounts[0].account_id;
  const created = await workerMod.fetch(new Request('https://local.test/v1/me/encargos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
    body: JSON.stringify({ account_id: accountId, kind: 'from_scratch', note: 'un plano del puerto', platforms: ['youtube'] }),
  }), dbEnv);
  const createdBody = await created.json();
  assert.equal(createdBody.data.status, 'queued');
  const encargoId = createdBody.data.encargo_id;

  const init = await rpc(dbEnv, MCP_TOKEN, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'influ-test', version: '0' },
  });
  assert.equal(init.status, 200, JSON.stringify(init.messages ?? init.raw));

  const listed = await rpc(dbEnv, MCP_TOKEN, 'tools/list', {});
  assert.equal(listed.status, 200, JSON.stringify(listed.messages ?? listed.raw));
  const tools = listed.messages.flatMap((message) => message.result?.tools ?? []);
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());
  for (const name of names) {
    assert.equal(FORBIDDEN.some((word) => name.includes(word)), false, name);
  }
  const described = tools.map((tool) => `${tool.name} ${tool.description ?? ''}`).join('\n');
  for (const word of ['aprobar', 'publicar']) assert.equal(described.includes(word), false, described);

  for (const name of ['aprobar', 'publicar', 'approve_batch', 'decidir_encargo']) {
    const call = await rpc(dbEnv, MCP_TOKEN, 'tools/call', { name, arguments: { encargo_id: encargoId } });
    const text = JSON.stringify(call.messages);
    assert.equal(text.includes('APPROVED'), false, text);
    assert.equal(text.includes('"status":"approved"'), false, text);
  }

  const claim = await rpc(dbEnv, MCP_TOKEN, 'tools/call', {
    name: 'reclamar_encargo',
    arguments: { encargo_id: encargoId },
  });
  const claimText = claim.messages.flatMap((message) => message.result?.content ?? []).map((part) => part.text).join('');
  assert.equal(JSON.parse(claimText).status, 'claimed');

  const origin = await rpc(dbEnv, MCP_TOKEN, 'tools/call', {
    name: 'leer_origen',
    arguments: { encargo_id: encargoId },
  });
  const originBody = JSON.parse(origin.messages.flatMap((message) => message.result?.content ?? []).map((part) => part.text).join(''));
  assert.equal(originBody.note, 'un plano del puerto');
  assert.equal(originBody.assets.length, 0);
  assert.equal(JSON.stringify(originBody).includes('ana@example.com'), false);

  const hash = 'ab'.repeat(32);
  const uploaded = await rpc(dbEnv, MCP_TOKEN, 'tools/call', {
    name: 'subir_resultado',
    arguments: { encargo_id: encargoId, synthetic: true, content_hash: hash },
  });
  const uploadedBody = JSON.parse(uploaded.messages.flatMap((message) => message.result?.content ?? []).map((part) => part.text).join(''));
  assert.equal(uploadedBody.status, 'ready');

  const status = await rpc(dbEnv, MCP_TOKEN, 'tools/call', {
    name: 'revisar_estado',
    arguments: { encargo_id: encargoId },
  });
  const statusBody = JSON.parse(status.messages.flatMap((message) => message.result?.content ?? []).map((part) => part.text).join(''));
  assert.equal(statusBody.status, 'ready');
  assert.notEqual(statusBody.status, 'approved');
});

test('webhook ausente no llama y un webhook que falla no bloquea la cola', async () => {
  const calls = [];
  setEncargoWebhookTransport(async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, body: init.body });
    throw new Error('red caída');
  });
  try {
    const quiet = env();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const person = signer.sign({ aud: AUD, exp, email: 'ana@example.com' });
    const post = (dbEnv, body) => workerMod.fetch(new Request('https://local.test/v1/me/encargos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
      body: JSON.stringify(body),
    }), dbEnv);
    const guide = await workerMod.fetch(new Request('https://local.test/v1/me', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
      body: JSON.stringify({ display_name: 'Ana', time_zone: 'Europe/Madrid' }),
    }), quiet);
    const accountId = (await guide.json()).data.accounts[0].account_id;
    const absent = await post(quiet, { account_id: accountId, kind: 'from_scratch', note: 'sin webhook', platforms: ['youtube'] });
    const absentBody = await absent.json();
    assert.equal(absent.status, 200);
    assert.equal(absentBody.data.status, 'queued');
    assert.equal(calls.length, 0);

    const failing = env({
      INFLU_WEBHOOK_URL: 'https://influ-webhook.test/rutina',
      INFLU_WEBHOOK_SECRET: 'clave-de-rutina-de-prueba-012345',
    });
    const guide2 = await workerMod.fetch(new Request('https://local.test/v1/me', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
      body: JSON.stringify({ display_name: 'Ana', time_zone: 'Europe/Madrid' }),
    }), failing);
    const account2 = (await guide2.json()).data.accounts[0].account_id;
    const blocked = await post(failing, { account_id: account2, kind: 'from_scratch', note: 'webhook caído', platforms: ['instagram'] });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 200);
    assert.equal(blockedBody.data.status, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, 'Bearer clave-de-rutina-de-prueba-012345');
    assert.equal(JSON.parse(calls[0].body).event, 'encargo.queued');
    assert.equal(JSON.parse(calls[0].body).encargo_id, blockedBody.data.encargo_id);

    const repo = new D1Repository(failing.DB);
    const queued = await repo.listQueuedEncargos();
    assert.equal(queued.some((row) => row.encargo_id === blockedBody.data.encargo_id), true);
  } finally {
    setEncargoWebhookTransport(null);
  }
});

test('la revisión de respaldo registra la cola una vez al día y no reclama', async () => {
  const dbEnv = env();
  const repo = new D1Repository(dbEnv.DB);
  const logs = [];
  const original = console.info;
  console.info = (...args) => { logs.push(args.join(' ')); };
  try {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const person = signer.sign({ aud: AUD, exp, email: 'ana@example.com' });
    await workerMod.fetch(new Request('https://local.test/v1/me', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
      body: JSON.stringify({ display_name: 'Ana', time_zone: 'Europe/Madrid' }),
    }), dbEnv);
    const me = await (await workerMod.fetch(new Request('https://local.test/v1/me', {
      headers: { 'cf-access-jwt-assertion': person },
    }), dbEnv)).json();
    const created = await (await workerMod.fetch(new Request('https://local.test/v1/me/encargos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': person },
      body: JSON.stringify({
        account_id: me.data.accounts[0].account_id, kind: 'from_scratch', note: 'en cola', platforms: ['tiktok'],
      }),
    }), dbEnv)).json();

    const run = async (iso) => {
      let job;
      await workerMod.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(iso) }, dbEnv, {
        waitUntil(promise) { job = promise; },
      });
      await job;
    };
    logs.length = 0;
    await run('2026-11-19T00:00:00.000Z');
    await run('2026-11-19T00:15:00.000Z');
    const reviews = logs.filter((line) => line.includes('encargo_backup_review'));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].includes(created.data.encargo_id), true);
    assert.equal(reviews[0].includes('en cola'), false);
    const still = await repo.encargoById(created.data.encargo_id);
    assert.equal(still.status, 'queued');

    await run('2026-11-20T03:00:00.000Z');
    assert.equal(logs.filter((line) => line.includes('encargo_backup_review')).length, 2);
  } finally {
    console.info = original;
  }
});
