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

export function seedObject(shim, key, bytes, { contentType = 'application/octet-stream', sha256 = false } = {}) {
  const buf = Buffer.from(bytes);
  const md5 = createHash('md5').update(buf).digest();
  const checksums = { md5: md5.buffer.slice(md5.byteOffset, md5.byteOffset + md5.byteLength) };
  if (sha256) {
    const hash = createHash('sha256').update(buf).digest();
    checksums.sha256 = hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
  }
  shim.objects.set(key, { bytes: buf, httpMetadata: { contentType }, checksums });
  return { md5: md5.toString('base64'), sha256: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength };
}

export function createR2Shim() {
  const objects = new Map();
  const failDelete = new Set();
  return {
    objects,
    failDelete,
    puts: 0,
    gets: 0,
    async put(key, value, options = {}) {
      this.puts += 1;
      const bytes = Buffer.from(await readAll(value));
      const hash = createHash('sha256').update(bytes).digest();
      const md5 = createHash('md5').update(bytes).digest();
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
      const md5sum = md5.buffer.slice(md5.byteOffset, md5.byteOffset + md5.byteLength);
      const stored = { bytes, httpMetadata: options.httpMetadata ?? {}, checksums: { sha256: checksum, md5: md5sum } };
      objects.set(key, stored);
      return { key, size: bytes.byteLength, checksums: stored.checksums, httpMetadata: stored.httpMetadata };
    },
    async head(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { key, size: stored.bytes.byteLength, checksums: stored.checksums, httpMetadata: stored.httpMetadata };
    },
    async get(key) {
      this.gets += 1;
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
