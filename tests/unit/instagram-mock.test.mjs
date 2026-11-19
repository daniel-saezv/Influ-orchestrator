import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramMockPublisher, INSTAGRAM_MOCK_URL_BASE } from '../../src/adapters/publishers/instagram/instagram-mock.js';
import { createPublisherRegistry } from '../../src/adapters/publishers/registry.js';
import { MemoryStore } from '../../src/adapters/repository/d1-mock-provider-store.js';
import { mp4Bytes, samplePost } from '../helpers/sample.mjs';

const VIDEO = mp4Bytes(new URL('../../tests/fixtures/lote-0001-media/P01_fotos_nocturnas.mp4', import.meta.url));
const post = (o = {}) => samplePost({
  platform: 'instagram', content_type: 'reel',
  media: { sha256: 'a'.repeat(64), mime: 'video/mp4', size_bytes: VIDEO.length, filename: 'x.mp4', duration_s: 8, width: 720, height: 1280 },
  copy: { caption: 'Caption MOCK', hashtags: ['mock'] },
  ...o,
});
const media = { bytes: VIDEO, mime: 'video/mp4' };
const mk = () => new InstagramMockPublisher({ store: new MemoryStore() });

async function fullPublish(a, p) {
  const up = await a.uploadMedia(p, media); if (!up.ok) return { stage: 'upload', r: up };
  const pr = await a.publishPost(p, up); if (!pr.ok) return { stage: 'publish', r: pr };
  const st = await a.getPublicationStatus(pr.provider_post_id);
  return { stage: 'done', up, pr, st, res: await a.getPublicationResult(pr.provider_post_id) };
}

test('Instagram MOCK: publicación correcta y registro', async () => {
  const reg = createPublisherRegistry({}, { store: new MemoryStore() });
  assert.equal(reg.forPlatform('instagram').info.provider, 'instagram');
  const r = await fullPublish(mk(), post());
  assert.equal(r.stage, 'done');
  assert.match(r.pr.provider_post_id, /^MOCK-IG-/);
  assert.equal(r.st.status, 'PUBLISHED');
  assert.ok(r.res.url.startsWith(INSTAGRAM_MOCK_URL_BASE) && r.res.url.includes('.invalid/'));
  assert.equal(r.res.mock, true);
  assert.match(r.res.notice, /SIMULACIÓN/);
});

test('Instagram MOCK: archivo incompatible y metadatos incompletos', async () => {
  const a = mk();
  const v = await a.validatePost(post({ media: { ...post().media, mime: 'audio/mpeg' } }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.field === 'media.mime'));
  const fake = await a.uploadMedia(post(), { bytes: new Uint8Array(VIDEO.length).fill(7), mime: 'video/mp4' });
  assert.equal(fake.ok, false);
  assert.equal(fake.error.code, 'VALIDATION_ERROR');
  const missing = await a.validatePost(post({ copy: {}, content_type: 'image' }));
  assert.ok(missing.errors.some((e) => e.field === 'copy.caption'));
  assert.ok((await a.validatePost(post({ content_type: 'video' }))).errors.some((e) => e.field === 'content_type'));
  const feed = post({
    content_type: 'image',
    media: { ...post().media, mime: 'image/jpeg', width: 1080, height: 1350, duration_s: null, size_bytes: 100 },
  });
  assert.equal((await a.validatePost(feed)).ok, true);
  assert.ok((await a.validatePost(post({ ...feed, media: { ...feed.media, mime: 'image/png' } }))).errors.some((e) => e.field === 'media.mime'));
  assert.ok((await a.validatePost(post({ ...feed, media: { ...feed.media, width: 720, height: 1280 } }))).errors.some((e) => e.field === 'media.width'));
  assert.ok((await a.validatePost(post({ ...feed, media: { ...feed.media, size_bytes: 8 * 1024 * 1024 + 1 } }))).errors.some((e) => e.field === 'media.size_bytes'));
  const carousel = post({
    content_type: 'carousel',
    media: { ...feed.media, item_count: 20 },
  });
  assert.equal((await a.validatePost(carousel)).ok, true);
  assert.ok((await a.validatePost(post({ ...carousel, media: { ...carousel.media, item_count: 21 } }))).errors.some((e) => e.field === 'media.item_count'));
  assert.equal((await a.validatePost(post({ content_type: 'reel', media: { ...post().media, duration_s: 900 } }))).ok, true);
  assert.ok((await a.validatePost(post({ content_type: 'reel', media: { ...post().media, duration_s: 2 } }))).errors.some((e) => e.field === 'media.duration_s'));
  assert.equal((await a.validatePost(post({ content_type: 'story', media: { ...post().media, duration_s: 60 } }))).ok, true);
  assert.ok((await a.validatePost(post({ content_type: 'story', media: { ...post().media, duration_s: 61 } }))).errors.some((e) => e.field === 'media.duration_s'));
  const storyImage = post({
    content_type: 'story',
    media: { ...feed.media, width: 1080, height: 1920 },
  });
  assert.equal((await a.validatePost(storyImage)).ok, true);
});

test('Instagram MOCK: errores temporales, permanentes y autenticación', async () => {
  const transientAdapter = mk();
  const transientPost = post({ test_controls: { mock_scenario: 'publish_transient_once' } });
  const transient = await fullPublish(transientAdapter, transientPost);
  assert.equal(transient.stage, 'publish');
  assert.equal(transient.r.error.retryable, true);
  const retry = await fullPublish(transientAdapter, transientPost);
  assert.equal(retry.stage, 'done');
  assert.equal(retry.up.duplicate, true);
  const upload = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'upload_transient_once' } }));
  assert.equal(upload.stage, 'upload');
  assert.equal(upload.r.error.code, 'UPLOAD_ERROR');
  const permanent = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'publish_permanent' } }));
  assert.equal(permanent.r.error.retryable, false);
  const auth = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'auth_error' } }));
  assert.equal(auth.r.error.code, 'AUTH_ERROR');
  const failed = await fullPublish(mk(), post({ test_controls: { mock_scenario: 'processing_failed' } }));
  assert.equal(failed.st.status, 'FAILED');
  assert.equal(failed.st.error.code, 'PROCESSING_ERROR');
});

test('Instagram MOCK: duplicados, estado y IDs distintos', async () => {
  const a = mk(); const p = post();
  const first = await fullPublish(a, p);
  const second = await fullPublish(a, p);
  assert.equal(second.pr.duplicate, true);
  assert.equal(first.pr.provider_post_id, second.pr.provider_post_id);
  const nf = await a.getPublicationStatus('MOCK-IG-noexiste');
  assert.equal(nf.error.code, 'NOT_FOUND');
  const ids = new Set();
  for (let i = 0; i < 3; i++) ids.add((await fullPublish(mk(), post({ idempotency_key: `ig-${i}` }))).pr.provider_post_id);
  assert.equal(ids.size, 3);
});
