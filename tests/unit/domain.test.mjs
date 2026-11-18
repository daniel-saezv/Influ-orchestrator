import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash } from '../../src/core/domain/hash.js';
import { validateBatchInput } from '../../src/core/domain/batch.js';
import { aggregateBatchStatus } from '../../src/core/domain/states.js';
import { resolvePublisherConfig } from '../../src/core/config.js';
import { parseDecisionCommand } from '../../src/workflows/wf02-approve-batch.js';

const pub = (o = {}) => ({ seq: 1, platform: 'youtube', content_type: 'short_video', media: { sha256: 'a'.repeat(64), mime: 'video/mp4', size_bytes: 10, filename: 'a.mp4' }, copy: { title: 't' }, scheduled_at: '2026-11-19T17:00:00Z', ...o });
const batch = (o = {}) => ({ batch_id: 'LOTE-0001', title: 'x', publications: [pub()], ...o });

test('canonicalize es estable con independencia del orden de claves', () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalize({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test('la huella cambia con el copy, un hashtag o el archivo, y no con la hora', async () => {
  const h0 = await contentHash(validateBatchInput(batch()));
  assert.match(h0, /^[a-f0-9]{64}$/);
  assert.equal(h0, await contentHash(validateBatchInput(batch())));
  assert.notEqual(h0, await contentHash(validateBatchInput(batch({ publications: [pub({ copy: { title: 't2' } })] }))));
  assert.notEqual(h0, await contentHash(validateBatchInput(batch({ publications: [pub({ copy: { title: 't', hashtags: ['#a'] } })] }))));
  assert.equal(h0, await contentHash(validateBatchInput(batch({ publications: [pub({ scheduled_at: '2026-11-19T18:00:00Z' })] }))));
  assert.notEqual(h0, await contentHash(validateBatchInput(batch({ publications: [pub({ media: { sha256: 'b'.repeat(64), mime: 'video/mp4', size_bytes: 10, filename: 'a.mp4' } })] }))));
});

test('validación estructural: rechaza campos prohibidos (p. ej. forzar modo LIVE) y datos incompletos', () => {
  assert.throws(() => validateBatchInput(batch({ mode: 'live' })), (e) => e.code === 'INVALID_BATCH' && e.details.some((d) => d.field === 'mode'));
  assert.throws(() => validateBatchInput(batch({ publications: [pub({ live: true })] })), /validación/);
  assert.throws(() => validateBatchInput(batch({ batch_id: 'x' })), (e) => e.details.some((d) => d.field === 'batch_id'));
  assert.throws(() => validateBatchInput(batch({ publications: [pub({ media: undefined })] })), (e) => e.details.some((d) => d.field.includes('media')));
  assert.throws(() => validateBatchInput(batch({ publications: [pub(), pub()] })), (e) => e.details.some((d) => d.message.includes('duplicado')));
});

test('estado agregado del lote', () => {
  assert.equal(aggregateBatchStatus(['PUBLISHED', 'PUBLISHED']), 'COMPLETED');
  assert.equal(aggregateBatchStatus(['PUBLISHED', 'FAILED']), 'PARTIALLY_COMPLETED');
  assert.equal(aggregateBatchStatus(['FAILED']), 'FAILED');
  assert.equal(aggregateBatchStatus(['PUBLISHED', 'RETRY_PENDING']), 'PUBLISHING');
  assert.equal(aggregateBatchStatus(['PUBLISHED', 'CANCELLED']), 'COMPLETED');
});

test('modo: MOCK por defecto y LIVE bloqueado (fail-closed)', () => {
  assert.equal(resolvePublisherConfig({}).mode, 'mock');
  assert.equal(resolvePublisherConfig({ PUBLISHER_MODE: '' }).mode, 'mock');
  assert.equal(resolvePublisherConfig({ PUBLISHER_MODE: 'mock', PUBLISHER_PROVIDER: 'youtube' }).provider, 'youtube');
  assert.throws(() => resolvePublisherConfig({ PUBLISHER_MODE: 'LIVE' }), (e) => e.code === 'MODE_CONFIG_INVALID');
  assert.throws(() => resolvePublisherConfig({ PUBLISHER_MODE: 'prod' }), (e) => e.code === 'MODE_CONFIG_INVALID');
  assert.throws(() => resolvePublisherConfig({ PUBLISHER_MODE: 'live' }), (e) => e.code === 'LIVE_MODE_BLOCKED');
  // Incluso con todas las variables "correctas", la build no permite LIVE.
  assert.throws(() => resolvePublisherConfig({ PUBLISHER_MODE: 'live', LIVE_SAFETY_ACK: 'ENABLE_LIVE_PUBLISHING_YOUTUBE', DEPLOY_ENV: 'production' }), (e) => e.code === 'LIVE_MODE_BLOCKED' && e.details.some((d) => d.includes('LIVE_ENABLED_IN_BUILD')));
  assert.throws(() => resolvePublisherConfig({ PUBLISHER_PROVIDER: 'myspace' }), (e) => e.code === 'MODE_CONFIG_INVALID');
});

test('comandos de decisión', () => {
  assert.deepEqual(parseDecisionCommand('APROBAR LOTE-0001'), { decision: 'APPROVE', batch_id: 'LOTE-0001', comment: null });
  assert.deepEqual(parseDecisionCommand('RECHAZAR LOTE-0001'), { decision: 'REJECT', batch_id: 'LOTE-0001', comment: null });
  assert.equal(parseDecisionCommand('CAMBIOS LOTE-0001: cambia el título del 2').comment, 'cambia el título del 2');
  assert.equal(parseDecisionCommand('aprueba todo'), null);
});
