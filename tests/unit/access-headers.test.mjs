import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessHeadersFromEnv } from '../../bot/access-headers.mjs';
import { OrchestratorClient } from '../../bot/client-lib.mjs';

test('accessHeadersFromEnv: vacío si faltan variables', () => {
  assert.deepEqual(accessHeadersFromEnv({}), {});
  assert.deepEqual(accessHeadersFromEnv({ INFLU_CF_ACCESS_CLIENT_ID: 'id' }), {});
});

test('accessHeadersFromEnv: envía cabeceras CF cuando existen ambas', () => {
  const h = accessHeadersFromEnv({
    INFLU_CF_ACCESS_CLIENT_ID: 'cid.test',
    INFLU_CF_ACCESS_CLIENT_SECRET: 'csecret.test',
  });
  assert.equal(h['CF-Access-Client-Id'], 'cid.test');
  assert.equal(h['CF-Access-Client-Secret'], 'csecret.test');
});

test('OrchestratorClient incluye cabeceras Access en cada petición', async () => {
  let seen;
  const client = new OrchestratorClient({
    baseUrl: 'https://example.test',
    botSecret: 'local-test-bot-secret-0123456789abcdef',
    approverSecret: 'local-test-approver-secret-0123456789ab',
    accessHeaders: { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b' },
    transport: async (_url, init) => {
      seen = init.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.health();
  assert.equal(seen['CF-Access-Client-Id'], 'a');
  assert.equal(seen['CF-Access-Client-Secret'], 'b');
});