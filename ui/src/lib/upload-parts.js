import { abortError } from './sha256.js'

export const UPLOAD_CONCURRENCY = 3
export const UPLOAD_ATTEMPTS = 3

const RETRYABLE = new Set([0, 408, 429, 502, 503, 504])

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function sendPart({ number, blob, sha256, signal, attempts, uploadPart, wait }) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError()
    try {
      last = await uploadPart(number, blob, sha256, { signal })
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw abortError()
      last = {
        ok: false,
        status: 0,
        error: { code: 'NETWORK_ERROR', message: 'No se puede conectar con Influe. Inténtalo otra vez.' },
      }
    }
    if (last?.ok || !RETRYABLE.has(last?.status) || attempt === attempts) return last
    await wait(200 * attempt, signal)
  }
  return last
}

export async function uploadParts({
  source,
  partSize,
  partHashes = null,
  uploadedParts = new Set(),
  concurrency = UPLOAD_CONCURRENCY,
  attempts = UPLOAD_ATTEMPTS,
  signal,
  uploadPart,
  onPartDone,
  wait = delay,
}) {
  if (signal?.aborted) throw abortError()
  const partCount = Math.ceil(source.size / partSize)
  const pending = []
  for (let index = 0; index < partCount; index += 1) {
    const number = index + 1
    if (uploadedParts.has(number)) {
      onPartDone?.(number)
      continue
    }
    pending.push(number)
  }
  let next = 0
  let failure = null
  const run = async () => {
    while (failure == null && !signal?.aborted) {
      const cursor = next
      next += 1
      if (cursor >= pending.length) return
      const number = pending[cursor]
      const start = (number - 1) * partSize
      const blob = source.slice(start, Math.min(start + partSize, source.size))
      const outcome = await sendPart({
        number,
        blob,
        sha256: partHashes?.[number - 1],
        signal,
        attempts,
        uploadPart,
        wait,
      })
      if (signal?.aborted) return
      if (!outcome?.ok) {
        failure = outcome
        return
      }
      onPartDone?.(number)
    }
  }
  const width = Math.max(0, Math.min(concurrency, pending.length))
  await Promise.all(Array.from({ length: width }, () => run()))
  if (signal?.aborted) throw abortError()
  if (failure) return failure
  return { ok: true }
}
