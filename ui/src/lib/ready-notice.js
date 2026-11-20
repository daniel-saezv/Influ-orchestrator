const STORAGE_KEY = 'influ-ready-notice'

function storageGet(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function storageSet(storage, value) {
  try {
    storage?.setItem(STORAGE_KEY, value)
  } catch {
    return false
  }
  return true
}

export function shouldAnnounceReady({ notModified, previousStatus, nextStatus }) {
  if (notModified) return false
  return nextStatus === 'ready' && previousStatus !== 'ready'
}

export function readyNoticeCopy(title) {
  const line = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const message = line ? `«${line}» está lista` : 'Tu toma está lista'
  return { title: 'Tu toma está lista', message }
}

export function shouldAskForNotices(notificationApi = globalThis.Notification, storage = globalThis.localStorage) {
  if (!notificationApi || typeof notificationApi.requestPermission !== 'function') return false
  if (notificationApi.permission === 'granted' || notificationApi.permission === 'denied') return false
  const choice = storageGet(storage)
  if (choice === 'dismissed' || choice === 'denied' || choice === 'granted') return false
  return notificationApi.permission === 'default' || notificationApi.permission == null
}

export function noticesGranted(notificationApi = globalThis.Notification) {
  return notificationApi?.permission === 'granted'
}

export function dismissReadyNotices(storage = globalThis.localStorage) {
  storageSet(storage, 'dismissed')
}

export async function requestReadyNotices(notificationApi = globalThis.Notification, storage = globalThis.localStorage) {
  if (!notificationApi || typeof notificationApi.requestPermission !== 'function') return 'unsupported'
  try {
    const result = await notificationApi.requestPermission()
    storageSet(storage, result === 'granted' ? 'granted' : 'denied')
    return result
  } catch {
    return 'unsupported'
  }
}

export function notifyReadyEncargo({ title, encargoId, notificationApi = globalThis.Notification, focus = () => window.focus() }) {
  const copy = readyNoticeCopy(title)
  let browser = false
  if (noticesGranted(notificationApi)) {
    try {
      const note = new notificationApi(copy.title, {
        body: copy.message,
        tag: encargoId ? `encargo-ready-${encargoId}` : 'encargo-ready',
      })
      note.onclick = () => {
        focus()
        note.close?.()
      }
      browser = true
    } catch {
      browser = false
    }
  }
  return { ...copy, browser }
}
