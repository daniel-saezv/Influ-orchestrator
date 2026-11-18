const PREFIX = 'influ:upload-id:'

function storageOrNull() {
  if (typeof globalThis.localStorage === 'undefined') return null
  return globalThis.localStorage
}

export function getInterruptedUploadId(key) {
  return storageOrNull()?.getItem(`${PREFIX}${key}`) ?? null
}

export function rememberInterruptedUploadId(key, uploadId) {
  if (!key || !uploadId) return
  storageOrNull()?.setItem(`${PREFIX}${key}`, String(uploadId))
}

export function clearInterruptedUploadId(key) {
  storageOrNull()?.removeItem(`${PREFIX}${key}`)
}

