import {
  clearInterruptedUploadId,
  getInterruptedUploadId,
  rememberInterruptedUploadId,
} from '../lib/upload-session-storage.js'

export const MIB = 1024 * 1024
export const MAX_FILE_BYTES = 150 * MIB
export const MAX_USER_BYTES = 300 * MIB
export const MAX_GLOBAL_BYTES = 6 * 1024 * MIB
export const PART_SIZE_BYTES = 5 * MIB
export const FAKE_ACCESS_EMAIL = 'persona@example.test'
export const OTHER_FAKE_ACCESS_EMAIL = 'otra-persona@example.test'
export const FETCH_CREDENTIALS = 'same-origin'
export const PROCESSING_STATES = ['queued', 'preparing', 'ready']
export const PLATFORMS = ['youtube', 'instagram', 'tiktok']

const sleep = () => Promise.resolve()
let activeEmail = FAKE_ACCESS_EMAIL
let nowValue = Date.parse('2026-11-18T12:00:00.000Z')
let sequence = 0
let state
let options

function newState() {
  return {
    users: new Map(),
    accounts: new Map(),
    encargos: new Map(),
    uploads: new Map(),
    uploadHashes: new Map(),
    media: new Map(),
    activity: new Map(),
    reservedBytes: 0,
  }
}

function createUser(email, displayName, withAccount = false) {
  const id = `usr-${email === OTHER_FAKE_ACCESS_EMAIL ? 'other' : '001'}`
  state.users.set(email, {
    id,
    email,
    display_name: displayName,
    time_zone: 'Europe/Madrid',
    guide_seen_at: displayName ? '2026-11-18T10:00:00.000Z' : null,
  })
  if (withAccount) createAccountInternal(id, displayName ? `${displayName} Studio` : 'Mi cuenta', email)
  return state.users.get(email)
}

function createAccountInternal(userId, name, email) {
  const account = {
    id: `acc-${String(state.accounts.size + 1).padStart(3, '0')}`,
    user_id: userId,
    owner_email: email,
    name,
  }
  state.accounts.set(account.id, account)
  return account
}

export function resetFakeApi({ onboarded = false, seedOtherAccount = false } = {}) {
  sequence = 0
  nowValue = Date.parse('2026-11-18T12:00:00.000Z')
  options = { initialGlobalBytes: 0, transitionReads: 1 }
  state = newState()
  activeEmail = FAKE_ACCESS_EMAIL
  createUser(FAKE_ACCESS_EMAIL, onboarded ? 'Alex' : '', onboarded)
  if (seedOtherAccount) {
    const other = createUser(OTHER_FAKE_ACCESS_EMAIL, 'Sam', true)
    const account = [...state.accounts.values()].find((item) => item.user_id === other.id)
    state.encargos.set('enc-other', {
      id: 'enc-other',
      account_id: account.id,
      kind: 'from_scratch',
      note: 'Privado',
      platforms: ['youtube'],
      status: 'ready',
      version: 1,
      fingerprint: 'fp-other',
      synthetic: true,
      preview: {
        sha256: 'media-other',
        media_url: '/v1/me/media/media-other',
        mime: 'video/mp4',
        width: 1080,
        height: 1920,
      },
      approved: false,
      publish_at: null,
      source_sha256: null,
      created_at: '2026-11-18T10:00:00.000Z',
      reads: 2,
      manualBytes: 0,
      released: false,
    })
    state.media.set('media-other', { owner_user_id: other.id, encargo_id: 'enc-other', size: MIB })
    state.activity.set(account.id, [{
      id: 'event-other',
      encargo_id: 'enc-other',
      platform: 'youtube',
      published_at: '2026-11-18T10:00:00.000Z',
      mock_id: 'MOCK-YOUTUBE-OTHER',
      status: 'mock_scheduled',
    }])
  }
}

resetFakeApi()

export function configureFakeApi(next = {}) {
  options = { ...options, ...next }
  if (Number.isFinite(next.now)) nowValue = next.now
  if (Number.isFinite(next.nowMs)) nowValue = next.nowMs
  if (Number.isFinite(next.initialGlobalBytes)) state.reservedBytes = next.initialGlobalBytes
}

export function getFakeApiState() {
  const valueOf = (map) => [...map.values()].map((item) => ({ ...item }))
  return {
    activeEmail,
    options: { ...options },
    users: valueOf(state.users),
    accounts: valueOf(state.accounts),
    encargos: valueOf(state.encargos),
    uploads: valueOf(state.uploads),
    uploadHashes: valueOf(state.uploadHashes),
    media: valueOf(state.media),
    activity: Object.fromEntries([...state.activity].map(([key, value]) => [key, [...value]])),
    reservedBytes: state.reservedBytes,
  }
}

function success(data, status = 200) {
  return { ok: true, status, data }
}

function failure(status, code, message) {
  return { ok: false, status, error: { code, message } }
}

function missing() {
  return failure(404, 'NOT_FOUND', 'No encontrado.')
}

function badRequest(message) {
  return failure(400, 'INVALID_REQUEST', message)
}

function tooLarge(message) {
  return failure(413, 'PAYLOAD_TOO_LARGE', message)
}

function tick() {
  nowValue += 1000
  return new Date(nowValue).toISOString()
}

function publicAccount(account) {
  return { id: account.id, name: account.name }
}

function currentUser() {
  return state.users.get(activeEmail)
}

function requireUserAccount(accountId) {
  const account = state.accounts.get(String(accountId))
  return account?.user_id === currentUser()?.id ? account : null
}

function requireEncargo(encargoId) {
  const encargo = state.encargos.get(String(encargoId))
  return encargo && requireUserAccount(encargo.account_id) ? encargo : null
}

function usedByUser() {
  let bytes = 0
  for (const upload of state.uploads.values()) {
    if (upload.user_id === currentUser()?.id && !upload.released) bytes += upload.size
  }
  return bytes
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    name: user.display_name,
    time_zone: user.time_zone,
    guide_required: !user.guide_seen_at,
    needs_guide: !user.guide_seen_at,
    accounts: [...state.accounts.values()]
      .filter((account) => account.user_id === user.id)
      .map(publicAccount),
  }
}

async function getMe() {
  await sleep()
  return success(publicUser(currentUser()))
}

async function createMe(input = {}) {
  await sleep()
  const name = String(input.display_name ?? input.name ?? '').trim()
  const timeZone = String(input.time_zone ?? input.timeZone ?? '').trim()
  if (!name || !timeZone) return badRequest('Se necesitan nombre y zona horaria.')
  const user = currentUser()
  user.display_name = name
  user.time_zone = timeZone
  user.guide_seen_at = tick()
  if (![...state.accounts.values()].some((account) => account.user_id === user.id)) {
    const account = createAccountInternal(user.id, name, activeEmail)
    return success({ ...publicUser(user), created_account: publicAccount(account) }, 201)
  }
  return success(publicUser(user), 201)
}

async function updateMe(input = {}) {
  await sleep()
  const name = String(input.display_name ?? input.name ?? '').trim()
  if (!name) return badRequest('El nombre no puede estar vacío.')
  currentUser().display_name = name
  return success(publicUser(currentUser()))
}

async function createAccount(input = {}) {
  await sleep()
  const name = String(input.name ?? '').trim()
  if (!name) return badRequest('El nombre de la cuenta no puede estar vacío.')
  const user = currentUser()
  const account = createAccountInternal(user.id, name, activeEmail)
  return success(publicAccount(account), 201)
}

async function updateAccount(accountId, input = {}) {
  await sleep()
  const account = requireUserAccount(accountId)
  if (!account) return missing()
  const name = String(input.name ?? '').trim()
  if (!name) return badRequest('El nombre de la cuenta no puede estar vacío.')
  account.name = name
  return success(publicAccount(account))
}

function normalisePlatforms(platforms) {
  return [...new Set((platforms ?? []).map((platform) => String(platform).toLowerCase()))]
    .filter((platform) => PLATFORMS.includes(platform))
}

async function createEncargo(input = {}) {
  await sleep()
  const account = requireUserAccount(input.account_id ?? input.accountId)
  if (!account) return missing()
  const kind = input.kind === 'edit' ? 'edit' : 'from_scratch'
  const note = String(input.note ?? input.idea ?? '').trim()
  const platforms = normalisePlatforms(input.platforms)
  if (!note && kind === 'from_scratch') return badRequest('Describe qué quieres preparar.')
  if (!platforms.length) return badRequest('Selecciona al menos una plataforma.')
  const linkedUpload = input.upload_session_id
    ? requireUpload(input.upload_session_id)
    : null
  if (input.upload_session_id && (!linkedUpload || !linkedUpload.complete)) {
    return failure(404, 'UPLOAD_NOT_FOUND', 'La subida no pertenece a esta cuenta o no está completa.')
  }
  const sourceSha = input.source_sha256 ?? input.sourceSha256 ?? linkedUpload?.sha256 ?? null
  const sourceUpload = sourceSha ? state.uploadHashes.get(sourceSha) : null
  if (sourceSha && (!sourceUpload || sourceUpload.user_id !== currentUser().id || sourceUpload.released)) {
    return failure(404, 'UPLOAD_NOT_FOUND', 'El origen no pertenece a esta cuenta.')
  }
  const id = `enc-${String(++sequence).padStart(3, '0')}`
  const createdAt = tick()
  const encargo = {
    id,
    account_id: account.id,
    kind,
    note,
    platforms,
    status: 'queued',
    version: 1,
    fingerprint: `fp-${id}-v1`,
    content_hash: null,
    synthetic: kind === 'from_scratch' || input.synthetic === true,
    preview: null,
    approved: false,
    publish_at: null,
    source_sha256: sourceSha,
    created_at: createdAt,
    reads: 0,
    released: false,
  }
  state.encargos.set(id, encargo)
  state.activity.set(account.id, state.activity.get(account.id) ?? [])
  return success(publicEncargo(encargo), 201)
}

function publicEncargo(encargo) {
  const preview = encargo.preview
    ? {
        ...encargo.preview,
        synthetic: encargo.synthetic,
        contains_synthetic_media: encargo.synthetic,
        ai_notice: encargo.synthetic ? 'Hecho con ayuda de IA' : null,
      }
    : null
  return {
    id: encargo.id,
    account_id: encargo.account_id,
    kind: encargo.kind,
    status: encargo.status,
    note: encargo.note,
    platforms: encargo.platforms,
    version: encargo.version,
    fingerprint: encargo.fingerprint,
    result_sha256: encargo.preview?.sha256 ?? null,
    content_hash: encargo.content_hash,
    approval: encargo.approved
      ? { approved: true, version: encargo.version, fingerprint: encargo.fingerprint }
      : null,
    approved: encargo.approved,
    publish_at: encargo.publish_at,
    synthetic: encargo.synthetic,
    contains_synthetic_media: encargo.synthetic,
    preview,
    source_sha256: encargo.source_sha256,
    created_at: encargo.created_at,
  }
}

async function createUpload(input = {}) {
  await sleep()
  const resumed = requireUpload(input.resume_id ?? input.resumeId)
  if (resumed && !resumed.complete && !resumed.released) {
    return success({
      id: resumed.id,
      upload_id: resumed.id,
      part_size: PART_SIZE_BYTES,
      part_count: resumed.parts_expected,
      uploaded_parts: [...resumed.parts.keys()],
      resumable: true,
      resumed: true,
    })
  }
  const size = Number(input.size ?? input.sizeBytes ?? input.size_bytes ?? input.bytes ?? 0)
  if (!Number.isSafeInteger(size) || size <= 0) return badRequest('El tamaño debe ser positivo.')
  if (size > MAX_FILE_BYTES) return tooLarge('El archivo supera el máximo de 150 MB.')
  if (usedByUser() + size > MAX_USER_BYTES) return tooLarge('No cabe en el límite de 300 MB de tu usuario.')
  if (state.reservedBytes + size > MAX_GLOBAL_BYTES) return tooLarge('No cabe en el límite global de 6 GB.')
  const uploadId = `upl-${String(++sequence).padStart(4, '0')}`
  const session = {
    id: uploadId,
    user_id: currentUser().id,
    size,
    mime: input.mime ?? input.type ?? 'application/octet-stream',
    name: input.name ?? null,
    account_id: requireUserAccount(input.account_id ?? input.accountId)?.id ?? null,
    parts_expected: Math.ceil(size / PART_SIZE_BYTES),
    parts: new Map(),
    sha256: input.sha256 ?? null,
    released: false,
  }
  state.uploads.set(uploadId, session)
  state.reservedBytes += size
  if (input.storageKey) rememberInterruptedUploadId(input.storageKey, uploadId)
  return success({
    id: uploadId,
    upload_id: uploadId,
    part_size: PART_SIZE_BYTES,
    part_count: session.parts_expected,
    uploaded_parts: [],
    resumable: true,
  }, 201)
}

function requireUpload(uploadId) {
  const upload = state.uploads.get(String(uploadId))
  return upload?.user_id === currentUser()?.id ? upload : null
}

function byteLengthOf(input) {
  if (typeof input === 'number') return input
  if (input?.byteLength) return input.byteLength
  if (input?.size) return input.size
  if (input?.body !== undefined) return byteLengthOf(input.body)
  if (input?.length !== undefined) return input.length
  return 0
}

async function uploadPart(uploadId, partNumber, input = {}) {
  await sleep()
  const upload = requireUpload(uploadId)
  if (!upload) return missing()
  const n = Number(partNumber)
  if (!Number.isInteger(n) || n < 1 || n > upload.parts_expected) {
    return badRequest('Número de parte inválido.')
  }
  const size = Number(input.size ?? input.sizeBytes ?? byteLengthOf(input.body ?? input))
  if (!Number.isSafeInteger(size) || size <= 0 || size > PART_SIZE_BYTES) {
    return badRequest('Cada parte debe medir entre 1 byte y 5 MiB.')
  }
  const expected = n === upload.parts_expected ? upload.size - PART_SIZE_BYTES * (n - 1) : PART_SIZE_BYTES
  if (size !== expected) return badRequest(`La parte ${n} debe medir ${expected} bytes.`)
  if (upload.parts.has(n)) return success({ part: n, uploaded: true, already_uploaded: true })
  upload.parts.set(n, { sha256: input.sha256 ?? `sha256-part-${n}`, size })
  return success({ part: n, uploaded: true, already_uploaded: false })
}

async function completeUpload(uploadId, input = {}) {
  await sleep()
  const upload = requireUpload(uploadId)
  if (!upload) return missing()
  if (upload.parts.size !== upload.parts_expected) {
    return failure(409, 'UPLOAD_INCOMPLETE', 'Faltan partes por subir.')
  }
  upload.complete = true
  upload.sha256 = input.sha256 ?? upload.sha256 ?? `sha256-${upload.id}`
  state.uploadHashes.set(upload.sha256, upload)
  if (input.storageKey) clearInterruptedUploadId(input.storageKey)
  return success({ id: upload.id, sha256: upload.sha256, size: upload.size, complete: true })
}

async function getEncargo(encargoId) {
  await sleep()
  const encargo = requireEncargo(encargoId)
  if (!encargo) return missing()
  if (encargo.status === 'queued' || encargo.status === 'preparing') {
    encargo.reads += 1
    const level = Math.min(2, Math.floor(encargo.reads / options.transitionReads))
    encargo.status = PROCESSING_STATES[level]
    if (encargo.status === 'ready') {
      const sha256 = `preview-${encargo.id}-v${encargo.version}`
      encargo.content_hash = sha256
      encargo.preview = {
        sha256,
        media_url: `/v1/me/media/${sha256}`,
        mime: 'video/mp4',
        width: 1080,
        height: 1920,
      }
      state.media.set(sha256, { owner_user_id: currentUser().id, encargo_id: encargo.id, size: 8 * MIB })
    }
  }
  return success(publicEncargo(encargo))
}

async function getMedia(sha256) {
  await sleep()
  const media = state.media.get(String(sha256))
  if (!media || media.owner_user_id !== currentUser()?.id) return missing()
  const encargo = state.encargos.get(media.encargo_id)
  return success({
    sha256,
    encargo_id: media.encargo_id,
    content_type: 'video/mp4',
    width: 1080,
    height: 1920,
    url: `/v1/me/media/${sha256}`,
    synthetic: encargo.synthetic,
    contains_synthetic_media: encargo.synthetic,
    ai_notice: encargo.synthetic ? 'Hecho con ayuda de IA' : null,
  })
}

async function decideEncargo(encargoId, input = {}) {
  await sleep()
  const encargo = requireEncargo(encargoId)
  if (!encargo) return missing()
  const suppliedHash = input.fingerprint ?? input.content_hash
  const expectedHash = input.fingerprint !== undefined ? encargo.fingerprint : encargo.content_hash
  if (Number(input.version) !== encargo.version || suppliedHash !== expectedHash) {
    return failure(409, 'STALE_APPROVAL', 'La versión de la previa ha cambiado.')
  }
  if (encargo.status !== 'ready' && input.decision !== 'changes') {
    return failure(409, 'NOT_READY', 'La previa todavía no está lista.')
  }
  if (input.decision === 'approve') {
    encargo.approved = true
    encargo.status = 'approved'
    return success(publicEncargo(encargo))
  }
  if (input.decision === 'changes') {
    encargo.approved = false
    encargo.version += 1
    encargo.fingerprint = `fp-${encargo.id}-v${encargo.version}`
    encargo.content_hash = null
    encargo.note = String(input.note ?? input.changes ?? encargo.note)
    encargo.synthetic = encargo.synthetic || input.synthetic === true
    if (encargo.preview) state.media.delete(encargo.preview.sha256)
    encargo.preview = null
    encargo.status = 'queued'
    encargo.reads = 0
    return success(publicEncargo(encargo), 202)
  }
  return badRequest('La decisión debe ser approve o changes.')
}

function releaseEncargo(encargo) {
  if (encargo.released) return
  const upload = encargo.source_sha256 ? state.uploadHashes.get(encargo.source_sha256) : null
  if (upload && !upload.released) {
    upload.released = true
    state.reservedBytes -= upload.size
  }
  encargo.released = true
}

async function cancelEncargo(encargoId) {
  await sleep()
  const encargo = requireEncargo(encargoId)
  if (!encargo) return missing()
  releaseEncargo(encargo)
  if (encargo.preview) state.media.delete(encargo.preview.sha256)
  encargo.status = 'cancelled'
  encargo.approved = false
  return success(publicEncargo(encargo))
}

async function scheduleEncargo(encargoId, input = {}) {
  await sleep()
  const encargo = requireEncargo(encargoId)
  if (!encargo) return missing()
  if (!encargo.approved || encargo.status !== 'approved') {
    return failure(409, 'NOT_APPROVED', 'Aprueba esta versión antes de programarla.')
  }
  const publishedAt = input.when === 'now' || input.mode === 'now' || input.now
    ? tick()
    : input.publish_at ?? input.scheduled_at
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return badRequest('Indica cuándo publicarla.')
  encargo.publish_at = new Date(publishedAt).toISOString()
  encargo.status = 'scheduled'
  const mockIds = Object.fromEntries(
    encargo.platforms.map((platform, index) => [
      platform,
      `MOCK-${platform.toUpperCase()}-${encargo.id.replace('-', '')}-${index + 1}`,
    ]),
  )
  const events = encargo.platforms.map((platform) => ({
    id: `event-${encargo.id}-${platform}`,
    encargo_id: encargo.id,
    platform,
    published_at: encargo.publish_at,
    mock_id: mockIds[platform],
    status: 'mock_scheduled',
  }))
  state.activity.get(encargo.account_id).push(...events)
  return success({ ...publicEncargo(encargo), mock_ids: mockIds })
}

async function getStreak(accountId) {
  await sleep()
  const account = requireUserAccount(accountId)
  if (!account) return missing()
  const events = state.activity.get(account.id) ?? []
  const timeZone = currentUser().time_zone
  const dayKey = (value) => new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
  const uniqueDays = [...new Set(events.map((event) => dayKey(event.published_at)))].sort().reverse()
  let current = 0
  const [year, month, day] = dayKey(nowValue).split('-').map(Number)
  const cursor = new Date(Date.UTC(year, month - 1, day, 12))
  for (const day of uniqueDays) {
    const expected = cursor.toISOString().slice(0, 10)
    if (day !== expected) break
    current += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return success({
    account_id: account.id,
    current,
    longest: uniqueDays.length,
    days: current,
    day_dates: uniqueDays,
  })
}

async function getActivity(accountId) {
  await sleep()
  const account = requireUserAccount(accountId)
  if (!account) return missing()
  return success({ account_id: account.id, items: [...(state.activity.get(account.id) ?? [])].reverse() })
}

export const routes = {
  'GET /v1/me': () => getMe(),
  'POST /v1/me': (body) => createMe(body),
  'PATCH /v1/me': (body) => updateMe(body),
  'POST /v1/me/accounts': (body) => createAccount(body),
  'PATCH /v1/me/accounts/:id': (body, params) => updateAccount(params.id, body),
  'POST /v1/me/encargos': (body) => createEncargo(body),
  'POST /v1/me/uploads': (body) => createUpload(body),
  'PUT /v1/me/uploads/:id/parts/:n': (body, params) => uploadPart(params.id, params.n, body),
  'POST /v1/me/uploads/:id/complete': (body, params) => completeUpload(params.id, body),
  'GET /v1/me/encargos/:id': (_body, params) => getEncargo(params.id),
  'GET /v1/me/media/:sha256': (_body, params) => getMedia(params.sha256),
  'POST /v1/me/encargos/:id/decision': (body, params) => decideEncargo(params.id, body),
  'POST /v1/me/encargos/:id/cancel': (_body, params) => cancelEncargo(params.id),
  'POST /v1/me/encargos/:id/schedule': (body, params) => scheduleEncargo(params.id, body),
  'GET /v1/me/accounts/:id/streak': (_body, params) => getStreak(params.id),
  'GET /v1/me/accounts/:id/activity': (_body, params) => getActivity(params.id),
}

function matchRoute(method, path) {
  const normalized = String(path).split('?')[0].replace(/\/$/, '')
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ')
    if (routeMethod !== method.toUpperCase()) continue
    const routeParts = routePath.split('/')
    const pathParts = normalized.split('/')
    if (routeParts.length !== pathParts.length) continue
    const params = {}
    const matches = routeParts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[index])
        return true
      }
      return part === pathParts[index]
    })
    if (matches) return { handler, params }
  }
  return null
}

export async function request(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase()
  const matched = matchRoute(method, path)
  if (!matched) return failure(404, 'ROUTE_NOT_FOUND', `No existe ${method} ${path}.`)
  return matched.handler(options.body ?? {}, matched.params)
}

async function get(path, options) { return request(path, { ...options, method: 'GET' }) }
async function post(path, body, options) { return request(path, { ...options, method: 'POST', body }) }
async function patch(path, body, options) { return request(path, { ...options, method: 'PATCH', body }) }
async function put(path, body, options) { return request(path, { ...options, method: 'PUT', body }) }

export const fakeApi = {
  request,
  get,
  post,
  patch,
  put,
  getMe,
  createMe,
  updateMe,
  createAccount,
  updateAccount,
  createEncargo,
  createUpload,
  uploadPart,
  completeUpload,
  getEncargo,
  getMedia,
  decideEncargo,
  cancelEncargo,
  scheduleEncargo,
  getStreak,
  getActivity,
}

export {
  getMe,
  createMe,
  updateMe,
  createAccount,
  updateAccount,
  createEncargo,
  createUpload,
  uploadPart,
  completeUpload,
  getEncargo,
  getMedia,
  decideEncargo,
  cancelEncargo,
  scheduleEncargo,
  getStreak,
  getActivity,
  getInterruptedUploadId,
  rememberInterruptedUploadId,
  clearInterruptedUploadId,
}

export default fakeApi
