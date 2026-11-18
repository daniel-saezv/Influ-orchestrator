import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_D1_ID,
  PRODUCTION_D1_NAME,
  PREVIEW_D1_NAME,
  assertMigrationsConfig,
  patchPreviewDatabaseId,
} from '../../deploy/ensure-preview-d1.mjs';
import { previewCommentBody, PREVIEW_COMMENT_MARKER } from '../../deploy/preview-pr-comment.mjs';
import { previewUrlFromWranglerOutput } from '../../deploy/preview-url.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const previewId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const sample = `[[d1_databases]]
binding = "DB"
database_name = "${PRODUCTION_D1_NAME}"
database_id = "${PRODUCTION_D1_ID}"

[[previews.d1_databases]]
binding = "DB"
database_name = "${PREVIEW_D1_NAME}"
database_id = "00000000-0000-4000-8000-000000000001"
`;

test('el id de preview sustituye solo el binding de preview', () => {
  const next = patchPreviewDatabaseId(sample, previewId);
  assert.match(next, new RegExp(`database_name = "${PREVIEW_D1_NAME}"\ndatabase_id = "${previewId}"`));
  assert.match(next, new RegExp(`database_name = "${PRODUCTION_D1_NAME}"\ndatabase_id = "${PRODUCTION_D1_ID}"`));
});

test('rechaza usar el id de producción como D1 de preview', () => {
  assert.throws(() => patchPreviewDatabaseId(sample, PRODUCTION_D1_ID), /producción/);
});

test('la config de migraciones del repo solo nombra la D1 de preview', () => {
  const text = readFileSync(join(root, 'wrangler.preview-d1.toml'), 'utf8');
  assertMigrationsConfig(text);
  assert.doesNotMatch(text, /influ-poc-db"/);
});

test('wrangler.toml de producción conserva su database_id', () => {
  const text = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.match(text, new RegExp(`database_name = "${PRODUCTION_D1_NAME}"\ndatabase_id = "${PRODUCTION_D1_ID}"`));
  assert.match(text, /database_name = "influ-poc-db-preview"/);
});

test('el comentario de preview es único y lleva URL y SHA', () => {
  const sha = 'a'.repeat(40);
  const body = previewCommentBody({ url: 'https://pr-1-influ-poc-orchestrator.example.workers.dev', sha });
  assert.equal(body.split(PREVIEW_COMMENT_MARKER).length, 2);
  assert.match(body, /https:\/\/pr-1-influ-poc-orchestrator\.example\.workers\.dev/);
  assert.match(body, new RegExp(sha));
  assert.match(body, /influ-poc-db-preview/);
});

test('lee la URL del JSON de wrangler preview aunque haya texto delante', () => {
  const text = `aviso previo\n{\n  "preview": {\n    "urls": ["https://pr-7-influ-poc-orchestrator.example.workers.dev"]\n  }\n}\n`;
  assert.equal(
    previewUrlFromWranglerOutput(text),
    'https://pr-7-influ-poc-orchestrator.example.workers.dev',
  );
});
