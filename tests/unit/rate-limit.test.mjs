import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceRateLimit } from '../../src/adapters/http/rate-limit.js';
import { createD1Shim } from '../helpers/d1-shim.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = createD1Shim(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations'));

test('rate limit: bloquea tras superar el máximo por ventana', async () => {
  const bucket = 'test:127.0.0.1';
  await enforceRateLimit(db, bucket, 3);
  await enforceRateLimit(db, bucket, 3);
  await enforceRateLimit(db, bucket, 3);
  await assert.rejects(() => enforceRateLimit(db, bucket, 3), (e) => e.code === 'RATE_LIMITED');
});