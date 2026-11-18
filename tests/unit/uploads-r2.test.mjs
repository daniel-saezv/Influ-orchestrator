import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { MAX_FILE_BYTES, MAX_GLOBAL_BYTES, MAX_USER_BYTES, PART_SIZE_BYTES, shiftUtcDay } from '../../src/core/domain/r2-quota.js';
import { deleteOrphanUploads, retryPendingDeletes } from '../../src/workflows/r2-gc.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim } from '../helpers/r2-shim.mjs';
import { createAccessSigner, cryptoKeyFromPublic } from '../helpers/access-token.mjs';
import workerMod, { setAccessJwtDeps } from '../../src/worker.js';

const signer = createAccessSigner();
const accessKey = await cryptoKeyFromPublic(signer.publicKey);
setAccessJwtDeps({ getCertKeys: async () => new Map([['test-kid', accessKey]]) });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUD = 'aud-uploads';
const NOW = '2026-07-15T12:00:00.000Z';
const DAY = new Date().toISOString().slice(0, 10);

function shaHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function db() {
  return createD1Shim(join(ROOT, 'migrations'));
}

function envFor(shim, r2 = createR2Shim()) {
  return {
    DB: shim,
    MEDIA: createKvShim(),
    ...(r2 ? { MEDIA_R2: r2 } : {}),
    BOT_HMAC_SECRET: 'local-test-bot-secret-0123456789abcdef',
    APPROVER_HMAC_SECRET: 'local-test-approver-secret-0123456789ab',
    PUBLISHER_MODE: 'mock',
    PUBLISHER_PROVIDER: 'youtube',
    ACCESS_TEAM_DOMAIN: 'team.example.com',
    ACCESS_AUD: AUD,
    RATE_LIMIT_USER_PER_MINUTE: '600',
  };
}

function harness() {
  const shim = db();
  const r2 = createR2Shim();
  const env = envFor(shim, r2);
  const repo = new D1Repository(shim);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = (email) => signer.sign({ aud: AUD, exp, email });
  const call = (method, path, email, { json, raw, headers } = {}) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: {
      'cf-access-jwt-assertion': token(email),
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(raw ? { 'content-length': String(raw.byteLength) } : {}),
      ...(headers ?? {}),
    },
    body: json ? JSON.stringify(json) : raw,
  }), env);
  const read = async (res) => ({ status: res.status, ...(await res.json()) });
  return { shim, r2, env, repo, call, read };
}

async function draft(h, email = 'ana@example.com') {
  const guide = await h.read(await h.call('POST', '/v1/me', email, { json: { display_name: 'Ana', time_zone: 'UTC' } }));
  assert.equal(guide.status, 200);
  const created = await h.read(await h.call('POST', '/v1/me/encargos', email, {
    json: { account_id: guide.data.accounts[0].account_id, kind: 'edit', platforms: ['youtube'] },
  }));
  assert.equal(created.data.status, 'draft');
  return { email, encargoId: created.data.encargo_id, accountId: guide.data.accounts[0].account_id };
}

test('subida: partes, reintento de la misma huella, lectura en bytes y aislamiento', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4', sha256: digest },
  }));
  assert.equal(opened.status, 201);
  assert.equal(opened.data.part_size, PART_SIZE_BYTES);
  assert.equal(opened.data.part_count, 1);
  assert.equal(opened.data.resumed, false);

  const put = await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes,
    headers: { 'content-type': 'video/mp4', 'x-content-sha256': digest },
  }));
  assert.equal(put.status, 200);
  assert.equal(put.data.sha256, digest);
  assert.equal(put.data.already_uploaded, false);
  assert.equal(h.r2.puts, 1);
  assert.equal(h.r2.objects.size, 1);

  const again = await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes,
    headers: { 'x-content-sha256': digest },
  }));
  assert.equal(again.data.already_uploaded, true);
  assert.equal(h.r2.puts, 1);

  const other = await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: new Uint8Array(8).fill(9),
    headers: { 'x-content-sha256': 'ab'.repeat(32) },
  }));
  assert.equal(other.status, 409);

  const done = await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'queued');
  const twice = await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  assert.equal(twice.status, 409);

  const media = await h.call('GET', `/v1/me/media/${digest}`, email);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.equal(media.headers.get('x-content-sha256'), digest);
  assert.equal(media.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()), bytes);

  await h.read(await h.call('POST', '/v1/me', 'bob@example.com', { json: { display_name: 'Bob', time_zone: 'UTC' } }));
  for (const [method, path, body] of [
    ['PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, bytes],
    ['POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, { sha256: digest }],
    ['GET', `/v1/me/media/${digest}`, null],
  ]) {
    const foreign = await h.read(await h.call(method, path, 'bob@example.com', body && method !== 'GET' ? { json: body, raw: method === 'PUT' ? bytes : undefined, headers: method === 'PUT' ? { 'x-content-sha256': digest } : {} } : {}));
    assert.equal(foreign.status, 404, path);
  }
});

test('150 MiB + 1 no llama a R2 y una parte de más anuncia dos partes', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const huge = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: MAX_FILE_BYTES + 1, mime: 'video/mp4' },
  }));
  assert.equal(huge.status, 413);
  assert.equal(huge.error.code, 'QUOTA_EXCEEDED');
  assert.equal(h.r2.puts, 0);
  assert.equal(h.shim._raw.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get().n, 0);

  const split = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: PART_SIZE_BYTES + 1, mime: 'video/mp4' },
  }));
  assert.equal(split.status, 201);
  assert.equal(split.data.part_count, 2);
  assert.equal(split.data.part_size, PART_SIZE_BYTES);
  assert.equal(h.r2.puts, 0);
});

test('topes de bytes de usuario y global, y la ventana de 30 días de clase A', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const user = await h.repo.userByEmail(email);
  h.shim._raw.prepare('INSERT INTO r2_bytes (scope, bytes_stored) VALUES (?, ?)').run(user.user_id, MAX_USER_BYTES - 10);
  h.shim._raw.prepare("INSERT INTO r2_bytes (scope, bytes_stored) VALUES ('global', ?)").run(MAX_USER_BYTES - 10);
  const overUser = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: 11, mime: 'video/mp4' },
  }));
  assert.equal(overUser.status, 413);
  assert.equal(h.r2.puts, 0);

  const h2 = harness();
  const second = await draft(h2);
  h2.shim._raw.prepare("INSERT INTO r2_bytes (scope, bytes_stored) VALUES ('global', ?)").run(MAX_GLOBAL_BYTES - 10);
  const overGlobal = await h2.read(await h2.call('POST', '/v1/me/uploads', second.email, {
    json: { encargo_id: second.encargoId, size_bytes: 11, mime: 'video/mp4' },
  }));
  assert.equal(overGlobal.status, 413);
  assert.equal(await h2.repo.storedBytes('global'), MAX_GLOBAL_BYTES - 10);

  const h3 = harness();
  const third = await draft(h3);
  const owner = await h3.repo.userByEmail(third.email);
  const old = shiftUtcDay(DAY, -31);
  h3.shim._raw.prepare('INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES (?, ?, 10000, 0, 0)').run(owner.user_id, old);
  const allowed = await h3.read(await h3.call('POST', '/v1/me/uploads', third.email, {
    json: { encargo_id: third.encargoId, size_bytes: 4, mime: 'audio/mpeg' },
  }));
  assert.equal(allowed.status, 201);
  h3.shim._raw.prepare(`INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES (?, ?, 10000, 0, 0)
    ON CONFLICT(scope, day) DO UPDATE SET class_a = 10000`).run(owner.user_id, DAY);
  const blocked = await h3.read(await h3.call('PUT', `/v1/me/uploads/${allowed.data.upload_id}/parts/1`, third.email, {
    raw: new Uint8Array([1, 2, 3, 4]),
    headers: { 'x-content-sha256': shaHex(new Uint8Array([1, 2, 3, 4])) },
  }));
  assert.equal(blocked.status, 413);
  assert.equal(blocked.error.code, 'QUOTA_EXCEEDED');
  assert.equal(h3.r2.puts, 0);
});

test('un checksum distinto conserva la clase A, no deja objeto y suelta esos bytes', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([4, 5, 6, 7]);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4' },
  }));
  const rejected = await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes,
    headers: { 'x-content-sha256': '00'.repeat(32) },
  }));
  assert.equal(rejected.status, 400);
  assert.equal(rejected.error.code, 'CHECKSUM_MISMATCH');
  assert.equal(h.r2.puts, 1);
  assert.equal(h.r2.objects.size, 0);
  const user = await h.repo.userByEmail(email);
  const ops = h.shim._raw.prepare('SELECT class_a FROM r2_daily WHERE scope = ? AND day = ?').get(user.user_id, DAY);
  assert.equal(ops.class_a, 1);
  const session = h.shim._raw.prepare('SELECT bytes_reserved FROM upload_sessions WHERE upload_id = ?').get(opened.data.upload_id);
  assert.equal(session.bytes_reserved, 0);
  assert.equal(await h.repo.storedBytes(user.user_id), 0);
  assert.equal(await h.repo.storedBytes('global'), 0);
});

test('cambios borra entregables de esta versión y de la anterior; el origen sigue legible', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const origin = new Uint8Array([8, 7, 6, 5]);
  const originSha = shaHex(origin);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: origin.length, mime: 'video/mp4', sha256: originSha },
  }));
  await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: origin, headers: { 'content-type': 'video/mp4', 'x-content-sha256': originSha },
  }));
  await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: originSha } }));
  const user = await h.repo.userByEmail(email);
  const current = new Uint8Array([1, 1, 1, 1]);
  const previous = new Uint8Array([2, 2, 2, 2]);
  await h.repo.addEncargoAsset({
    encargoId, userId: user.user_id, role: 'deliverable', r2Key: 'out/actual', sha256: shaHex(current),
    mime: 'video/mp4', sizeBytes: current.length, version: 2, now: NOW,
  });
  await h.repo.addEncargoAsset({
    encargoId, userId: user.user_id, role: 'deliverable', r2Key: 'out/anterior', sha256: shaHex(previous),
    mime: 'video/mp4', sizeBytes: previous.length, version: 1, now: NOW,
  });
  await h.r2.put('out/actual', current, { storageClass: 'Standard' });
  await h.r2.put('out/anterior', previous, { storageClass: 'Standard' });
  h.shim._raw.prepare("UPDATE encargos SET status = 'ready', version = 2, content_hash = ? WHERE encargo_id = ?").run('ab'.repeat(32), encargoId);
  const before = await h.repo.classUsed(user.user_id, 'a', shiftUtcDay(DAY, -29));
  const changes = await h.read(await h.call('POST', `/v1/me/encargos/${encargoId}/decision`, email, {
    json: { decision: 'changes', version: 2, content_hash: 'ab'.repeat(32) },
  }));
  assert.equal(changes.status, 200);
  assert.equal(changes.data.bytes_released, current.length + previous.length);
  const roles = h.shim._raw.prepare('SELECT role FROM encargo_assets WHERE encargo_id = ?').all(encargoId).map((row) => row.role);
  assert.deepEqual(roles, ['source']);
  assert.equal(h.r2.objects.has('out/actual'), false);
  assert.equal(h.r2.objects.has('out/anterior'), false);
  assert.equal(await h.repo.storedBytes(user.user_id), origin.length);
  assert.equal(await h.repo.classUsed(user.user_id, 'a', shiftUtcDay(DAY, -29)), before);
  const again = await h.call('GET', `/v1/me/media/${originSha}`, email);
  assert.equal(again.status, 200);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), origin);
});

test('cancelar deja a cero los bytes del encargo y no baja la ventana de clase A', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([3, 3, 3, 3]);
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4' },
  }));
  await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes, headers: { 'x-content-sha256': digest },
  }));
  await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  const user = await h.repo.userByEmail(email);
  const ops = await h.repo.classUsed(user.user_id, 'a', shiftUtcDay(DAY, -29));
  const cancelled = await h.read(await h.call('POST', `/v1/me/encargos/${encargoId}/cancel`, email));
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(await h.repo.storedBytes(user.user_id), 0);
  assert.equal(await h.repo.storedBytes('global'), 0);
  assert.equal(h.shim._raw.prepare('SELECT COUNT(*) AS n FROM encargo_assets WHERE encargo_id = ?').get(encargoId).n, 0);
  assert.equal(await h.repo.classUsed(user.user_id, 'a', shiftUtcDay(DAY, -29)), ops);
});

test('un DeleteObject fallido conserva fila y bytes; el cron los suelta', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4' },
  }));
  await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes, headers: { 'content-type': 'video/mp4', 'x-content-sha256': digest },
  }));
  await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  const user = await h.repo.userByEmail(email);
  const key = [...h.r2.objects.keys()][0];
  h.r2.failDelete.add(key);
  const cancelled = await h.read(await h.call('POST', `/v1/me/encargos/${encargoId}/cancel`, email));
  assert.equal(cancelled.data.bytes_released, 0);
  const pending = h.shim._raw.prepare('SELECT delete_pending FROM encargo_assets WHERE encargo_id = ?').get(encargoId);
  assert.equal(pending.delete_pending, 1);
  assert.equal(await h.repo.storedBytes(user.user_id), bytes.length);
  assert.equal(h.r2.objects.has(key), true);
  h.r2.failDelete.clear();
  const n = await retryPendingDeletes({ repo: h.repo, r2: h.env.MEDIA_R2 });
  assert.equal(n, 1);
  assert.equal(h.shim._raw.prepare('SELECT COUNT(*) AS n FROM encargo_assets WHERE encargo_id = ?').get(encargoId).n, 0);
  assert.equal(await h.repo.storedBytes(user.user_id), 0);
  assert.equal(h.r2.objects.has(key), false);
});

test('el cron borra una sesión abierta de más de un día y suelta el hueco', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4' },
  }));
  await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes, headers: { 'x-content-sha256': digest },
  }));
  const user = await h.repo.userByEmail(email);
  h.shim._raw.prepare('UPDATE upload_sessions SET created_at = ? WHERE upload_id = ?').run('2026-07-13T00:00:00.000Z', opened.data.upload_id);
  await deleteOrphanUploads({ repo: h.repo, r2: h.env.MEDIA_R2, now: () => NOW });
  assert.equal(h.shim._raw.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get().n, 0);
  assert.equal(h.r2.objects.size, 0);
  assert.equal(await h.repo.storedBytes(user.user_id), 0);
});

test('sin binding de R2 la subida responde 503 y no reserva', async () => {
  const shim = db();
  const env = envFor(shim, null);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = signer.sign({ aud: AUD, exp, email: 'ana@example.com' });
  const call = (path, body) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const guide = await (await call('/v1/me', { display_name: 'Ana', time_zone: 'UTC' })).json();
  const created = await (await call('/v1/me/encargos', {
    account_id: guide.data.accounts[0].account_id, kind: 'edit', platforms: ['youtube'],
  })).json();
  const res = await call('/v1/me/uploads', { encargo_id: created.data.encargo_id, size_bytes: 4, mime: 'video/mp4' });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'R2_UNAVAILABLE');
  assert.equal(shim._raw.prepare('SELECT COUNT(*) AS n FROM upload_sessions').get().n, 0);
  assert.equal(shim._raw.prepare('SELECT COUNT(*) AS n FROM r2_bytes').get().n, 0);
});

test('la clase B de hace 31 días no bloquea la lectura y la de hoy sí', async () => {
  const h = harness();
  const { email, encargoId } = await draft(h);
  const bytes = new Uint8Array([5, 5, 5, 5]);
  const digest = shaHex(bytes);
  const opened = await h.read(await h.call('POST', '/v1/me/uploads', email, {
    json: { encargo_id: encargoId, size_bytes: bytes.length, mime: 'video/mp4' },
  }));
  await h.read(await h.call('PUT', `/v1/me/uploads/${opened.data.upload_id}/parts/1`, email, {
    raw: bytes, headers: { 'content-type': 'video/mp4', 'x-content-sha256': digest },
  }));
  await h.read(await h.call('POST', `/v1/me/uploads/${opened.data.upload_id}/complete`, email, { json: { sha256: digest } }));
  const user = await h.repo.userByEmail(email);
  h.shim._raw.prepare(`INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES (?, ?, 0, 100000, 0)
    ON CONFLICT(scope, day) DO UPDATE SET class_b = 100000`).run(user.user_id, DAY);
  const blocked = await h.call('GET', `/v1/me/media/${digest}`, email);
  assert.equal(blocked.status, 413);
  h.shim._raw.prepare('UPDATE r2_daily SET class_b = 0 WHERE scope = ? AND day = ?').run(user.user_id, DAY);
  h.shim._raw.prepare('INSERT INTO r2_daily (scope, day, class_a, class_b, bytes_peak) VALUES (?, ?, 0, 100000, 0)').run(user.user_id, shiftUtcDay(DAY, -31));
  const open = await h.call('GET', `/v1/me/media/${digest}`, email);
  assert.equal(open.status, 200);
});
