import { sha256Hex } from '../api/api.js'
import { HASH_CHUNK_BYTES, abortError } from './sha256.js'

let workerUnavailable = false

function browserWorker() {
  return new Worker(new URL('./sha256.worker.js', import.meta.url), { type: 'module' })
}

function hashInWorker(file, { partSize, signal, createWorker }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let worker
    try {
      worker = createWorker()
    } catch (error) {
      reject(error)
      return
    }
    if (!worker) {
      reject(new Error('worker'))
      return
    }
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate?.()
      fn(value)
    }
    const onAbort = () => finish(reject, abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event) => {
      const data = event.data
      if (data?.ok && typeof data.sha256 === 'string') {
        finish(resolve, { sha256: data.sha256, partHashes: data.partHashes ?? null })
        return
      }
      finish(reject, new Error(data?.message || 'worker'))
    }
    worker.onerror = (event) => {
      event?.preventDefault?.()
      finish(reject, new Error('worker'))
    }
    try {
      worker.postMessage({ file, partSize, chunkSize: HASH_CHUNK_BYTES })
    } catch (error) {
      finish(reject, error)
    }
  })
}

export async function hashFile(file, { partSize, signal, createWorker } = {}) {
  if (signal?.aborted) throw abortError()
  const custom = createWorker !== undefined
  const factory = custom ? createWorker : browserWorker
  const enabled = Boolean(factory) && (custom || (!workerUnavailable && typeof Worker === 'function'))
  if (enabled) {
    try {
      return await hashInWorker(file, { partSize, signal, createWorker: factory })
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError()
      if (!custom) workerUnavailable = true
    }
  }
  if (signal?.aborted) throw abortError()
  return { sha256: await sha256Hex(file), partHashes: null }
}
