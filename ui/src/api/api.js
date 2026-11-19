const JSON_HEADERS = { 'content-type': 'application/json' }

function failure(response, message) {
  return {
    ok: false,
    status: response.status,
    error: {
      code: 'HTTP_ERROR',
      message: message || `La petición ha fallado (${response.status}).`,
    },
  }
}

async function jsonResponse(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    return failure(response)
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: payload?.error ?? { code: 'HTTP_ERROR', message: `La petición ha fallado (${response.status}).` },
    }
  }
  return { ...payload, ok: true, status: response.status }
}

async function request(path, { method = 'GET', body, headers, ...options } = {}) {
  try {
    const init = { method, credentials: 'same-origin', headers, ...options }
    if (body !== undefined) {
      init.body = body instanceof Blob ? body : JSON.stringify(body)
      if (!(body instanceof Blob)) init.headers = { ...JSON_HEADERS, ...headers }
    }
    return await jsonResponse(await fetch(path, init))
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      ok: false,
      status: 0,
      error: { code: 'NETWORK_ERROR', message: 'No se puede conectar con Influe. Inténtalo otra vez.' },
    }
  }
}

const encoded = (value) => encodeURIComponent(String(value))

function mapAccount(account) {
  return account ? { ...account, id: account.id ?? account.account_id } : account
}

function mapMe(data) {
  return {
    ...data,
    needs_guide: data?.guide_pending ?? false,
    accounts: (data?.accounts ?? []).map(mapAccount),
  }
}

function mapEncargo(data) {
  const preview = data?.preview
  return {
    ...data,
    id: data?.id ?? data?.encargo_id,
    result_sha256: preview?.sha256 ?? null,
  }
}

function mapResponse(response, mapper) {
  return response.ok ? { ...response, data: mapper(response.data) } : response
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function getMe() {
  return mapResponse(await request('/v1/me'), mapMe)
}

export async function createMe(body) {
  return mapResponse(await request('/v1/me', { method: 'POST', body }), mapMe)
}

export async function updateMe(body) {
  return mapResponse(await request('/v1/me', { method: 'PATCH', body }), mapMe)
}

export async function createAccount(body) {
  return mapResponse(await request('/v1/me/accounts', { method: 'POST', body }), mapAccount)
}

export async function updateAccount(accountId, body) {
  return mapResponse(
    await request(`/v1/me/accounts/${encoded(accountId)}`, { method: 'PATCH', body }),
    mapAccount,
  )
}

export async function createEncargo(body) {
  return mapResponse(await request('/v1/me/encargos', { method: 'POST', body }), mapEncargo)
}

export async function createUpload(body) {
  return request('/v1/me/uploads', { method: 'POST', body })
}

export async function uploadPart(uploadId, partNumber, blob, suppliedSha256, options = {}) {
  const sha256 = suppliedSha256 ?? await sha256Hex(blob)
  return request(`/v1/me/uploads/${encoded(uploadId)}/parts/${encoded(partNumber)}`, {
    method: 'PUT',
    body: blob,
    headers: { 'content-type': blob.type || 'application/octet-stream', 'x-content-sha256': sha256 },
    signal: options.signal,
  })
}

export async function completeUpload(uploadId, body) {
  return request(`/v1/me/uploads/${encoded(uploadId)}/complete`, { method: 'POST', body })
}

export async function listEncargos() {
  return mapResponse(await request('/v1/me/encargos'), (data) => ({
    ...data,
    encargos: (data.encargos ?? []).map(mapEncargo),
  }))
}

export async function getEncargo(encargoId) {
  return mapResponse(
    await request(`/v1/me/encargos/${encoded(encargoId)}`),
    mapEncargo,
  )
}

export async function getMedia(sha256) {
  try {
    const response = await fetch(`/v1/me/media/${encoded(sha256)}`, {
      credentials: 'same-origin',
    })
    if (!response.ok) return jsonResponse(response)
    const blob = await response.blob()
    return {
      ok: true,
      status: response.status,
      data: {
        sha256: response.headers.get('x-content-sha256') ?? sha256,
        content_type: response.headers.get('content-type'),
        url: URL.createObjectURL(blob),
      },
    }
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: 'NETWORK_ERROR', message: 'No se puede cargar la previa. Inténtalo otra vez.' },
    }
  }
}

export async function decideEncargo(encargoId, body) {
  return mapResponse(
    await request(`/v1/me/encargos/${encoded(encargoId)}/decision`, { method: 'POST', body }),
    mapEncargo,
  )
}

export async function cancelEncargo(encargoId) {
  return mapResponse(
    await request(`/v1/me/encargos/${encoded(encargoId)}/cancel`, { method: 'POST' }),
    mapEncargo,
  )
}

export async function scheduleEncargo(encargoId, body) {
  return mapResponse(
    await request(`/v1/me/encargos/${encoded(encargoId)}/schedule`, { method: 'POST', body }),
    mapEncargo,
  )
}

export async function getStreak(accountId) {
  return mapResponse(
    await request(`/v1/me/accounts/${encoded(accountId)}/streak`),
    (data) => ({ ...data, days: data.days ?? data.count }),
  )
}

export async function getActivity(accountId) {
  return mapResponse(
    await request(`/v1/me/accounts/${encoded(accountId)}/activity`),
    (data) => ({
      ...data,
      items: (data.items ?? data.activity ?? []).map((item) => ({
        ...item,
        platform: item.platform ?? item.platforms?.join(', ') ?? '',
        published_at: item.published_at ?? item.at,
      })),
    }),
  )
}

export async function listConnections(accountId) {
  return request(`/v1/me/accounts/${encoded(accountId)}/connections`)
}

export async function getConnection(connectionId) {
  return request(`/v1/me/connections/${encoded(connectionId)}`)
}

export const api = {
  request,
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  getMe,
  createMe,
  updateMe,
  createAccount,
  updateAccount,
  createEncargo,
  listEncargos,
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
  listConnections,
  getConnection,
}

export default api
