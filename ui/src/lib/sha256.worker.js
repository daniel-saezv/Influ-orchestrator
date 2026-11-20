import { HASH_CHUNK_BYTES, hashBlob } from './sha256.js'

self.onmessage = async (event) => {
  const { file, partSize, chunkSize } = event.data ?? {}
  try {
    const result = await hashBlob(file, { partSize, chunkSize: chunkSize || HASH_CHUNK_BYTES })
    self.postMessage({ ok: true, sha256: result.sha256, partHashes: result.partHashes })
  } catch {
    self.postMessage({ ok: false, message: 'No se pudo calcular la huella' })
  }
}
