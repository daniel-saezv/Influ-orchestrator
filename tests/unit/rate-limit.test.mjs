import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceRateLimit, normalizeRateLimitClientKey } from '../../src/adapters/http/rate-limit.js';
import { createD1Shim } from '../helpers/d1-shim.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = createD1Shim(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations'));

test('normalizeRateLimitClientKey: IPv4 exacta', () => {
  assert.equal(normalizeRateLimitClientKey('192.0.2.47'), '192.0.2.47');
});

test('normalizeRateLimitClientKey: IPv6 comprimida → prefijo /64', () => {
  const base = '2001:db8:85a3:1';
  assert.equal(normalizeRateLimitClientKey(`${base}::1`), 'v6-64:2001:0db8:85a3:0001');
  assert.equal(normalizeRateLimitClientKey(`${base}::dead:beef`), 'v6-64:2001:0db8:85a3:0001');
});

test('normalizeRateLimitClientKey: IPv6 expandida completa', () => {
  assert.equal(
    normalizeRateLimitClientKey('2001:0db8:85a3:0001:0000:0000:0000:00ab'),
    'v6-64:2001:0db8:85a3:0001',
  );
});

test('normalizeRateLimitClientKey: acepta mayúsculas', () => {
  assert.equal(
    normalizeRateLimitClientKey('2001:0DB8:0005:0001:0000:0000:0000:0001'),
    'v6-64:2001:0db8:0005:0001',
  );
});

test('normalizeRateLimitClientKey: IPv4-mapeada ::ffff:', () => {
  assert.equal(normalizeRateLimitClientKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeRateLimitClientKey('::FFFF:192.0.2.44'), '192.0.2.44');
});

test('normalizeRateLimitClientKey: vacío o inválido → unknown', () => {
  assert.equal(normalizeRateLimitClientKey(''), 'unknown');
  assert.equal(normalizeRateLimitClientKey('   '), 'unknown');
  assert.equal(normalizeRateLimitClientKey(null), 'unknown');
  assert.equal(normalizeRateLimitClientKey('not-an-ip'), 'unknown');
  assert.equal(normalizeRateLimitClientKey('999.999.999.999'), 'unknown');
});

test('rate limit: bloquea tras superar el máximo por ventana', async () => {
  const bucket = 'test:127.0.0.1';
  await enforceRateLimit(db, bucket, 3);
  await enforceRateLimit(db, bucket, 3);
  await enforceRateLimit(db, bucket, 3);
  await assert.rejects(() => enforceRateLimit(db, bucket, 3), (e) => e.code === 'RATE_LIMITED');
});

test('rate limit: varias IPv6 del mismo /64 comparten bucket', async () => {
  const key = normalizeRateLimitClientKey('2001:db8:aa01::10');
  const bucket = `health:${key}`;
  assert.equal(normalizeRateLimitClientKey('2001:db8:aa01::99'), key);
  await enforceRateLimit(db, bucket, 2);
  await enforceRateLimit(db, bucket, 2);
  await assert.rejects(() => enforceRateLimit(db, bucket, 2), (e) => e.code === 'RATE_LIMITED');
});