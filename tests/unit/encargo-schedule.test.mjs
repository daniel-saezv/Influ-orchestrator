import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Repository } from '../../src/adapters/repository/d1-repository.js';
import { D1MockProviderStore } from '../../src/adapters/repository/d1-mock-provider-store.js';
import { KvMediaStorage } from '../../src/adapters/storage/kv-media-storage.js';
import { R2ObjectStore } from '../../src/adapters/storage/r2-object-store.js';
import { createPublisherRegistry } from '../../src/adapters/publishers/registry.js';
import { runtimeSettings } from '../../src/core/config.js';
import { contentHash } from '../../src/core/domain/hash.js';
import { claimEncargo, createEncargo, decideEncargo, saveGuide, scheduleEncargo, submitEncargoResult } from '../../src/workflows/encargos.js';
import { receiveBatch } from '../../src/workflows/wf01-receive-batch.js';
import { dispatch } from '../../src/workflows/wf03-schedule-dispatch.js';
import { createD1Shim, createKvShim } from '../helpers/d1-shim.mjs';
import { createR2Shim } from '../helpers/r2-shim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-07-15T12:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const EMAIL = 'ana@example.com';
const ENCARGO_HASH = 'ab'.repeat(32);

function mp4() {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return bytes;
}

function world() {
  const shim = createD1Shim(join(ROOT, 'migrations'));
  const kv = createKvShim();
  const r2 = createR2Shim();
  const repo = new D1Repository(shim);
  const ctx = {
    repo,
    media: new KvMediaStorage(kv, shim),
    r2: new R2ObjectStore(r2),
    settings: runtimeSettings({ MAX_STATUS_POLLS: '3', MAX_ATTEMPTS: '3', RETRY_BASE_SECONDS: '2' }),
    actor: 'test',
    keyId: 'access',
    now: () => NOW,
    registry: createPublisherRegistry({ PUBLISHER_MODE: 'mock' }, { store: new D1MockProviderStore(shim), maxBytes: 20 * 1024 * 1024 }),
  };
  return { shim, r2, repo, ctx };
}

async function account(repo) {
  const guide = await saveGuide(repo, { email: EMAIL, body: { display_name: 'Ana', time_zone: 'UTC' }, now: NOW });
  return guide.accounts[0].account_id;
}

async function linkedEncargo(repo, ctx, accountId, batchId, media) {
  await ctx.media.put(media.sha256, media.bytes, { mime: 'video/mp4', filename: 'pieza.mp4' });
  await receiveBatch({
    batch_id: batchId,
    title: 'Pieza',
    publications: [{
      seq: 1,
      platform: 'youtube',
      content_type: 'short_video',
      media: { sha256: media.sha256, mime: 'video/mp4', size_bytes: media.bytes.length, filename: 'pieza.mp4', duration_s: 8, width: 720, height: 1280 },
      copy: {
        title: 'Título de prueba',
        description: 'Descripción de la pieza de prueba.',
        hashtags: ['#prueba'],
        category_id: '22',
        privacy_status: 'public',
        made_for_kids: false,
        contains_synthetic_media: true,
      },
      scheduled_at: '2026-07-01T00:00:00.000Z',
    }],
  }, ctx);
  const created = await createEncargo(repo, {
    email: EMAIL, now: NOW, body: { account_id: accountId, kind: 'from_scratch', note: 'una pieza', platforms: ['youtube'] },
  });
  await claimEncargo(repo, { encargoId: created.encargo_id, now: NOW });
  await submitEncargoResult(repo, {
    encargoId: created.encargo_id, now: NOW,
    body: { synthetic: true, content_hash: ENCARGO_HASH, batch_id: batchId },
  });
  return created.encargo_id;
}

test('aprobar y programar enlaza el lote: la hora futura espera y now publica', async () => {
  const { repo, ctx, r2 } = world();
  const accountId = await account(repo);
  const bytes = mp4();
  const media = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  const futureId = await linkedEncargo(repo, ctx, accountId, 'LOTE-FUTURO1', media);
  const before = await repo.getBatch('LOTE-FUTURO1');
  const same = await contentHash({ ...before.payload, publications: before.payload.publications.map((p) => ({ ...p, scheduled_at: FUTURE })) });
  assert.equal(same, before.content_hash);

  await decideEncargo(repo, {
    email: EMAIL, encargoId: futureId, now: NOW, r2: ctx.r2,
    body: { decision: 'approve', version: 1, content_hash: ENCARGO_HASH },
  });
  const approved = await repo.getBatch('LOTE-FUTURO1');
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.content_hash, before.content_hash);
  let pubs = await repo.listPublications('LOTE-FUTURO1', 1);
  assert.equal(pubs[0].status, 'VALIDATED');

  await scheduleEncargo(repo, {
    email: EMAIL, encargoId: futureId, now: NOW, body: { when: FUTURE },
    dispatchBatch: (id) => dispatch({ batchId: id, trigger: 'schedule-now' }, ctx),
  });
  const after = await repo.getBatch('LOTE-FUTURO1');
  assert.equal(after.content_hash, before.content_hash);
  pubs = await repo.listPublications('LOTE-FUTURO1', 1);
  assert.equal(pubs[0].status, 'SCHEDULED');
  assert.equal(pubs[0].scheduled_at, FUTURE);
  assert.equal(pubs[0].post.scheduled_at, FUTURE);
  const waiting = await dispatch({ batchId: 'LOTE-FUTURO1' }, ctx);
  assert.equal(waiting.batches[0].processed.length, 0);
  assert.match(waiting.batches[0].skipped[0].reason, /hora/);

  const nowId = await linkedEncargo(repo, ctx, accountId, 'LOTE-AHORA01', media);
  const user = await repo.userByEmail(EMAIL);
  const source = new Uint8Array([9, 9, 9, 9]);
  await r2.put('src/origen', source, { storageClass: 'Standard' });
  await repo.addEncargoAsset({
    encargoId: nowId, userId: user.user_id, role: 'source', r2Key: 'src/origen',
    sha256: createHash('sha256').update(source).digest('hex'), mime: 'video/mp4', sizeBytes: source.length, version: 1, now: NOW,
  });
  await decideEncargo(repo, {
    email: EMAIL, encargoId: nowId, now: NOW, r2: ctx.r2,
    body: { decision: 'approve', version: 1, content_hash: ENCARGO_HASH },
  });
  const published = await scheduleEncargo(repo, {
    email: EMAIL, encargoId: nowId, now: NOW, body: { when: 'now' },
    dispatchBatch: (id) => dispatch({ batchId: id, trigger: 'schedule-now' }, ctx),
  });
  assert.equal(published.status, 'scheduled');
  pubs = await repo.listPublications('LOTE-AHORA01', 1);
  assert.equal(pubs[0].status, 'PUBLISHED');
  assert.equal((await repo.getBatch('LOTE-AHORA01')).status, 'COMPLETED');
  assert.equal(r2.objects.has('src/origen'), false);
  assert.equal(await repo.storedBytes(user.user_id), 0);
});

test('una huella vieja del lote falla cerrado y el encargo sigue listo', async () => {
  const { shim, repo, ctx } = world();
  const accountId = await account(repo);
  const bytes = mp4();
  const media = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  const encargoId = await linkedEncargo(repo, ctx, accountId, 'LOTE-VIEJA01', media);
  shim._raw.prepare('UPDATE batches SET content_hash = ? WHERE batch_id = ?').run('00'.repeat(32), 'LOTE-VIEJA01');
  shim._raw.prepare('UPDATE batch_versions SET content_hash = ? WHERE batch_id = ?').run('00'.repeat(32), 'LOTE-VIEJA01');
  await assert.rejects(
    () => decideEncargo(repo, {
      email: EMAIL, encargoId, now: NOW, r2: ctx.r2,
      body: { decision: 'approve', version: 1, content_hash: ENCARGO_HASH },
    }),
    (error) => error.code === 'HASH_MISMATCH' && error.http === 409,
  );
  assert.equal((await repo.encargoById(encargoId)).status, 'ready');
  assert.equal((await repo.getBatch('LOTE-VIEJA01')).status, 'READY_FOR_REVIEW');
});

test('sin batch_id se aprueba y se programa, y el cron no tiene lote que publicar', async () => {
  const { repo, ctx } = world();
  const accountId = await account(repo);
  const created = await createEncargo(repo, {
    email: EMAIL, now: NOW, body: { account_id: accountId, kind: 'from_scratch', note: 'una pieza', platforms: ['youtube'] },
  });
  await claimEncargo(repo, { encargoId: created.encargo_id, now: NOW });
  await submitEncargoResult(repo, {
    encargoId: created.encargo_id, now: NOW, body: { synthetic: true, content_hash: ENCARGO_HASH },
  });
  await decideEncargo(repo, {
    email: EMAIL, encargoId: created.encargo_id, now: NOW,
    body: { decision: 'approve', version: 1, content_hash: ENCARGO_HASH },
  });
  const scheduled = await scheduleEncargo(repo, {
    email: EMAIL, encargoId: created.encargo_id, now: NOW, body: { when: 'now' },
    dispatchBatch: () => { throw new Error('no debía despachar'); },
  });
  assert.equal(scheduled.status, 'scheduled');
  const run = await dispatch({ trigger: 'cron' }, ctx);
  assert.equal(run.batches.length, 0);
});
