import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  pollEncargoOnce,
  syntheticForEncargo,
  verifyEncargoIntegrity,
} from './client-lib.mjs';

test('poll empty queue does not claim or generate', async () => {
  let generated = 0;
  let claimed = 0;
  const client = {
    async getQueuedEncargos() { return { ok: true, data: { items: [] } }; },
    async claimEncargo() { claimed++; return { ok: true }; },
  };
  const result = await pollEncargoOnce(client, { generate: async () => { generated++; } });
  assert.equal(result.generated, false);
  assert.equal(claimed, 0);
  assert.equal(generated, 0);
});

test('from_scratch is synthetic and edit crop is not', () => {
  assert.equal(syntheticForEncargo({ kind: 'from_scratch' }), true);
  assert.equal(syntheticForEncargo({ kind: 'edit' }, { operation: 'crop', synthetic: false }), false);
  assert.equal(syntheticForEncargo({ kind: 'edit' }, { altered: true }), true);
});

test('sin generador no reclama ni llama a Imagine', async () => {
  let claimed = 0;
  let submitted = 0;
  const client = {
    async getQueuedEncargos() { return { ok: true, data: { encargos: [{ encargo_id: 'enc-1', kind: 'from_scratch' }] } }; },
    async claimEncargo() { claimed += 1; return { ok: true }; },
    async submitEncargoResult() { submitted += 1; return { ok: true }; },
  };
  const result = await pollEncargoOnce(client);
  assert.equal(result.generated, false);
  assert.equal(result.error.code, 'GENERATOR_NOT_CONFIGURED');
  assert.equal(claimed, 0);
  assert.equal(submitted, 0);
});

test('integrity mismatch prevents generation', async () => {
  const bytes = Buffer.from('correctos');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let generated = 0;
  let failedResult;
  const encargo = {
    id: 'enc-1',
    kind: 'from_scratch',
    sha256,
    assets: [{ r2_key: 'source/a.bin', sha256: 'incorrecto', size_bytes: bytes.length }],
  };
  const client = {
    async getQueuedEncargos() { return { ok: true, data: { items: [encargo] } }; },
    async claimEncargo() { return { ok: true, data: { encargo } }; },
    async submitEncargoResult(id, body) { failedResult = { id, body }; return { ok: true }; },
  };
  const result = await pollEncargoOnce(client, {
    head: async () => ({ sha256: 'incorrecto', size_bytes: bytes.length }),
    get: async () => bytes,
    generate: async () => { generated++; return { batch: 'LOTE-1' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(generated, 0);
  assert.equal(failedResult.body.failed, true);
});

test('un SHA-256 de archivo que no cuadra no genera y se informa el hash recalculado', async () => {
  const bytes = Buffer.from('archivo');
  const partSha = createHash('sha256').update(bytes).digest('hex');
  const fileSha = createHash('sha256').update(bytes).digest('hex');
  let generated = 0;
  let failedResult;
  const encargo = {
    encargo_id: 'enc-2',
    kind: 'edit',
    file_sha256: 'ab'.repeat(32),
    assets: [{ role: 'source', r2_key: 'pending/a', sha256: partSha, size_bytes: bytes.length }],
  };
  const client = {
    async getQueuedEncargos() { return { ok: true, data: { encargos: [encargo] } }; },
    async claimEncargo() { return { ok: true, data: { encargo } }; },
    async submitEncargoResult(id, body) { failedResult = { id, body }; return { ok: false, status: 409 }; },
  };
  const result = await pollEncargoOnce(client, {
    head: async () => ({ sha256: partSha, size_bytes: bytes.length }),
    get: async () => bytes,
    generate: async () => { generated += 1; return { content_hash: 'cd'.repeat(32) }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'integrity');
  assert.equal(generated, 0);
  assert.equal(failedResult.body.failed, true);
  assert.equal(failedResult.body.file_sha256, fileSha);
  assert.equal(failedResult.body.error.code, 'INTEGRITY_FILE_MISMATCH');
});

test('integrity joins parts and recalculates the file sha256', async () => {
  const a = Buffer.from('hola ');
  const b = Buffer.from('mundo');
  const fileSha = createHash('sha256').update(Buffer.concat([a, b])).digest('hex');
  const result = await verifyEncargoIntegrity({
    sha256: fileSha,
    assets: [
      { r2_key: 'a', sha256: createHash('sha256').update(a).digest('hex') },
      { r2_key: 'b', sha256: createHash('sha256').update(b).digest('hex') },
    ],
  }, {
    head: async (key) => ({ sha256: createHash('sha256').update(key === 'a' ? a : b).digest('hex') }),
    get: async (key) => key === 'a' ? a : b,
  });
  assert.equal(result.sha256, fileSha);
  assert.equal(result.sizeBytes, 10);
});
