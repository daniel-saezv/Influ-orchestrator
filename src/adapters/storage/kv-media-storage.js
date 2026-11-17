// Adaptador MediaStorage sobre Workers KV (POC). Sustituible por R2 con el mismo contrato.
// Límite de KV: 25 MiB por valor. Clave: media/<sha256>.
export class KvMediaStorage {
  constructor(kv) { this.kv = kv; this.kind = 'cloudflare-kv'; }
  async put(sha256, bytes, { mime, filename }) {
    await this.kv.put(`media/${sha256}`, bytes, { metadata: { mime, filename, size_bytes: bytes.byteLength, sha256 } });
    return { key: `media/${sha256}`, size_bytes: bytes.byteLength, sha256 };
  }
  async get(sha256) {
    const r = await this.kv.getWithMetadata(`media/${sha256}`, { type: 'arrayBuffer' });
    if (!r || r.value === null) return null;
    return { bytes: new Uint8Array(r.value), ...(r.metadata ?? {}) };
  }
  async head(sha256) {
    // KV no tiene HEAD; list con prefijo exacto devuelve los metadatos sin leer el valor.
    const r = await this.kv.list({ prefix: `media/${sha256}`, limit: 1 });
    const k = r.keys.find((x) => x.name === `media/${sha256}`);
    return k ? (k.metadata ?? {}) : null;
  }
}
