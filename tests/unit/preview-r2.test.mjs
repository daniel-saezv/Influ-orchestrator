import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWranglerR2, PREVIEW_BUCKET, PRODUCTION_BUCKET } from '../../deploy/ensure-r2-bucket.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('la preview no usa el bucket de producción', () => {
  const text = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  assert.doesNotThrow(() => assertWranglerR2(text));
  assert.match(text, new RegExp(`bucket_name = "${PRODUCTION_BUCKET}"`));
  assert.match(text, new RegExp(`bucket_name = "${PREVIEW_BUCKET}"`));
  const swapped = text.replace(
    '[[previews.r2_buckets]]\nbinding = "MEDIA_R2"\nbucket_name = "influ-poc-media-preview"',
    '[[previews.r2_buckets]]\nbinding = "MEDIA_R2"\nbucket_name = "influ-poc-media"',
  );
  assert.throws(() => assertWranglerR2(swapped), /producción/);
});
