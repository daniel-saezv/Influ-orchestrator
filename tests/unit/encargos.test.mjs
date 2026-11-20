import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { civilDay, previousCivilDay } from '../../src/core/domain/encargos.js';
import {
  claimEncargo, createEncargo, decideEncargo, getMe, getStreak, saveGuide, scheduleEncargo, submitEncargoResult,
} from '../../src/workflows/encargos.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim, seedObject } from '../helpers/r2-shim.mjs';
import { MAX_GLOBAL_BYTES, MAX_USER_BYTES } from '../../src/core/domain/r2-quota.js';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import { OrchestratorClient } from '../../bot/client-lib.mjs';
import workerMod, { setAccessJwtDeps } from '../../src/worker.js';

const signer = createAccessSigner();
const accessKey = await cryptoKeyFromPublic(signer.publicKey);
setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', accessKey]]) });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HASH = 'ab'.repeat(32);
const mediaBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = createHash('sha256').update(mediaBytes).digest('hex');
const AUD = 'aud-encargos';
const NOW_1 = '2026-07-15T06:30:00.000Z';
const NOW_2 = '2026-07-15T08:30:00.000Z';

function db() {
  return createD1Shim(join(ROOT, 'migrations'));
}

test('día civil: el anterior cruza el mes, y julio en Los Ángeles no es UTC', () => {
  assert.equal(previousCivilDay('2026-03-01'), '2026-02-28');
  assert.equal(civilDay('America/Los_Angeles', NOW_1), '2026-07-14');
  assert.equal(civilDay('America/Los_Angeles', NOW_2), '2026-07-15');
  assert.equal(civilDay('UTC', NOW_1), '2026-07-15');
});

test('encargos: aislamiento, racha en la zona guardada, cola del bot y bytes', async () => {
  const shim = db();
  const repo = new D1Repository(shim);
  const env = meEnv(shim, '60');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = (email) => signer.sign({ aud: AUD, exp, email });
  const service = signer.sign({ aud: AUD, exp, common_name: 'bot', type: 'app' });
  const call = (method, path, token, body, headers = {}) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: { 'cf-access-jwt-assertion': token, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const json = async (res) => ({ status: res.status, ...(await res.json()) });

  const guide = await json(await call('POST', '/v1/me', person('Ana@Example.com'), { display_name: 'Ana', time_zone: 'America/Los_Angeles' }));
  assert.equal(guide.status, 200);
  assert.equal(guide.data.email, 'ana@example.com');
  assert.equal(guide.data.guide_pending, false);
  assert.equal(guide.data.accounts.length, 1);
  const accountId = guide.data.accounts[0].account_id;
  assert.equal(guide.data.accounts[0].name, 'Ana');

  const again = await json(await call('POST', '/v1/me', person('ana@example.com'), { display_name: 'Ana', time_zone: 'America/Los_Angeles' }));
  assert.equal(again.data.accounts.length, 1);

  const extra = await json(await call('POST', '/v1/me/accounts', person('ana@example.com'), { name: 'Ana vídeos' }));
  assert.equal(extra.status, 200);

  const renamed = await json(await call('PATCH', `/v1/me/accounts/${accountId}`, person('ana@example.com'), { name: 'Ana principal' }));
  assert.equal(renamed.data.name, 'Ana principal');

  const mismatch = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: accountId, kind: 'from_scratch', note: 'foto en youtube',
    format: 'image', targets: [{ platform: 'youtube', target: 'short' }],
  }));
  assert.equal(mismatch.status, 400);
  const created = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: accountId, kind: 'from_scratch', note: 'un vídeo corto', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }, { platform: 'instagram', target: 'reel' }],
  }));
  assert.equal(created.data.status, 'queued');
  assert.equal(created.data.format, 'short_video');
  assert.deepEqual(created.data.targets, [
    { platform: 'youtube', target: 'short' },
    { platform: 'instagram', target: 'reel' },
  ]);
  const encargoId = created.data.encargo_id;

  const draft = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: extra.data.account_id, kind: 'edit', format: 'short_video', targets: [{ platform: 'tiktok', target: 'video' }],
  }));
  assert.equal(draft.data.status, 'draft');
  shim._raw.prepare('UPDATE encargos SET format = NULL, targets_json = NULL WHERE encargo_id = ?').run(draft.data.encargo_id);
  const legacy = await json(await call('GET', `/v1/me/encargos/${draft.data.encargo_id}`, person('ana@example.com')));
  assert.equal(legacy.data.format, null);
  assert.equal(legacy.data.legacy, true);
  assert.deepEqual(legacy.data.platforms, ['tiktok']);

  const listed = await json(await call('GET', '/v1/me/encargos', person('ana@example.com')));
  assert.equal(listed.status, 200);
  assert.equal(listed.data.encargos.length, 2);
  assert.equal(listed.data.encargos.find((item) => item.encargo_id === encargoId).status, 'queued');
  assert.equal(listed.data.encargos.find((item) => item.encargo_id === draft.data.encargo_id).status, 'draft');
  assert.equal(listed.data.encargos.every((item) => item.created_at && item.updated_at && item.account_name), true);

  const bot = new OrchestratorClient({
    baseUrl: 'https://local.test',
    botSecret: env.BOT_HMAC_SECRET,
    approverSecret: env.APPROVER_HMAC_SECRET,
    accessHeaders: { 'cf-access-jwt-assertion': service },
    transport: (url, init) => workerMod.fetch(new Request(url, init), env),
  });
  const queued = await bot.call('GET', '/v1/encargos?status=queued');
  assert.equal(queued.status, 200);
  assert.equal(queued.data.encargos.length, 1);
  assert.equal(queued.data.encargos[0].encargo_id, encargoId);
  assert.equal(queued.data.encargos[0].format, 'short_video');
  assert.equal(queued.data.encargos[0].legacy, false);
  assert.equal(JSON.stringify(queued.data).includes('ana@example.com'), false);
  assert.equal(JSON.stringify(queued.data).includes('ciphertext'), false);
  const asApprover = await bot.call('POST', `/v1/encargos/${encargoId}/claim`, { keyId: 'approver' });
  assert.equal(asApprover.status, 403);

  const claim = await bot.call('POST', `/v1/encargos/${encargoId}/claim`);
  assert.equal(claim.status, 200);
  assert.equal(claim.data.encargo.format, 'short_video');
  assert.deepEqual(claim.data.encargo.targets, [
    { platform: 'youtube', target: 'short' },
    { platform: 'instagram', target: 'reel' },
  ]);
  const rejected = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: { synthetic: false, content_hash: HASH } });
  assert.equal(rejected.status, 400);
  const freeKey = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: {
    synthetic: true, content_hash: HASH, deliverable: { r2_key: 'out/pieza', sha256: SHA, mime: 'video/mp4', size_bytes: 1000 },
  } });
  assert.equal(freeKey.status, 400);
  assert.equal(freeKey.error.code, 'INVALID_INPUT');
  const userId = (await repo.ensureUser('ana@example.com', NOW_1)).user_id;
  const pieceKey = `out/${encargoId}/1/${crypto.randomUUID()}`;
  const seeded = seedObject(env.MEDIA_R2, pieceKey, mediaBytes, { contentType: 'video/mp4' });
  await repo.reserveBytes(userId, mediaBytes.byteLength, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  await repo.insertDeliverableReservation({
    reservationId: crypto.randomUUID(), encargoId, userId, r2Key: pieceKey, version: 1, sha256: SHA,
    contentMd5: seeded.md5, mime: 'video/mp4', sizeBytes: mediaBytes.byteLength, bytesHeld: mediaBytes.byteLength,
    classAHeld: 0, quotaDay: '2026-11-19', expiresAt: '2027-01-01T00:00:00.000Z', now: NOW_1,
  });
  const ready = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: {
    synthetic: true, content_hash: HASH, deliverable: { r2_key: pieceKey },
  } });
  assert.equal(ready.status, 200, JSON.stringify(ready.error));
  assert.equal(ready.data.version, 1);

  const origin = new Uint8Array(500).fill(7);
  const originSha = createHash('sha256').update(origin).digest('hex');
  const originDigest = createHash('sha256').update(origin).digest();
  await env.MEDIA_R2.put('src/origen', origin, {
    sha256: originDigest.buffer.slice(originDigest.byteOffset, originDigest.byteOffset + originDigest.byteLength),
    httpMetadata: { contentType: 'video/mp4' },
  });
  await repo.addEncargoAsset({
    encargoId, userId, role: 'source', r2Key: 'src/origen', sha256: originSha, mime: 'video/mp4', sizeBytes: 500, version: 1, now: NOW_1,
  });
  shim._raw.prepare(`INSERT INTO upload_sessions
    (upload_id, user_id, encargo_id, expected_parts, received_parts, file_sha256, part_hashes_json, size_bytes, mime, bytes_reserved, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 1, 1, ?, '{}', 500, 'video/mp4', 0, ?, ?, ?)`).run(crypto.randomUUID(), userId, encargoId, originSha, NOW_1, NOW_1, NOW_1);
  assert.equal(await repo.storedBytes('global'), 500 + mediaBytes.byteLength);

  const bobToken = person('bob@example.com');
  await json(await call('POST', '/v1/me', bobToken, { display_name: 'Bob', time_zone: 'UTC' }));
  for (const path of [
    `/v1/me/encargos/${encargoId}`,
    `/v1/me/media/${SHA}`,
    `/v1/me/accounts/${accountId}/streak`,
    `/v1/me/accounts/${accountId}/activity`,
    `/v1/me/accounts/${accountId}/connections`,
    `/v1/me/connections/${accountId}`,
  ]) {
    const foreign = await json(await call('GET', path, bobToken));
    assert.equal(foreign.status, 404, path);
    assert.equal(foreign.error.code, 'NOT_FOUND', path);
  }
  const missing = await json(await call('GET', '/v1/me/encargos/00000000-0000-4000-8000-000000000000', person('ana@example.com')));
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'NOT_FOUND');

  const ownMedia = await call('GET', `/v1/me/media/${SHA}`, person('ana@example.com'));
  assert.equal(ownMedia.status, 200);
  assert.equal(ownMedia.headers.get('x-content-sha256'), SHA);
  assert.deepEqual(new Uint8Array(await ownMedia.arrayBuffer()), mediaBytes);
  const ownEncargoRes = await call('GET', `/v1/me/encargos/${encargoId}`, person('ana@example.com'));
  const ownEncargo = await json(ownEncargoRes);
  assert.equal(ownEncargo.data.preview.sha256, SHA);
  assert.equal(ownEncargo.data.preview.media_url, `/v1/me/media/${SHA}`);
  const encargoEtag = ownEncargoRes.headers.get('etag');
  assert.ok(encargoEtag);
  const cachedEncargo = await call('GET', `/v1/me/encargos/${encargoId}`, person('ana@example.com'), undefined, { 'If-None-Match': encargoEtag });
  assert.equal(cachedEncargo.status, 304);
  assert.equal(await cachedEncargo.text(), '');

  const listedReady = await json(await call('GET', '/v1/me/encargos', person('ana@example.com')));
  const listedRow = listedReady.data.encargos.find((item) => item.encargo_id === encargoId);
  assert.equal(listedRow.preview.sha256, SHA);
  assert.equal(listedRow.preview.mime, 'video/mp4');
  assert.equal(listedRow.preview.media_url, `/v1/me/media/${SHA}`);
  const ownConn = await json(await call('GET', `/v1/me/accounts/${accountId}/connections`, person('ana@example.com')));
  assert.equal(ownConn.status, 200);
  assert.deepEqual(ownConn.data.connections, []);
  assert.equal(await repo.countConnections(), 0);

  const serviceMe = await json(await call('GET', '/v1/me', service));
  assert.equal(serviceMe.status, 403);
  assert.equal(serviceMe.error.code, 'ACCESS_DENIED');
  const serviceList = await json(await call('GET', '/v1/me/encargos', service));
  assert.equal(serviceList.status, 403);
  assert.equal(serviceList.error.code, 'ACCESS_DENIED');
  const bobList = await json(await call('GET', '/v1/me/encargos', bobToken));
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.data.encargos, []);

  const changes = await json(await call('POST', `/v1/me/encargos/${encargoId}/decision`, person('ana@example.com'), {
    decision: 'changes', version: 1, content_hash: HASH, note: 'Más corto',
  }));
  assert.equal(changes.data.status, 'queued');
  const changedEncargo = await json(await call('GET', `/v1/me/encargos/${encargoId}`, person('ana@example.com')));
  assert.match(changedEncargo.data.note, /Cambios: Más corto$/);
  assert.equal(changes.data.bytes_released, mediaBytes.byteLength);
  assert.equal(await repo.storedBytes('global'), 500);
  const assets = shim._raw.prepare('SELECT role FROM encargo_assets WHERE encargo_id = ?').all(encargoId);
  assert.deepEqual(assets.map((a) => a.role), ['source']);

  const claim2 = await bot.call('POST', `/v1/encargos/${encargoId}/claim`);
  assert.equal(claim2.status, 200);
  const piece2 = new Uint8Array(800).fill(9);
  const piece2Key = `out/${encargoId}/2/${crypto.randomUUID()}`;
  const seeded2 = seedObject(env.MEDIA_R2, piece2Key, piece2, { contentType: 'video/mp4' });
  await repo.reserveBytes(userId, piece2.byteLength, MAX_USER_BYTES, MAX_GLOBAL_BYTES);
  await repo.insertDeliverableReservation({
    reservationId: crypto.randomUUID(), encargoId, userId, r2Key: piece2Key, version: 2, sha256: seeded2.sha256,
    contentMd5: seeded2.md5, mime: 'video/mp4', sizeBytes: piece2.byteLength, bytesHeld: piece2.byteLength,
    classAHeld: 0, quotaDay: '2026-11-19', expiresAt: '2027-01-01T00:00:00.000Z', now: NOW_1,
  });
  const ready2 = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: {
    synthetic: true, content_hash: HASH, file_sha256: originSha,
    deliverable: { r2_key: piece2Key },
  } });
  assert.equal(ready2.data.version, 2);
  const approved = await json(await call('POST', `/v1/me/encargos/${encargoId}/decision`, person('ana@example.com'), {
    decision: 'approve', version: 2, content_hash: HASH,
  }));
  assert.equal(approved.data.status, 'approved');
  const scheduled = await json(await call('POST', `/v1/me/encargos/${encargoId}/schedule`, person('ana@example.com'), { when: 'now' }));
  assert.equal(scheduled.data.status, 'scheduled');
  assert.equal(scheduled.data.streak_days >= 1, true);

  const second = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: accountId, kind: 'from_scratch', note: 'otro', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
  }));
  await bot.call('POST', `/v1/encargos/${second.data.encargo_id}/claim`);
  await bot.call('POST', `/v1/encargos/${second.data.encargo_id}/result`, { body: { synthetic: true, content_hash: HASH } });
  await json(await call('POST', `/v1/me/encargos/${second.data.encargo_id}/decision`, person('ana@example.com'), {
    decision: 'approve', version: 1, content_hash: HASH,
  }));
  const scheduled2 = await json(await call('POST', `/v1/me/encargos/${second.data.encargo_id}/schedule`, person('ana@example.com'), { when: 'now' }));
  assert.equal(scheduled2.status, 200);

  const streak = await json(await call('GET', `/v1/me/accounts/${accountId}/streak`, person('ana@example.com')));
  assert.equal(streak.data.time_zone, 'America/Los_Angeles');
  assert.equal(streak.data.count >= 1, true);
  const me = await json(await call('GET', '/v1/me', person('ana@example.com')));
  assert.equal(me.data.accounts.find((item) => item.account_id === accountId).streak_days, streak.data.count);
  const indexNames = shim._raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  for (const name of ['idx_assets_encargo_role_version', 'idx_uploads_encargo_completed', 'idx_encargo_events_account_id', 'idx_encargos_account_updated']) {
    assert.equal(indexNames.includes(name), true, name);
  }

  const activity = await json(await call('GET', `/v1/me/accounts/${accountId}/activity`, person('ana@example.com')));
  assert.equal(activity.data.activity.some((row) => row.kind === 'scheduled'), true);
  assert.equal(activity.data.activity.every((row) => row.local_day && row.local_time), true);

  const cancelled = await json(await call('POST', `/v1/me/encargos/${encargoId}/cancel`, person('ana@example.com')));
  assert.equal(cancelled.data.status, 'cancelled');
  const afterCancel = await json(await call('GET', '/v1/me/encargos', person('ana@example.com')));
  assert.equal(afterCancel.data.encargos.length, 3);
  assert.equal(afterCancel.data.encargos.find((item) => item.encargo_id === encargoId).status, 'cancelled');
  assert.equal(afterCancel.data.encargos.find((item) => item.encargo_id === second.data.encargo_id).status, 'scheduled');
  assert.equal(afterCancel.data.encargos.find((item) => item.encargo_id === draft.data.encargo_id).status, 'draft');
  const left = shim._raw.prepare('SELECT COUNT(*) AS n FROM encargo_assets WHERE encargo_id = ?').get(encargoId);
  assert.equal(Number(left.n), 0);

  const windows = shim._raw.prepare("SELECT bucket_key FROM http_rate_windows").all();
  assert.equal(windows.some((row) => String(row.bucket_key).startsWith('anon:')), false);
  assert.equal(windows.some((row) => row.bucket_key === 'user:ana@example.com'), true);
});

test('la racha usa el día civil de la zona, no el día UTC', async () => {
  const repo = new D1Repository(db());
  const email = 'ana@example.com';
  const guide = await saveGuide(repo, { email, body: { display_name: 'Ana', time_zone: 'America/Los_Angeles' }, now: NOW_1 });
  const accountId = guide.accounts[0].account_id;
  async function closeOne(note, now) {
    const created = await createEncargo(repo, { email, body: { account_id: accountId, kind: 'from_scratch', note, format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }] }, now });
    await claimEncargo(repo, { encargoId: created.encargo_id, now });
    await submitEncargoResult(repo, { encargoId: created.encargo_id, body: { synthetic: true, content_hash: HASH }, now });
    await decideEncargo(repo, { email, encargoId: created.encargo_id, body: { decision: 'approve', version: 1, content_hash: HASH }, now });
    return scheduleEncargo(repo, { email, encargoId: created.encargo_id, body: { when: 'now' }, now });
  }
  const closed = await closeOne('uno', NOW_1);
  assert.equal(closed.streak_days, 1);
  const me = await getMe(repo, { email, now: NOW_1 });
  assert.equal(me.accounts[0].streak_days, 1);
  const first = await getStreak(repo, { email, accountId, now: NOW_1 });
  assert.equal(first.count, 1);
  assert.equal(first.last_civil_day, '2026-07-14');
  await closeOne('dos', NOW_2);
  const second = await getStreak(repo, { email, accountId, now: NOW_2 });
  assert.equal(second.count, 2);
  assert.equal(second.last_civil_day, '2026-07-15');
  assert.equal(second.today, '2026-07-15');
});

test('rate limit por persona: un correo no gasta el cupo de otro', async () => {
  const shim = db();
  const env = meEnv(shim, '2');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const call = (email) => workerMod.fetch(new Request('https://local.test/v1/me', {
    headers: { 'cf-access-jwt-assertion': signer.sign({ aud: AUD, exp, email }) },
  }), env);
  assert.equal((await call('una@example.com')).status, 200);
  assert.equal((await call('una@example.com')).status, 200);
  assert.equal((await call('una@example.com')).status, 429);
  assert.equal((await call('otra@example.com')).status, 200);
});

test('cuentas: renombrar, archivar y ocultarlas hasta restaurarlas', async () => {
  const shim = db();
  const env = meEnv(shim, '60');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const person = (email) => signer.sign({ aud: AUD, exp, email });
  const call = (method, path, token, body) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: { 'cf-access-jwt-assertion': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const json = async (res) => ({ status: res.status, ...(res.status === 204 ? {} : await res.json()) });
  const ana = person('ana@example.com');
  const guide = await json(await call('POST', '/v1/me', ana, { display_name: 'Ana', time_zone: 'Europe/Madrid' }));
  const kept = guide.data.accounts[0].account_id;
  const extra = await json(await call('POST', '/v1/me/accounts', ana, { name: 'Ana vídeos' }));
  const encargo = await json(await call('POST', '/v1/me/encargos', ana, {
    account_id: extra.data.account_id, kind: 'from_scratch', note: 'una idea', format: 'short_video',
    targets: [{ platform: 'youtube', target: 'short' }],
  }));
  assert.equal(encargo.status, 200);
  const renamed = await json(await call('PATCH', `/v1/me/accounts/${extra.data.account_id}`, ana, { name: 'Ana archivo' }));
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, 'Ana archivo');
  assert.equal(renamed.data.archived_at, null);
  const forbidden = await json(await call('POST', `/v1/me/accounts/${extra.data.account_id}/archive`, ana, { status: 'live' }));
  assert.equal(forbidden.status, 400);
  const archived = await json(await call('POST', `/v1/me/accounts/${extra.data.account_id}/archive`, ana));
  assert.equal(archived.status, 200);
  assert.equal(archived.data.name, 'Ana archivo');
  assert.ok(archived.data.archived_at);
  const again = await json(await call('POST', `/v1/me/accounts/${extra.data.account_id}/archive`, ana, {}));
  assert.equal(again.data.archived_at, archived.data.archived_at);
  const me = await json(await call('GET', '/v1/me', ana));
  assert.deepEqual(me.data.accounts.map((item) => item.account_id), [kept]);
  const active = await json(await call('GET', '/v1/me/accounts', ana));
  assert.equal(active.data.accounts.length, 1);
  assert.equal(active.data.accounts[0].archived_at, null);
  const hidden = await json(await call('GET', '/v1/me/accounts?archived=1', ana));
  assert.equal(hidden.data.accounts.length, 1);
  assert.equal(hidden.data.accounts[0].account_id, extra.data.account_id);
  const blocked = await json(await call('POST', '/v1/me/encargos', ana, {
    account_id: extra.data.account_id, kind: 'from_scratch', note: 'otra', format: 'image',
    targets: [{ platform: 'instagram', target: 'feed' }],
  }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error.code, 'CONFLICT');
  const listed = await json(await call('GET', '/v1/me/encargos', ana));
  assert.equal(listed.data.encargos.some((item) => item.encargo_id === encargo.data.encargo_id), true);
  const bob = person('bob@example.com');
  await json(await call('POST', '/v1/me', bob, { display_name: 'Bob', time_zone: 'UTC' }));
  const foreign = await json(await call('POST', `/v1/me/accounts/${extra.data.account_id}/archive`, bob));
  assert.equal(foreign.status, 404);
  const restored = await json(await call('POST', `/v1/me/accounts/${extra.data.account_id}/restore`, ana));
  assert.equal(restored.status, 200);
  assert.equal(restored.data.archived_at, null);
  const back = await json(await call('GET', '/v1/me', ana));
  assert.equal(back.data.accounts.length, 2);
  const indexNames = shim._raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  assert.equal(indexNames.includes('idx_accounts_user_archived'), true);
});

function meEnv(shim, userLimit) {
  return {
    DB: shim,
    MEDIA: createKvShim(),
    MEDIA_R2: createR2Shim(),
    BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef',
    APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
    PUBLISHER_MODE: 'mock',
    PUBLISHER_PROVIDER: 'youtube',
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: AUD,
    RATE_LIMIT_USER_PER_MINUTE: userLimit,
  };
}
