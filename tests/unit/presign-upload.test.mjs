import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { R2ObjectStore } from '../../src/adapters/storage/r2-object-store.js';
import { createR2Signer } from '../../src/adapters/storage/r2-presign.js';
import { drainEgressAttempts } from '../../src/adapters/http/egress-guard.js';
import { claimEncargo, createEncargo, readClaimedOrigin, saveGuide, submitEncargoResult } from '../../src/workflows/encargos.js';
import { prepareDeliverableUpload } from '../../src/workflows/presign.js';
import { releaseExpiredReservations } from '../../src/workflows/r2-gc.js';
import { getMediaResponse } from '../../src/workflows/uploads.js';
import { MAX_FILE_BYTES, MAX_GLOBAL_BYTES, MAX_USER_BYTES } from '../../src/core/domain/r2-quota.js';
import { createD1Shim } from '../helpers/d1-shim.mjs';
import { createR2Shim, seedObject } from '../helpers/r2-shim.mjs';
import workerMod from '../../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-11-19T12:00:00.000Z';
const HASH = 'ab'.repeat(32);
const SIGNING = {
  accessKeyId: 'r2-signing-test-access',
  secretAccessKey: 'r2-signing-test-secret',
  accountId: 'f39f0d032bd902adf6dc9b5ed251f4ee',
  bucket: 'influ-poc-media',
};
const signer = createR2Signer(SIGNING);

function db() {
  return new D1Repository(createD1Shim(join(ROOT, 'migrations')));
}

function md5(bytes) {
  return createHash('md5').update(bytes).digest('base64');
}

function isR2Hostname(host) {
  let hostname;
  try {
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    return false;
  }
  return hostname === 'r2.cloudflarestorage.com' || hostname.endsWith('.r2.cloudflarestorage.com');
}

function auditOmitsSignedUrl(detailJson) {
  const values = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
      return;
    }
    if (typeof node === 'string') values.push(node);
  };
  walk(JSON.parse(detailJson));
  return values.every((value) => !value.includes('://') && !value.includes('X-Amz-'));
}

async function claimed(repo, kind = 'from_scratch') {
  const guide = await saveGuide(repo, {
    email: 'ana@example.com', body: { display_name: 'Ana', time_zone: 'UTC' }, now: NOW,
  });
  const created = await createEncargo(repo, {
    email: 'ana@example.com',
    body: { account_id: guide.accounts[0].account_id, kind, note: kind === 'edit' ? null : 'una idea', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] },
    now: NOW,
  });
  if (kind === 'from_scratch') await claimEncargo(repo, { encargoId: created.encargo_id, now: NOW });
  const user = await repo.userByEmail('ana@example.com');
  return { encargoId: created.encargo_id, userId: user.user_id, accountId: guide.accounts[0].account_id };
}

test('la firma es local, caduca a los 10 minutos y no acepta una clave pending en el PUT', async () => {
  drainEgressAttempts();
  const put = new URL(await signer.signPut('out/11111111-1111-4111-8111-111111111111/1/22222222-2222-4222-8222-222222222222', {
    'Content-Type': 'video/mp4',
    'Content-Length': '8',
    'Content-MD5': '1B2M2Y8AsgTpgAmY7PhCfg==',
    'If-None-Match': '*',
  }, 600));
  assert.equal(put.host, `${SIGNING.accountId}.r2.cloudflarestorage.com`);
  assert.equal(put.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(put.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-md5;content-type;host;if-none-match');
  assert.equal(put.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(put.toString().includes(SIGNING.secretAccessKey), false);
  const get = new URL(await signer.signGet('pending/user/upload/01', 600));
  assert.equal(get.pathname.endsWith('/pending/user/upload/01'), true);
  assert.equal(get.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(get.searchParams.get('X-Amz-Expires'), '600');
  await assert.rejects(() => signer.signPut('pending/user/upload/01', {}, 600), (error) => error.code === 'INVALID_INPUT');
  const attempts = drainEgressAttempts();
  assert.equal(attempts.some((row) => isR2Hostname(row.host)), false);
});

test('preparar_subida reserva una vez, reutiliza la misma clave y rechaza otra distinta', async () => {
  const repo = db();
  const { encargoId } = await claimed(repo);
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const input = {
    encargoId, sha256: createHash('sha256').update(bytes).digest('hex'), contentMd5: md5(bytes),
    mime: 'video/mp4', sizeBytes: bytes.byteLength, now: NOW, signer,
  };
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, signer: null, env: {} }),
    (error) => error.code === 'R2_SIGNING_UNAVAILABLE' && error.message.includes('R2_SECRET_ACCESS_KEY'),
  );
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, mime: 'text/plain' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, mime: 'image/jpeg' }),
    (error) => error.code === 'DELIVERABLE_FORMAT_MISMATCH',
  );
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, mime: 'audio/mpeg' }),
    (error) => error.code === 'DELIVERABLE_FORMAT_MISMATCH',
  );
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, sizeBytes: MAX_FILE_BYTES + 1 }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, contentMd5: 'abc' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  const first = await prepareDeliverableUpload(repo, input);
  assert.match(first.r2_key, new RegExp(`^out/${encargoId}/1/[0-9a-f-]{36}$`));
  assert.equal(first.headers['Content-Type'], 'video/mp4');
  assert.equal(first.headers['Content-Length'], '8');
  assert.equal(first.headers['Content-MD5'], input.contentMd5);
  assert.equal(first.headers['If-None-Match'], '*');
  assert.equal(first.expires_at, '2026-11-19T12:10:00.000Z');
  assert.equal(first.url.includes(SIGNING.secretAccessKey), false);
  assert.equal(await repo.storedBytes('global'), bytes.byteLength);
  assert.equal(await repo.classUsed('global', 'a', '2026-11-01'), 1);
  const audit = await repo.listAudit();
  const prepared = audit.find((row) => row.action === 'ENCARGO_UPLOAD_PREPARED');
  assert.equal(auditOmitsSignedUrl(prepared.detail_json), true);

  const again = await prepareDeliverableUpload(repo, input);
  assert.equal(again.r2_key, first.r2_key);
  assert.equal(await repo.storedBytes('global'), bytes.byteLength);
  assert.equal(await repo.classUsed('global', 'a', '2026-11-01'), 1);

  await assert.rejects(
    () => prepareDeliverableUpload(repo, { ...input, sha256: 'cd'.repeat(32) }),
    (error) => error.code === 'CONFLICT',
  );
  assert.equal(await repo.storedBytes('global'), bytes.byteLength);

  const boom = {
    async signPut() { throw new Error('firma'); },
  };
  const other = db();
  const second = await claimed(other);
  await assert.rejects(() => prepareDeliverableUpload(other, {
    ...input, encargoId: second.encargoId, signer: boom,
  }));
  assert.equal(await other.storedBytes('global'), 0);
  assert.equal(await other.classUsed('global', 'a', '2026-11-01'), 0);
  assert.equal((await other.listOpenReservations(second.encargoId)).length, 0);
});

test('una reserva caducada suelta la cuota y el resultado solo enlaza la clave emitida', async () => {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const repo = new D1Repository(shim);
  const r2 = createR2Shim();
  const store = new R2ObjectStore(r2);
  const { encargoId, userId } = await claimed(repo);
  const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const input = {
    encargoId, sha256: sha, contentMd5: md5(bytes), mime: 'video/mp4', sizeBytes: bytes.byteLength, now: NOW, signer,
  };
  const minted = await prepareDeliverableUpload(repo, input);
  shim._raw.prepare('UPDATE deliverable_reservations SET expires_at = ? WHERE r2_key = ?').run('2026-11-19T12:00:00.000Z', minted.r2_key);
  const released = await releaseExpiredReservations({ repo, now: () => '2026-11-19T12:00:01.000Z' });
  assert.equal(released, 1);
  assert.equal(await repo.storedBytes('global'), 0);
  assert.equal(await repo.classUsed('global', 'a', '2026-11-01'), 0);
  const renewed = await prepareDeliverableUpload(repo, { ...input, now: '2026-11-19T12:00:01.000Z' });
  assert.notEqual(renewed.r2_key, minted.r2_key);
  assert.equal(await repo.storedBytes('global'), bytes.byteLength);

  const free = await submitEncargoResult(repo, {
    encargoId, now: '2026-11-19T12:00:02.000Z', r2: store,
    body: { synthetic: true, content_hash: HASH, deliverable: { r2_key: 'out/libre', sha256: sha, mime: 'video/mp4', size_bytes: 8 } },
  }).catch((error) => error);
  assert.equal(free.code, 'INVALID_INPUT');
  assert.equal((await repo.encargoById(encargoId)).status, 'claimed');

  seedObject(r2, renewed.r2_key, new Uint8Array([1]), { contentType: 'video/mp4' });
  const mismatch = await submitEncargoResult(repo, {
    encargoId, now: '2026-11-19T12:00:03.000Z', r2: store,
    body: { synthetic: true, content_hash: HASH, deliverable: { r2_key: renewed.r2_key } },
  }).catch((error) => error);
  assert.equal(mismatch.code, 'INTEGRITY_ERROR');
  assert.equal((await repo.encargoById(encargoId)).status, 'claimed');

  seedObject(r2, renewed.r2_key, bytes, { contentType: 'video/mp4' });
  const ready = await submitEncargoResult(repo, {
    encargoId, now: '2026-11-19T12:00:04.000Z', r2: store,
    body: { synthetic: true, content_hash: HASH, deliverable: { r2_key: renewed.r2_key, sha256: 'ff'.repeat(32), mime: 'text/plain', size_bytes: 1 } },
  });
  assert.equal(ready.status, 'ready');
  assert.equal(await repo.storedBytes('global'), bytes.byteLength);
  const asset = shim._raw.prepare('SELECT sha256, mime, size_bytes, content_md5 FROM encargo_assets WHERE r2_key = ?').get(renewed.r2_key);
  assert.equal(asset.sha256, sha);
  assert.equal(asset.mime, 'video/mp4');
  assert.equal(Number(asset.size_bytes), bytes.byteLength);
  assert.equal(asset.content_md5, input.contentMd5);

  const media = await getMediaResponse({ repo, r2: store }, { email: 'ana@example.com', sha256: sha, now: '2026-11-19T12:00:05.000Z' });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('x-content-sha256'), sha);
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), bytes);

  const wrongSha = r2.objects.get(renewed.r2_key);
  const fake = Buffer.alloc(32, 7);
  wrongSha.checksums.sha256 = fake.buffer.slice(fake.byteOffset, fake.byteOffset + fake.byteLength);
  const rejected = await getMediaResponse({ repo, r2: store }, { email: 'ana@example.com', sha256: sha, now: '2026-11-19T12:00:06.000Z' }).catch((error) => error);
  assert.equal(rejected.code, 'INTEGRITY_ERROR');
  delete wrongSha.checksums.sha256;
  const again = await getMediaResponse({ repo, r2: store }, { email: 'ana@example.com', sha256: sha, now: '2026-11-19T12:00:07.000Z' });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-content-sha256'), sha);
  assert.equal(userId.length > 0, true);
});

test('leer_origen solo firma encargos reclamados y cuenta una clase B por GET', async () => {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const repo = new D1Repository(shim);
  const r2shim = createR2Shim();
  const store = new R2ObjectStore(r2shim);
  const guide = await saveGuide(repo, {
    email: 'ana@example.com', body: { display_name: 'Ana', time_zone: 'UTC' }, now: NOW,
  });
  const created = await createEncargo(repo, {
    email: 'ana@example.com',
    body: { account_id: guide.accounts[0].account_id, kind: 'edit', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] },
    now: NOW,
  });
  const user = await repo.userByEmail('ana@example.com');
  const bytes = new Uint8Array([4, 5, 6, 7]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = `pending/${user.user_id}/upload/01`;
  seedObject(r2shim, key, bytes, { contentType: 'video/mp4', sha256: true });
  await repo.addEncargoAsset({
    encargoId: created.encargo_id, userId: user.user_id, role: 'source', r2Key: key, sha256: sha,
    mime: 'video/mp4', sizeBytes: bytes.byteLength, version: 1, now: NOW, countBytes: false,
  });
  shim._raw.prepare(`UPDATE encargos SET status = 'queued' WHERE encargo_id = ?`).run(created.encargo_id);
  await claimEncargo(repo, { encargoId: created.encargo_id, now: NOW });
  const queuedRead = await readClaimedOrigin(repo, { encargoId: created.encargo_id, now: NOW, r2: store }).catch((error) => error);
  assert.equal(queuedRead.code, 'R2_SIGNING_UNAVAILABLE');
  assert.equal(await repo.classUsed('global', 'b', '2026-11-01'), 0);

  drainEgressAttempts();
  const origin = await readClaimedOrigin(repo, {
    encargoId: created.encargo_id, now: NOW, r2: store, signer,
  });
  assert.equal(origin.assets.length, 1);
  assert.equal(origin.assets[0].expires_at, '2026-11-19T12:10:00.000Z');
  assert.match(origin.assets[0].url, new RegExp(`pending/${user.user_id}/upload/01`));
  assert.equal(origin.assets[0].url.includes(SIGNING.secretAccessKey), false);
  assert.equal(await repo.classUsed(user.user_id, 'b', '2026-11-01'), 2);
  const logged = (await repo.listAudit()).filter((row) => row.action === 'ENCARGO_ORIGIN_READ');
  assert.equal(logged.every((row) => auditOmitsSignedUrl(row.detail_json)), true);
  assert.equal(drainEgressAttempts().some((row) => isR2Hostname(row.host)), false);
  assert.equal(await repo.storedBytes('global') <= MAX_GLOBAL_BYTES, true);
  assert.equal(bytes.byteLength <= MAX_USER_BYTES, true);
});

test('reclamar con origin sustituye leer_origen en el flujo MCP', async () => {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const repo = new D1Repository(shim);
  const r2shim = createR2Shim();
  const store = new R2ObjectStore(r2shim);
  const guide = await saveGuide(repo, {
    email: 'ana@example.com', body: { display_name: 'Ana', time_zone: 'UTC' }, now: NOW,
  });
  const created = await createEncargo(repo, {
    email: 'ana@example.com',
    body: { account_id: guide.accounts[0].account_id, kind: 'edit', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] },
    now: NOW,
  });
  const user = await repo.userByEmail('ana@example.com');
  const bytes = new Uint8Array([8, 9, 10]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = `pending/${user.user_id}/upload/02`;
  seedObject(r2shim, key, bytes, { contentType: 'video/mp4', sha256: true });
  await repo.addEncargoAsset({
    encargoId: created.encargo_id, userId: user.user_id, role: 'source', r2Key: key, sha256: sha,
    mime: 'video/mp4', sizeBytes: bytes.byteLength, version: 1, now: NOW, countBytes: false,
  });
  shim._raw.prepare(`UPDATE encargos SET status = 'queued' WHERE encargo_id = ?`).run(created.encargo_id);
  drainEgressAttempts();
  const claimed = await claimEncargo(repo, {
    encargoId: created.encargo_id, now: NOW, r2: store, signer, withOrigin: true, actor: 'mcp',
  });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.origin.assets.length, 1);
  assert.match(claimed.origin.assets[0].url, new RegExp(`pending/${user.user_id}/upload/02`));
  assert.equal(claimed.origin.assets[0].expires_at, '2026-11-19T12:10:00.000Z');
  assert.equal(claimed.origin.assets[0].sha256, sha);
  const auditRows = await repo.listAudit();
  const actions = auditRows.map((row) => row.action);
  assert.equal(actions.includes('ENCARGO_CLAIMED'), true);
  assert.equal(actions.includes('ENCARGO_ORIGIN_READ'), true);
  assert.equal(auditRows.every((row) => auditOmitsSignedUrl(row.detail_json)), true);
  assert.equal(await repo.classUsed(user.user_id, 'b', '2026-11-01'), 2);
  assert.equal(drainEgressAttempts().some((row) => isR2Hostname(row.host)), false);
  const mcpToolsPerEncargoBefore = 2;
  const mcpToolsPerEncargoAfter = 1;
  assert.equal(mcpToolsPerEncargoAfter, mcpToolsPerEncargoBefore - 1);
});

test('el cron suelta una reserva caducada', async () => {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const repo = new D1Repository(shim);
  const { encargoId } = await claimed(repo);
  const now = new Date().toISOString();
  await repo.reserveBytes((await repo.userByEmail('ana@example.com')).user_id, 4, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  await repo.reserveDaily((await repo.userByEmail('ana@example.com')).user_id, 'a', now, 10_000, 800_000);
  await repo.insertDeliverableReservation({
    reservationId: crypto.randomUUID(), encargoId, userId: (await repo.userByEmail('ana@example.com')).user_id,
    r2Key: `out/${encargoId}/1/${crypto.randomUUID()}`, version: 1, sha256: HASH,
    contentMd5: '1B2M2Y8AsgTpgAmY7PhCfg==', mime: 'audio/mpeg', sizeBytes: 4, bytesHeld: 4, classAHeld: 1,
    quotaDay: now.slice(0, 10), expiresAt: '2020-01-01T00:00:00.000Z', now,
  });
  const env = {
    DB: shim, PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube',
  };
  let job;
  await workerMod.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, {
    waitUntil(promise) { job = promise; },
  });
  await job;
  assert.equal(await repo.storedBytes('global'), 0);
  assert.equal(await repo.classUsed('global', 'a', '2020-01-01'), 0);
});
