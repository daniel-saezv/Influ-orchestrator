import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function mp4Bytes(path) { return new Uint8Array(readFileSync(path)); }
export const sha = (b) => createHash('sha256').update(b).digest('hex');

export function samplePost(over = {}) {
  return {
    publication_id: 'LOTE-TEST-V1-P01', batch_id: 'LOTE-TEST', batch_version: 1, platform: 'youtube', content_type: 'short_video',
    media: { sha256: 'a'.repeat(64), mime: 'video/mp4', size_bytes: 100, filename: 'x.mp4', duration_s: 8, width: 720, height: 1280 },
    copy: { title: 'Título', description: 'Descripción', tags: ['a'], hashtags: ['#x'], category_id: '22', privacy_status: 'public', made_for_kids: false, contains_synthetic_media: true },
    scheduled_at: new Date().toISOString(), idempotency_key: 'k1', ...over,
  };
}
