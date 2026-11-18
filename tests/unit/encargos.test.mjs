import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { civilDay, previousCivilDay } from '../../src/core/domain/encargos.js';
import {
  claimEncargo, createEncargo, decideEncargo, getStreak, saveGuide, scheduleEncargo, submitEncargoResult,
} from '../../src/workflows/encargos.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim } from '../helpers/r2-shim.mjs';
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
  const call = (method, path, token, body) => workerMod.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: { 'cf-access-jwt-assertion': token, ...(body ? { 'content-type': 'application/json' } : {}) },
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

  const created = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: accountId, kind: 'from_scratch', note: 'un vídeo corto', platforms: ['youtube', 'instagram'],
  }));
  assert.equal(created.data.status, 'queued');
  const encargoId = created.data.encargo_id;

  const draft = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: extra.data.account_id, kind: 'edit', platforms: ['tiktok'],
  }));
  assert.equal(draft.data.status, 'draft');

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
  assert.equal(JSON.stringify(queued.data).includes('ana@example.com'), false);
  assert.equal(JSON.stringify(queued.data).includes('ciphertext'), false);
  const asApprover = await bot.call('POST', `/v1/encargos/${encargoId}/claim`, { keyId: 'approver' });
  assert.equal(asApprover.status, 403);

  const claim = await bot.call('POST', `/v1/encargos/${encargoId}/claim`);
  assert.equal(claim.status, 200);
  const rejected = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: { synthetic: false, content_hash: HASH } });
  assert.equal(rejected.status, 400);
  const ready = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: {
    synthetic: true, content_hash: HASH, deliverable: { r2_key: 'out/pieza', sha256: SHA, mime: 'video/mp4', size_bytes: 1000 },
  } });
  assert.equal(ready.data.version, 1);
  const digest = createHash('sha256').update(mediaBytes).digest();
  await env.MEDIA_R2.put('out/pieza', mediaBytes, {
    sha256: digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength),
    httpMetadata: { contentType: 'video/mp4' },
  });

  await repo.addEncargoAsset({
    encargoId, userId: (await repo.ensureUser('ana@example.com', NOW_1)).user_id,
    role: 'source', r2Key: 'src/origen', sha256: 'ef'.repeat(32), mime: 'video/mp4', sizeBytes: 500, version: 1, now: NOW_1,
  });
  assert.equal(await repo.storedBytes('global'), 1500);

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
  const ownConn = await json(await call('GET', `/v1/me/accounts/${accountId}/connections`, person('ana@example.com')));
  assert.equal(ownConn.status, 200);
  assert.deepEqual(ownConn.data.connections, []);
  assert.equal(await repo.countConnections(), 0);

  const serviceMe = await json(await call('GET', '/v1/me', service));
  assert.equal(serviceMe.status, 403);
  assert.equal(serviceMe.error.code, 'ACCESS_DENIED');

  const changes = await json(await call('POST', `/v1/me/encargos/${encargoId}/decision`, person('ana@example.com'), {
    decision: 'changes', version: 1, content_hash: HASH,
  }));
  assert.equal(changes.data.status, 'queued');
  assert.equal(changes.data.bytes_released, 1000);
  assert.equal(await repo.storedBytes('global'), 500);
  const assets = shim._raw.prepare('SELECT role FROM encargo_assets WHERE encargo_id = ?').all(encargoId);
  assert.deepEqual(assets.map((a) => a.role), ['source']);

  const claim2 = await bot.call('POST', `/v1/encargos/${encargoId}/claim`);
  assert.equal(claim2.status, 200);
  const ready2 = await bot.call('POST', `/v1/encargos/${encargoId}/result`, { body: {
    synthetic: true, content_hash: HASH, deliverable: { r2_key: 'out/pieza-2', sha256: '12'.repeat(32), mime: 'video/mp4', size_bytes: 800 },
  } });
  assert.equal(ready2.data.version, 2);
  const approved = await json(await call('POST', `/v1/me/encargos/${encargoId}/decision`, person('ana@example.com'), {
    decision: 'approve', version: 2, content_hash: HASH,
  }));
  assert.equal(approved.data.status, 'approved');
  const scheduled = await json(await call('POST', `/v1/me/encargos/${encargoId}/schedule`, person('ana@example.com'), { when: 'now' }));
  assert.equal(scheduled.data.status, 'scheduled');

  const second = await json(await call('POST', '/v1/me/encargos', person('ana@example.com'), {
    account_id: accountId, kind: 'from_scratch', note: 'otro', platforms: ['youtube'],
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

  const activity = await json(await call('GET', `/v1/me/accounts/${accountId}/activity`, person('ana@example.com')));
  assert.equal(activity.data.activity.some((row) => row.kind === 'scheduled'), true);
  assert.equal(activity.data.activity.every((row) => row.local_day && row.local_time), true);

  const cancelled = await json(await call('POST', `/v1/me/encargos/${encargoId}/cancel`, person('ana@example.com')));
  assert.equal(cancelled.data.status, 'cancelled');
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
    const created = await createEncargo(repo, { email, body: { account_id: accountId, kind: 'from_scratch', note, platforms: ['youtube'] }, now });
    await claimEncargo(repo, { encargoId: created.encargo_id, now });
    await submitEncargoResult(repo, { encargoId: created.encargo_id, body: { synthetic: true, content_hash: HASH }, now });
    await decideEncargo(repo, { email, encargoId: created.encargo_id, body: { decision: 'approve', version: 1, content_hash: HASH }, now });
    return scheduleEncargo(repo, { email, encargoId: created.encargo_id, body: { when: 'now' }, now });
  }
  await closeOne('uno', NOW_1);
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
