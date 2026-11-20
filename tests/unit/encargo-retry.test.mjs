import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorClient } from '../../bot/client-lib.mjs';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { R2ObjectStore } from '../../src/adapters/storage/r2-object-store.js';
import { createR2Signer } from '../../src/adapters/storage/r2-presign.js';
import { claimEncargo } from '../../src/workflows/encargos.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim } from '../helpers/r2-shim.mjs';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import workerMod, { setAccessJwtDeps } from '../../src/worker.js';

const signer = createAccessSigner();
const accessKey = await cryptoKeyFromPublic(signer.publicKey);
setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', accessKey]]) });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUD = 'aud-retry';
const r2Signer = createR2Signer({
  accessKeyId: 'r2-signing-test-access',
  secretAccessKey: 'r2-signing-test-secret',
  accountId: 'f39f0d032bd902adf6dc9b5ed251f4ee',
  bucket: 'influ-poc-media',
});

function shaHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function harness() {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const r2 = createR2Shim();
  const env = {
    DB: shim,
    MEDIA: createKvShim(),
    MEDIA_R2: r2,
    BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef',
    APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
    PUBLISHER_MODE: 'mock',
    PUBLISHER_PROVIDER: 'youtube',
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: AUD,
    RATE_LIMIT_USER_PER_MINUTE: '600',
  };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = (email) => signer.sign({ aud: AUD, exp, email });
  const service = signer.sign({ aud: AUD, exp, common_name: 'bot-retry', type: 'app' });
  const call = (method, path, email, { json, raw, headers } = {}) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: {
      'cf-access-jwt-assertion': person(email),
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(raw ? { 'content-length': String(raw.byteLength) } : {}),
      ...(headers ?? {}),
    },
    body: json ? JSON.stringify(json) : raw,
  }), env);
  const read = async (res) => ({ status: res.status, ...(await res.json()) });
  const bot = new OrchestratorClient({
    baseUrl: 'https://local.test',
    botSecret: env.BOT_HMAC_SECRET,
    approverSecret: env.APPROVER_HMAC_SECRET,
    accessHeaders: { 'cf-access-jwt-assertion': service },
    transport: (url, init) => workerMod.fetch(new Request(url, init), env),
  });
  return { shim, r2, env, call, read, bot };
}

async function guide(h, email) {
  const saved = await h.read(await h.call('POST', '/v1/me', email, { json: { display_name: 'Ana', time_zone: 'Europe/Madrid' } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.error));
  return saved.data.accounts[0].account_id;
}

async function queuedEdit(h, email, bytes) {
  const accountId = await guide(h, email);
  const created = await h.read(await h.call('POST', '/v1/me/encargos', email, {
    json: {
      account_id: accountId,
      kind: 'edit',
      note: 'recorta el final',
      format: 'short_video',
      targets: [{ platform: 'youtube', target: 'short' }],
    },
  }));
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: created.data.encargo_id, size_bytes: bytes.byteLength, mime: 'video/mp4', sha256: digest },
  }));
  assert.equal(opened.status, 201, JSON.stringify(opened.error));
  const put = await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes,
    headers: { 'content-type': 'video/mp4', 'x-content-sha256': digest },
  }));
  assert.equal(put.status, 200, JSON.stringify(put.error));
  const done = await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  assert.equal(done.data.status, 'queued');
  return { email, accountId, encargoId: created.data.encargo_id, digest };
}

test('reintentar reencola el encargo fallido con el mismo origen verificado', async () => {
  const h = harness();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const edit = await queuedEdit(h, 'ana@example.com', bytes);
  const accountId = edit.accountId;
  const scratch = await h.read(await h.call('POST', '/v1/me/encargos', edit.email, {
    json: {
      account_id: accountId,
      kind: 'from_scratch',
      note: 'una idea',
      format: 'short_video',
      targets: [{ platform: 'instagram', target: 'reel' }],
    },
  }));
  assert.equal(scratch.data.status, 'queued');

  const tooSoon = await h.read(await h.call('POST', `/v1/me/encargos/${edit.encargoId}/retry`, edit.email));
  assert.equal(tooSoon.status, 409);
  assert.equal(tooSoon.error.code, 'CONFLICT');

  const claimedEdit = await h.bot.claimEncargo(edit.encargoId);
  assert.equal(claimedEdit.status, 200);
  const failedEdit = await h.bot.submitEncargoResult(edit.encargoId, {
    failed: true,
    error: { code: 'GENERATION_FAILED' },
    file_sha256: edit.digest,
  });
  assert.equal(failedEdit.status, 409);
  assert.equal(failedEdit.error.details.status, 'failed');

  const foreign = await h.read(await h.call('POST', `/v1/me/encargos/${edit.encargoId}/retry`, 'otra@example.com'));
  assert.equal(foreign.status, 404);

  const retried = await h.read(await h.call('POST', `/v1/me/encargos/${edit.encargoId}/retry`, edit.email));
  assert.equal(retried.status, 200, JSON.stringify(retried.error));
  assert.equal(retried.data.status, 'queued');
  assert.equal(retried.data.kind, 'edit');
  assert.equal(retried.data.note, 'recorta el final');
  assert.equal(retried.data.format, 'short_video');
  assert.equal(JSON.stringify(retried.data).includes('http'), false);

  const again = await h.read(await h.call('POST', `/v1/me/encargos/${edit.encargoId}/retry`, edit.email));
  assert.equal(again.status, 409);

  const queued = await h.bot.getQueuedEncargos();
  const row = queued.data.encargos.find((item) => item.encargo_id === edit.encargoId);
  assert.equal(row.file_sha256, edit.digest);
  assert.equal(row.assets.length, 1);
  assert.equal(row.assets[0].sha256, edit.digest);
  assert.equal(row.assets[0].r2_key, claimedEdit.data.encargo.assets[0].r2_key);

  const origin = await claimEncargo(new D1Repository(h.shim), {
    encargoId: edit.encargoId,
    now: new Date().toISOString(),
    withOrigin: true,
    r2: new R2ObjectStore(h.r2),
    signer: r2Signer,
    actor: 'mcp',
  });
  assert.equal(origin.status, 'claimed');
  assert.equal(origin.origin.assets.length, 1);
  assert.equal(origin.origin.assets[0].sha256, edit.digest);
  assert.equal(origin.origin.assets[0].matches, true);
  assert.equal(origin.origin.file_sha256, edit.digest);
  assert.equal(typeof origin.origin.assets[0].url, 'string');
  const safeAssets = origin.origin.assets.map(({ url, expires_at, ...rest }) => rest);
  assert.equal(JSON.stringify(safeAssets).includes('http'), false);

  const audit = await new D1Repository(h.shim).listAudit();
  const retriedRow = audit.map((item) => ({ ...item, detail: JSON.parse(item.detail_json) }))
    .find((item) => item.action === 'ENCARGO_RETRIED' && item.detail.encargo_id === edit.encargoId);
  assert.equal(retriedRow.detail.assets, 1);
  assert.equal(retriedRow.detail.account_id, accountId);
  assert.equal(JSON.stringify(retriedRow.detail).includes('http'), false);

  const claimedScratch = await h.bot.claimEncargo(scratch.data.encargo_id);
  assert.equal(claimedScratch.status, 200);
  const failedScratch = await h.bot.submitEncargoResult(scratch.data.encargo_id, {
    failed: true,
    error: { code: 'GENERATION_FAILED' },
  });
  assert.equal(failedScratch.error.details.status, 'failed');
  const retriedScratch = await h.read(await h.call('POST', `/v1/me/encargos/${scratch.data.encargo_id}/retry`, edit.email));
  assert.equal(retriedScratch.status, 200, JSON.stringify(retriedScratch.error));
  assert.equal(retriedScratch.data.kind, 'from_scratch');
  assert.equal(retriedScratch.data.note, 'una idea');
  const back = await h.bot.getQueuedEncargos();
  const scratchRow = back.data.encargos.find((item) => item.encargo_id === scratch.data.encargo_id);
  assert.equal(scratchRow.assets.length, 0);
  assert.equal(scratchRow.note, 'una idea');
});

test('un origen que no cuadra no se reencola', async () => {
  const h = harness();
  const bytes = new Uint8Array([9, 9, 9, 9]);
  const edit = await queuedEdit(h, 'ana@example.com', bytes);
  const claimed = await h.bot.claimEncargo(edit.encargoId);
  assert.equal(claimed.status, 200);
  const failed = await h.bot.submitEncargoResult(edit.encargoId, {
    failed: true,
    error: { code: 'GENERATION_FAILED' },
    file_sha256: edit.digest,
  });
  assert.equal(failed.error.details.status, 'failed');
  const stored = h.r2.objects.get(claimed.data.encargo.assets[0].r2_key);
  const fake = Buffer.alloc(32, 3);
  stored.checksums.sha256 = fake.buffer.slice(fake.byteOffset, fake.byteOffset + fake.byteLength);
  const retry = await h.read(await h.call('POST', `/v1/me/encargos/${edit.encargoId}/retry`, edit.email));
  assert.equal(retry.status, 409);
  assert.equal(retry.error.code, 'INTEGRITY_PART_MISMATCH');
  const still = await h.read(await h.call('GET', `/v1/me/encargos/${edit.encargoId}`, edit.email));
  assert.equal(still.data.status, 'failed');
  const queued = await h.bot.getQueuedEncargos();
  assert.equal(queued.data.encargos.some((item) => item.encargo_id === edit.encargoId), false);
});
