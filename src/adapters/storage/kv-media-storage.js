// Adaptador MediaStorage: bytes en Workers KV + índice en D1 (POC).
// KV es eventualmente consistente (list/get pueden tardar hasta ~60 s en otras ubicaciones), por eso
// la existencia y los metadatos se consultan en D1. Sustituible por R2MediaStorage con el mismo contrato.
// Límite de KV: 25 MiB por valor. Clave: media/<sha256>.
export class KvMediaStorage {
  constructor(kv, db) { this.kv = kv; this.db = db; this.kind = 'cloudflare-kv'; }
  async put(sha256, bytes, { mime, filename }) {
    const key = `media/${sha256}`;
    await this.kv.put(key, bytes, { metadata: { mime, filename, size_bytes: bytes.byteLength, sha256 } });
    await this.db.prepare('INSERT OR IGNORE INTO media_objects (sha256, storage, storage_key, mime, filename, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(sha256, this.kind, key, mime, filename, bytes.byteLength, new Date().toISOString()).run();
    return { key, size_bytes: bytes.byteLength, sha256, storage: this.kind };
  }
  async get(sha256) {
    const r = await this.kv.getWithMetadata(`media/${sha256}`, { type: 'arrayBuffer' });
    if (!r || r.value === null) return null; // puede ser propagación pendiente: el llamador reintenta
    return { bytes: new Uint8Array(r.value), ...(r.metadata ?? {}) };
  }
  async head(sha256) {
    return this.db.prepare('SELECT sha256, mime, filename, size_bytes, storage, storage_key FROM media_objects WHERE sha256 = ?').bind(sha256).first();
  }
}
