import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWranglerR2, PREVIEW_BUCKET, PRODUCTION_BUCKET } from '../../deploy/ensure-r2-bucket.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('el bucket de producción solo se crea en el deploy de main', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  const ci = workflow.slice(workflow.indexOf('\n  ci:'), workflow.indexOf('\n  deploy:'));
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'), workflow.indexOf('\n  preview:'));
  const preview = workflow.slice(workflow.indexOf('\n  preview:'));
  assert.equal(ci.includes('ensure-r2-bucket.mjs'), false);
  assert.equal(deploy.includes('ensure-r2-bucket.mjs production'), true);
  assert.equal(preview.includes('ensure-r2-bucket.mjs preview'), true);
  assert.equal(preview.includes('ensure-r2-bucket.mjs production'), false);
});

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
