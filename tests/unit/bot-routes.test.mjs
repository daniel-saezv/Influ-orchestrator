import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorClient, pollEncargoOnce, sign } from '../../bot/client-lib.mjs';
import { R2ObjectStore } from '../../src/adapters/storage/r2-object-store.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim, seedObject } from '../helpers/r2-shim.mjs';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { MAX_GLOBAL_BYTES, MAX_USER_BYTES } from '../../src/core/domain/r2-quota.js';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import workerMod, { setAccessJwtDeps } from '../../src/worker.js';

const signer = createAccessSigner();
const accessKey = await cryptoKeyFromPublic(signer.publicKey);
setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', accessKey]]) });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUD = 'aud-bot-rutas';
const HASH = 'ab'.repeat(32);

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
  const service = signer.sign({ aud: AUD, exp, common_name: 'bot-rutas', type: 'app' });
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
  return { shim, r2, env, call, read, bot, person };
}

async function queuedEdit(h, email, bytes) {
  const guide = await h.read(await h.call('POST', '/v1/me', email, { json: { display_name: 'Ana', time_zone: 'Europe/Madrid' } }));
  assert.equal(guide.status, 200, JSON.stringify(guide.error));
  const created = await h.read(await h.call('POST', '/v1/me/encargos', email, {
    json: { account_id: guide.data.accounts[0].account_id, kind: 'edit', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] },
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
  return {
    email,
    encargoId: created.data.encargo_id,
    accountId: guide.data.accounts[0].account_id,
    digest,
  };
}

test('rutas HMAC del bot: firma inválida, reclamo doble y hash que no cuadra', async () => {
  const h = harness();
  const firstBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const secondBytes = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
  const thirdBytes = new Uint8Array([9, 9, 9, 9]);
  const fourthBytes = new Uint8Array([4, 4, 4, 4]);
  const first = await queuedEdit(h, 'ana@example.com', firstBytes);
  const second = await queuedEdit(h, 'ana@example.com', secondBytes);

  const unsigned = await h.bot.call('GET', '/v1/encargos?status=queued', {
    signOverride: sign({
      secret: 'x'.repeat(40), keyId: 'bot', method: 'GET', pathAndQuery: '/v1/encargos?status=queued',
    }),
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.error.code, 'UNAUTHENTICATED');

  const queued = await h.bot.getQueuedEncargos();
  assert.equal(queued.status, 200);
  const mine = queued.data.encargos.find((row) => row.encargo_id === first.encargoId);
  const other = queued.data.encargos.find((row) => row.encargo_id === second.encargoId);
  assert.equal(mine.file_sha256, first.digest);
  assert.equal(mine.assets.length, 1);
  assert.equal(other.assets.length, 1);
  assert.equal(mine.assets[0].r2_key === other.assets[0].r2_key, false);
  assert.equal(JSON.stringify(queued.data).includes('ana@example.com'), false);
  assert.equal(JSON.stringify(queued.data).includes('ciphertext'), false);

  const claim = await h.bot.claimEncargo(first.encargoId);
  assert.equal(claim.status, 200);
  assert.equal(claim.data.status, 'claimed');
  assert.equal(claim.data.encargo.file_sha256, first.digest);
  assert.equal(claim.data.encargo.assets[0].sha256, first.digest);

  const again = await h.bot.claimEncargo(first.encargoId);
  assert.equal(again.status, 409);
  assert.equal(again.error.code, 'CONFLICT');
  const still = await h.read(await h.call('GET', `/v1/me/encargos/${first.encargoId}`, first.email));
  assert.equal(still.data.status, 'claimed');

  const mismatch = await h.bot.submitEncargoResult(first.encargoId, {
    synthetic: false, content_hash: HASH, file_sha256: 'cd'.repeat(32),
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.error.code, 'INTEGRITY_FILE_MISMATCH');
  assert.equal(mismatch.error.details.status, 'failed');
  const failed = await h.read(await h.call('GET', `/v1/me/encargos/${first.encargoId}`, first.email));
  assert.equal(failed.data.status, 'failed');

  const heads = h.shim._raw.prepare("SELECT COALESCE(SUM(class_b), 0) AS n FROM r2_daily WHERE scope = 'global'").get();
  assert.equal(Number(heads.n) >= 1, true);

  const claimOther = await h.bot.claimEncargo(second.encargoId);
  assert.equal(claimOther.status, 200);
  const stored = h.r2.objects.get(claimOther.data.encargo.assets[0].r2_key);
  const fake = Buffer.alloc(32, 3);
  stored.checksums.sha256 = fake.buffer.slice(fake.byteOffset, fake.byteOffset + fake.byteLength);
  const part = await h.bot.submitEncargoResult(second.encargoId, {
    synthetic: false, content_hash: HASH, file_sha256: second.digest,
  });
  assert.equal(part.status, 409);
  assert.equal(part.error.code, 'INTEGRITY_PART_MISMATCH');
  const failedPart = await h.read(await h.call('GET', `/v1/me/encargos/${second.encargoId}`, second.email));
  assert.equal(failedPart.data.status, 'failed');

  const third = await queuedEdit(h, 'ana@example.com', thirdBytes);
  const claimOk = await h.bot.claimEncargo(third.encargoId);
  assert.equal(claimOk.status, 200);
  const freePiece = await h.bot.submitEncargoResult(third.encargoId, {
    synthetic: false, content_hash: HASH, file_sha256: third.digest,
    deliverable: { r2_key: 'out/pieza-ok', sha256: third.digest, mime: 'video/mp4', size_bytes: thirdBytes.byteLength },
  });
  assert.equal(freePiece.status, 400);
  assert.equal(freePiece.error.code, 'INVALID_INPUT');
  const stillClaimed = await h.read(await h.call('GET', `/v1/me/encargos/${third.encargoId}`, third.email));
  assert.equal(stillClaimed.data.status, 'claimed');
  const repo = new D1Repository(h.shim);
  const owner = await repo.userByEmail(third.email);
  const pieceKey = `out/${third.encargoId}/1/${crypto.randomUUID()}`;
  const seeded = seedObject(h.r2, pieceKey, thirdBytes, { contentType: 'video/mp4' });
  const stagedAt = new Date().toISOString();
  await repo.reserveBytes(owner.user_id, thirdBytes.byteLength, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  await repo.insertDeliverableReservation({
    reservationId: crypto.randomUUID(), encargoId: third.encargoId, userId: owner.user_id, r2Key: pieceKey,
    version: 1, sha256: third.digest, contentMd5: seeded.md5, mime: 'video/mp4', sizeBytes: thirdBytes.byteLength,
    bytesHeld: thirdBytes.byteLength, classAHeld: 0, quotaDay: stagedAt.slice(0, 10),
    expiresAt: new Date(Date.now() + 600_000).toISOString(), now: stagedAt,
  });
  const ready = await h.bot.submitEncargoResult(third.encargoId, {
    synthetic: false, content_hash: HASH, file_sha256: third.digest,
    deliverable: { r2_key: pieceKey },
  });
  assert.equal(ready.status, 200, JSON.stringify(ready.error));
  assert.equal(ready.data.status, 'ready');
  assert.equal(ready.data.synthetic, false);

  const audit = await h.bot.audit();
  const rows = audit.data.audit.map((row) => ({ ...row, detail: JSON.parse(row.detail_json) }));
  const claimedRow = rows.find((row) => row.action === 'ENCARGO_CLAIMED' && row.detail.encargo_id === third.encargoId);
  const readyRow = rows.find((row) => row.action === 'ENCARGO_RESULT' && row.detail.encargo_id === third.encargoId);
  const failedRow = rows.find((row) => row.action === 'ENCARGO_FAILED' && row.detail.encargo_id === first.encargoId);
  assert.equal(claimedRow.detail.account_id, third.accountId);
  assert.equal(readyRow.detail.synthetic, false);
  assert.equal(readyRow.detail.account_id, third.accountId);
  assert.equal(failedRow.detail.code, 'INTEGRITY_FILE_MISMATCH');
  assert.equal(failedRow.detail.account_id, first.accountId);

  const fourth = await queuedEdit(h, 'ana@example.com', fourthBytes);
  let generated = 0;
  const store = new R2ObjectStore(h.r2);
  const polled = await pollEncargoOnce(h.bot, {
    head: (key) => store.head(key),
    get: async () => new Uint8Array([1, 1, 1, 1]),
    generate: async () => { generated += 1; return { content_hash: HASH }; },
  });
  assert.equal(polled.ok, false);
  assert.equal(polled.phase, 'integrity');
  assert.equal(generated, 0);
  const polledRow = await h.read(await h.call('GET', `/v1/me/encargos/${fourth.encargoId}`, fourth.email));
  assert.equal(polledRow.data.status, 'failed');

  const empty = await pollEncargoOnce(h.bot, { generate: async () => ({ content_hash: HASH }) });
  assert.equal(empty.generated, false);
  assert.equal(empty.ok, true);
});
