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

const PRODUCTION_ACCESS_AUD = '451e385e4fa58e74bc0f91981e92d9427ae34af5389d58bd62e81b36de3a8a8d';
const PREVIEW_ACCESS_AUD = '65a4c70c4dc51d0a7ba55ff3bd6395e32244c8092a994241d3e5efe880e6cd46';

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

test('el AUD de preview no pisa el de producción', () => {
  const text = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const marker = '[previews.vars]';
  const at = text.indexOf(marker);
  assert.ok(at > 0);
  assert.match(text.slice(0, at), new RegExp(`ACCESS_AUD = "${PRODUCTION_ACCESS_AUD}"`));
  assert.match(text.slice(at), new RegExp(`ACCESS_AUD = "${PREVIEW_ACCESS_AUD}"`));
  assert.doesNotMatch(text.slice(at), new RegExp(PRODUCTION_ACCESS_AUD));
});

test('lee la URL del JSON de wrangler preview aunque haya texto delante', () => {
  const text = `aviso previo\n{\n  "preview": {\n    "urls": ["https://pr-7-influ-poc-orchestrator.example.workers.dev"]\n  }\n}\n`;
  assert.equal(
    previewUrlFromWranglerOutput(text),
    'https://pr-7-influ-poc-orchestrator.example.workers.dev',
  );
});
