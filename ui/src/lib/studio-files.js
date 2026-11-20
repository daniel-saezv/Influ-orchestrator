import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'influ-studio-files'
const memory = new Map()
const listeners = new Set()

let restored = false
let snapshot = { encargoId: null, files: [] }

function fileKey(file) {
  return `${file.name}\0${file.size}\0${file.lastModified}\0${file.type}`
}

function writeStore(next) {
  try {
    if (!next.files.length) sessionStorage.removeItem(STORAGE_KEY)
    else {
      const rows = next.files.map((entry) => ({
      key: entry.key,
      name: entry.name,
      size: entry.size,
      type: entry.type,
      lastModified: entry.lastModified,
      sha256: entry.sha256,
      uploadId: entry.uploadId,
      encargoId: entry.encargoId,
      complete: entry.complete,
    }))
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ encargoId: next.encargoId, files: rows }))
    }
  } catch {
    return false
  }
  return true
}

function publish(next) {
  snapshot = next
  writeStore(next)
  for (const listener of listeners) listener()
}

function hydrate(row) {
  if (!row || typeof row.key !== 'string' || typeof row.name !== 'string') return null
  const size = Number(row.size)
  if (!Number.isSafeInteger(size) || size < 0) return null
  return {
    key: row.key,
    name: row.name,
    size,
    type: typeof row.type === 'string' ? row.type : '',
    lastModified: Number(row.lastModified) || 0,
    sha256: typeof row.sha256 === 'string' ? row.sha256 : null,
    uploadId: typeof row.uploadId === 'string' ? row.uploadId : null,
    encargoId: typeof row.encargoId === 'string' ? row.encargoId : null,
    complete: row.complete === true,
    file: memory.get(row.key) ?? null,
  }
}

export function restoreStudioFiles() {
  if (restored) return snapshot
  restored = true
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return snapshot
    const data = JSON.parse(raw)
    const files = (Array.isArray(data?.files) ? data.files : []).map(hydrate).filter(Boolean)
    snapshot = {
      encargoId: typeof data?.encargoId === 'string' ? data.encargoId : files.find((item) => item.encargoId)?.encargoId ?? null,
      files,
    }
  } catch {
    snapshot = { encargoId: null, files: [] }
  }
  return snapshot
}

export function resetStudioFiles() {
  memory.clear()
  restored = false
  snapshot = { encargoId: null, files: [] }
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    restored = false
  }
  for (const listener of listeners) listener()
}

export function currentStudioFiles() {
  return snapshot
}

function freshEntry(file, key) {
  return {
    key,
    file,
    name: file.name,
    size: file.size,
    type: file.type || '',
    lastModified: file.lastModified || 0,
    sha256: null,
    uploadId: null,
    encargoId: snapshot.encargoId,
    complete: false,
  }
}

export function replaceStudioFiles(fileList) {
  restoreStudioFiles()
  const next = []
  const seen = new Set()
  for (const file of fileList) {
    const key = fileKey(file)
    seen.add(key)
    memory.set(key, file)
    const previous = snapshot.files.find((item) => item.key === key)
    next.push(previous
      ? { ...previous, file, name: file.name, size: file.size, type: file.type || previous.type, lastModified: file.lastModified || previous.lastModified }
      : freshEntry(file, key))
  }
  const removed = snapshot.files.filter((item) => !seen.has(item.key))
  for (const item of removed) memory.delete(item.key)
  publish({ encargoId: snapshot.encargoId, files: next })
  return removed
}

export function removeStudioFile(key) {
  const removed = snapshot.files.find((item) => item.key === key) ?? null
  if (!removed) return null
  memory.delete(key)
  const files = snapshot.files.filter((item) => item.key !== key)
  const encargoId = files.some((item) => item.encargoId === snapshot.encargoId) ? snapshot.encargoId : (files.find((item) => item.encargoId)?.encargoId ?? null)
  publish({ encargoId, files })
  return removed
}

export function noteStudioUpload(key, { uploadId, encargoId }) {
  publish({
    encargoId: encargoId ?? snapshot.encargoId,
    files: snapshot.files.map((item) => (item.key === key
      ? { ...item, uploadId, encargoId: encargoId ?? item.encargoId, file: memory.get(key) ?? item.file }
      : item)),
  })
}

export function markStudioUploaded(key, { sha256, uploadId, encargoId }) {
  publish({
    encargoId: encargoId ?? snapshot.encargoId,
    files: snapshot.files.map((item) => (item.key === key
      ? {
        ...item,
        sha256,
        uploadId,
        encargoId: encargoId ?? item.encargoId,
        complete: true,
        file: memory.get(key) ?? item.file,
      }
      : item)),
  })
}

export function bindStudioEncargo(encargoId) {
  publish({
    encargoId,
    files: snapshot.files.map((item) => ({
      ...item,
      encargoId: item.complete ? item.encargoId : encargoId,
      file: memory.get(item.key) ?? item.file,
    })),
  })
}

export function clearStudioFiles() {
  memory.clear()
  publish({ encargoId: null, files: [] })
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStudioFiles() {
  restoreStudioFiles()
  const state = useSyncExternalStore(subscribe, currentStudioFiles, currentStudioFiles)
  return state
}
