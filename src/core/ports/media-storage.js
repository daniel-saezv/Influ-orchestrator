// PUERTO: MediaStorage — almacenamiento de archivos multimedia finales.
// Implementaciones: KvMediaStorage (POC, Workers KV). Futuro: R2MediaStorage (mismo contrato).
//   put(sha256, bytes, { mime, filename }) -> { key, size_bytes, sha256 }
//   get(sha256)                            -> { bytes: Uint8Array, mime, filename, size_bytes } | null
//   head(sha256)                           -> { mime, filename, size_bytes } | null
export const MEDIA_STORAGE_METHODS = ['put', 'get', 'head'];
