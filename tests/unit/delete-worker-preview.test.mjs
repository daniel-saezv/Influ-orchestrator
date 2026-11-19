import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteWorkerPreviewByName,
  findPreviewByName,
  isPreviewNotFound,
  workerNameFromWranglerToml,
} from '../../deploy/delete-worker-preview.mjs';

test('isPreviewNotFound reconoce 404 y códigos 10025/10222', () => {
  assert.equal(isPreviewNotFound(404, []), true);
  assert.equal(isPreviewNotFound(403, [{ code: 10025 }]), true);
  assert.equal(isPreviewNotFound(403, [{ message: 'No access' }]), false);
});

test('findPreviewByName enlaza por name o slug', () => {
  const rows = [
    { id: 'p1', name: 'pr-39', slug: 'pr-39' },
    { id: 'p2', name: 'otra', slug: 'otra-slug' },
  ];
  assert.equal(findPreviewByName(rows, 'pr-39')?.id, 'p1');
  assert.equal(findPreviewByName(rows, 'otra-slug')?.id, 'p2');
  assert.equal(findPreviewByName(rows, 'inexistente'), undefined);
});

test('workerNameFromWranglerToml lee el nombre del Worker', () => {
  const name = workerNameFromWranglerToml('name = "influ-poc-orchestrator"\nmain = "src/worker.js"\n');
  assert.equal(name, 'influ-poc-orchestrator');
});

test('deleteWorkerPreviewByName lista, resuelve id y borra', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/previews') && init?.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [{ id: 'preview-uuid-39', name: 'pr-39', slug: 'pr-39' }],
        }),
      };
    }
    if (url.includes('/previews/preview-uuid-39') && init?.method === 'DELETE') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: null }),
      };
    }
    throw new Error(`fetch inesperado: ${init?.method} ${url}`);
  };
  const outcome = await deleteWorkerPreviewByName({
    accountId: 'acc',
    token: 'tok',
    workerName: 'influ-poc-orchestrator',
    previewName: 'pr-39',
    fetchFn,
  });
  assert.equal(outcome.status, 'deleted');
  assert.equal(outcome.previewId, 'preview-uuid-39');
  assert.equal(calls.at(-1)?.method, 'DELETE');
  assert.match(calls.at(-1)?.url, /previews\/preview-uuid-39$/);
});

test('deleteWorkerPreviewByName termina absent si no hay coincidencia', async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [] }),
  });
  const outcome = await deleteWorkerPreviewByName({
    accountId: 'acc',
    token: 'tok',
    workerName: 'influ-poc-orchestrator',
    previewName: 'pr-99',
    fetchFn,
  });
  assert.equal(outcome.status, 'absent');
});

test('deleteWorkerPreviewByName propaga errores distintos de preview ausente', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      success: false,
      errors: [{ message: 'No access to the specified resource.' }],
    }),
  });
  await assert.rejects(
    () =>
      deleteWorkerPreviewByName({
        accountId: 'acc',
        token: 'tok',
        workerName: 'influ-poc-orchestrator',
        previewName: 'pr-39',
        fetchFn,
      }),
    /No access/
  );
});