import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../src/adapters/repository/d1-mock-provider-store.js';
import { YouTubeMockPublisher } from '../../src/adapters/publishers/youtube/youtube-mock.js';
import { InstagramMockPublisher } from '../../src/adapters/publishers/instagram/instagram-mock.js';
import { TikTokMockPublisher } from '../../src/adapters/publishers/tiktok/tiktok-mock.js';
import { MAX_FILE_BYTES } from '../../src/core/domain/r2-quota.js';
import { samplePost } from '../helpers/sample.mjs';

const SHA = 'ab'.repeat(32);

function verified(post, size = 100) {
  return {
    verified: 'r2-sha256',
    sha256: post.media.sha256,
    size_bytes: size,
    mime: post.media.mime,
  };
}

test('los tres mocks publican un asset verificado por head sin cuerpo', async () => {
  const youtube = new YouTubeMockPublisher({ store: new MemoryStore(), maxBytes: 20 * 1024 * 1024 });
  const big = samplePost({ media: { ...samplePost().media, sha256: SHA, size_bytes: MAX_FILE_BYTES, verified: 'r2-sha256' } });
  assert.equal((await youtube.validatePost(big)).ok, true);
  const uploaded = await youtube.uploadMedia(big, verified(big, MAX_FILE_BYTES));
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.duplicate, false);

  const plain = samplePost({ media: { ...samplePost().media, size_bytes: MAX_FILE_BYTES } });
  assert.equal((await youtube.validatePost(plain)).ok, false);
  const sniffed = await youtube.uploadMedia(samplePost({ idempotency_key: 'k-sniff' }), new Uint8Array(16));
  assert.equal(sniffed.ok, false);

  const mismatch = await youtube.uploadMedia(
    { ...big, idempotency_key: 'k-mismatch' },
    { ...verified(big, MAX_FILE_BYTES), sha256: 'cd'.repeat(32) },
  );
  assert.equal(mismatch.ok, false);

  const instagram = new InstagramMockPublisher({ store: new MemoryStore(), maxBytes: 20 * 1024 * 1024 });
  const reel = {
    publication_id: 'IG-1', batch_id: 'LOTE-IG0001', batch_version: 1, platform: 'instagram', content_type: 'reel',
    media: { sha256: SHA, mime: 'video/mp4', size_bytes: MAX_FILE_BYTES, verified: 'r2-sha256' },
    copy: { caption: 'Pieza' }, idempotency_key: 'ig-1',
  };
  assert.equal((await instagram.validatePost(reel)).ok, true);
  assert.equal((await instagram.uploadMedia(reel, verified(reel, MAX_FILE_BYTES))).ok, true);

  const tiktok = new TikTokMockPublisher({ store: new MemoryStore(), maxBytes: 20 * 1024 * 1024 });
  const clip = {
    publication_id: 'TT-1', batch_id: 'LOTE-TT0001', batch_version: 1, platform: 'tiktok', content_type: 'reel',
    media: { sha256: SHA, mime: 'video/mp4', size_bytes: MAX_FILE_BYTES, verified: 'r2-sha256' },
    copy: { caption: 'Pieza' }, idempotency_key: 'tt-1',
  };
  assert.equal((await tiktok.validatePost(clip)).ok, true);
  assert.equal((await tiktok.uploadMedia(clip, verified(clip, MAX_FILE_BYTES))).ok, true);
  const over = await tiktok.uploadMedia(
    { ...clip, idempotency_key: 'tt-over' },
    { ...verified(clip, MAX_FILE_BYTES + 1), size_bytes: MAX_FILE_BYTES + 1 },
  );
  assert.equal(over.ok, false);
});
