// Escenarios obligatorios del simulador (sección 5 de la especificación).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeMockPublisher, MOCK_URL_BASE } from '../../src/adapters/publishers/youtube/youtube-mock.js';
import { YouTubeLivePublisher } from '../../src/adapters/publishers/youtube/youtube-live.js';
import { createPublisherRegistry } from '../../src/adapters/publishers/registry.js';
import { MemoryStore } from '../../src/adapters/repository/d1-mock-provider-store.js';
import { SOCIAL_PUBLISHER_METHODS } from '../../src/core/ports/social-publisher.js';
import { mp4Bytes, samplePost } from '../helpers/sample.mjs';

const VIDEO = mp4Bytes(new URL('../../tests/fixtures/lote-0001-media/P01_fotos_nocturnas.mp4', import.meta.url));
const post = (o = {}) => samplePost({ media: { ...samplePost().media, size_bytes: VIDEO.length }, ...o });
const media = { bytes: VIDEO, mime: 'video/mp4' };
const mk = () => new YouTubeMockPublisher({ store: new MemoryStore() });

async function fullPublish(a, p) {
  const up = await a.uploadMedia(p, media); if (!up.ok) return { stage: 'upload', r: up };
  const pr = await a.publishPost(p, up); if (!pr.ok) return { stage: 'publish', r: pr };
  const st = await a.getPublicationStatus(pr.provider_post_id);
  return { stage: 'done', up, pr, st, res: await a.getPublicationResult(pr.provider_post_id) };
}

test('contrato: mock, live (stub) y placeholders implementan SocialPublisher', () => {
  const reg = createPublisherRegistry({}, { store: new MemoryStore() });
  for (const p of ['youtube', 'instagram', 'tiktok']) for (const m of SOCIAL_PUBLISHER_METHODS) assert.equal(typeof reg.forPlatform(p)[m], 'function');
  assert.equal(reg.forPlatform('youtube').info.mode, 'mock');
});

test('ESCENARIO publicación correcta: ID y URL marcados como MOCK', async () => {
  const a = mk(); const r = await fullPublish(a, post());
  assert.equal(r.stage, 'done');
  assert.match(r.pr.provider_post_id, /^MOCK-YT-/);
  assert.equal(r.st.status, 'PUBLISHED');
  assert.ok(r.res.url.startsWith(MOCK_URL_BASE) && r.res.url.includes('.invalid/'));
  assert.equal(r.res.mock, true);
  assert.match(r.res.notice, /SIMULACIÓN/);
});

test('ESCENARIO archivo incompatible: MIME no vídeo y firma inválida', async () => {
  const a = mk();
  const v = await a.validatePost(post({ media: { ...post().media, mime: 'image/png' } }));
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => e.field === 'media.mime'));
  const fake = new Uint8Array(VIDEO.length).fill(7);
  const up = await a.uploadMedia(post(), { bytes: fake, mime: 'video/mp4' });
  assert.equal(up.ok, false); assert.equal(up.error.code, 'VALIDATION_ERROR');
  const big = await a.validatePost(post({ media: { ...post().media, size_bytes: 21 * 1024 * 1024 } }));
  assert.ok(big.errors.some((e) => e.field === 'media.size_bytes'));
});

test('ESCENARIO metadatos incompletos', async () => {
  const v = await mk().validatePost(post({ copy: { title: '', privacy_status: 'secret' } }));
  assert.equal(v.ok, false);
  for (const f of ['copy.title', 'copy.description', 'copy.category_id', 'copy.privacy_status', 'copy.made_for_kids', 'copy.contains_synthetic_media']) assert.ok(v.errors.some((e) => e.field === f), f);
  const long = await mk().validatePost(post({ copy: { ...post().copy, title: 'x'.repeat(101) } }));
  assert.ok(long.errors.some((e) => e.field === 'copy.title'));
});

test('ESCENARIO error temporal + reintento satisfactorio', async () => {
  const a = mk(); const p = post({ test_controls: { mock_scenario: 'publish_transient_once' } });
  const first = await fullPublish(a, p);
  assert.equal(first.stage, 'publish'); assert.equal(first.r.error.retryable, true);
  const second = await fullPublish(a, p);
  assert.equal(second.stage, 'done'); assert.equal(second.up.duplicate, true, 'la subida no se repite');
  assert.equal(second.st.status, 'PUBLISHED');
  const up1 = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'upload_transient_once' } }));
  assert.equal(up1.stage, 'upload'); assert.equal(up1.r.error.code, 'UPLOAD_ERROR');
});

test('ESCENARIO error permanente y error de autenticación', async () => {
  const perm = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'publish_permanent' } }));
  assert.equal(perm.stage, 'publish'); assert.equal(perm.r.error.retryable, false);
  const auth = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'auth_error' } }));
  assert.equal(auth.r.error.code, 'AUTH_ERROR'); assert.equal(auth.r.error.retryable, false);
  const proc = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'processing_failed' } }));
  assert.equal(proc.st.status, 'FAILED'); assert.equal(proc.st.error.code, 'PROCESSING_ERROR');
});

test('ESCENARIO publicación duplicada: mismo ID, nada nuevo', async () => {
  const a = mk(); const p = post();
  const r1 = await fullPublish(a, p); const r2 = await fullPublish(a, p);
  assert.equal(r2.pr.duplicate, true);
  assert.equal(r1.pr.provider_post_id, r2.pr.provider_post_id);
});

test('ESCENARIO consulta de estado: procesando -> publicado; ID inexistente', async () => {
  const a = mk(); const p = post();
  const up = await a.uploadMedia(p, media); const pr = await a.publishPost(p, up);
  assert.equal(pr.status, 'PUBLISHING');
  const st = await a.getPublicationStatus(pr.provider_post_id);
  assert.equal(st.processing_status, 'succeeded');
  const nf = await a.getPublicationStatus('MOCK-YT-noexiste');
  assert.equal(nf.ok, false); assert.equal(nf.error.code, 'NOT_FOUND');
});

test('IDs simulados distintos por publicación', async () => {
  const a = mk(); const ids = new Set();
  for (let i = 0; i < 3; i++) ids.add((await fullPublish(a, post({ idempotency_key: `k${i}` }))).pr.provider_post_id);
  assert.equal(ids.size, 3);
});

test('LIVE: el stub no hace nada y siempre devuelve LIVE_DISABLED', async () => {
  const l = new YouTubeLivePublisher();
  for (const m of ['validatePost', 'uploadMedia', 'publishPost', 'getPublicationStatus', 'getPublicationResult']) assert.equal((await l[m]()).error.code, 'LIVE_DISABLED');
  assert.throws(() => createPublisherRegistry({ PUBLISHER_MODE: 'live' }, {}), (e) => e.code === 'LIVE_MODE_BLOCKED');
});
