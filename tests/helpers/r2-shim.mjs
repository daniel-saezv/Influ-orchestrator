// Doble del binding R2. Hashea en el proceso de pruebas, nunca en el Worker.
import { createHash } from 'node:crypto';

async function readAll(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  const response = new Response(value);
  return new Uint8Array(await response.arrayBuffer());
}

function asBuffer(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

export function createR2Shim() {
  const objects = new Map();
  const failDelete = new Set();
  return {
    objects,
    failDelete,
    puts: 0,
    async put(key, value, options = {}) {
      this.puts += 1;
      const bytes = Buffer.from(await readAll(value));
      const hash = createHash('sha256').update(bytes).digest();
      if (options.sha256) {
        const given = asBuffer(options.sha256);
        if (!given.equals(hash)) {
          const error = new Error('The SHA-256 checksum you specified did not match');
          error.code = 'BadDigest';
          throw error;
        }
      }
      if (options.storageClass && options.storageClass !== 'Standard') {
        throw new Error(`storage class ${options.storageClass}`);
      }
      const checksum = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
      const stored = { bytes, httpMetadata: options.httpMetadata ?? {}, checksums: { sha256: checksum } };
      objects.set(key, stored);
      return { key, size: bytes.byteLength, checksums: stored.checksums, httpMetadata: stored.httpMetadata };
    },
    async head(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { key, size: stored.bytes.byteLength, checksums: stored.checksums, httpMetadata: stored.httpMetadata };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key,
        size: stored.bytes.byteLength,
        body: stored.bytes,
        checksums: stored.checksums,
        httpMetadata: stored.httpMetadata,
      };
    },
    async delete(key) {
      if (failDelete.has(key)) throw new Error(`delete failed ${key}`);
      objects.delete(key);
    },
  };
}
