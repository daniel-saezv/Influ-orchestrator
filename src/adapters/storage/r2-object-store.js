// Objetos de la persona en R2 Standard. El Worker no hashea el cuerpo:
// reenvía el SHA-256 que mandó el teléfono y se fía del checksum que devuelve R2.

function bytesToHex(buffer) {
  if (!buffer) return '';
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function hexToArrayBuffer(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

function checksumError(error) {
  const code = String(error?.code ?? error?.name ?? '');
  const message = String(error?.message ?? '').toLowerCase();
  return code === 'BadDigest' || code === 'CHECKSUM_MISMATCH'
    || message.includes('checksum') || message.includes('digest') || message.includes('sha-256') || message.includes('sha256');
}

export class R2ObjectStore {
  constructor(bucket) { this.bucket = bucket; }

  async put(key, body, { sha256, contentType }) {
    if (!this.bucket?.put) {
      const error = new Error('R2 binding missing');
      error.code = 'R2_UNAVAILABLE';
      throw error;
    }
    let obj;
    try {
      obj = await this.bucket.put(key, body, {
        sha256: hexToArrayBuffer(sha256),
        httpMetadata: { contentType: contentType || 'application/octet-stream' },
        storageClass: 'Standard',
      });
    } catch (error) {
      if (checksumError(error)) {
        const rejected = new Error('checksum');
        rejected.code = 'CHECKSUM_MISMATCH';
        throw rejected;
      }
      throw error;
    }
    const stored = bytesToHex(obj?.checksums?.sha256);
    if (stored.length !== 64) {
      await this.bucket.delete?.(key).catch(() => {});
      const rejected = new Error('checksum missing');
      rejected.code = 'CHECKSUM_MISMATCH';
      throw rejected;
    }
    return { key, size: Number(obj.size), sha256: stored, mime: obj.httpMetadata?.contentType ?? contentType };
  }

  async head(key) {
    if (!this.bucket?.head) {
      const error = new Error('R2 binding missing');
      error.code = 'R2_UNAVAILABLE';
      throw error;
    }
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return {
      key,
      size: Number(obj.size),
      sha256: bytesToHex(obj.checksums?.sha256),
      mime: obj.httpMetadata?.contentType ?? null,
    };
  }

  async get(key) {
    if (!this.bucket?.get) {
      const error = new Error('R2 binding missing');
      error.code = 'R2_UNAVAILABLE';
      throw error;
    }
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return {
      key,
      body: obj.body,
      size: Number(obj.size),
      sha256: bytesToHex(obj.checksums?.sha256),
      mime: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  async delete(key) {
    if (!this.bucket?.delete) {
      const error = new Error('R2 binding missing');
      error.code = 'R2_UNAVAILABLE';
      throw error;
    }
    await this.bucket.delete(key);
  }
}
