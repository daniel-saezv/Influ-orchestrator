import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  createUpload,
  getEncargo,
  getMedia,
  getMe,
  listEncargos,
  scheduleEncargo,
  uploadPart,
} from '../src/api/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Worker API client', () => {
  it('uses the same origin with credentials and normalizes the person contract', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        guide_pending: false,
        accounts: [{ account_id: 'acc-1', name: 'Alex' }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)

    const response = await getMe()

    expect(fetch).toHaveBeenCalledWith('/v1/me', expect.objectContaining({
      credentials: 'same-origin',
      method: 'GET',
    }))
    expect(response.data.accounts[0].id).toBe('acc-1')
    expect(response.data.needs_guide).toBe(false)
  })

  it('lists the person encargos and keeps the server id', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        encargos: [{
          encargo_id: 'enc-1',
          status: 'claimed',
          updated_at: '2026-11-19T12:00:00.000Z',
          created_at: '2026-11-19T11:00:00.000Z',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)

    const response = await listEncargos()

    expect(fetch).toHaveBeenCalledWith('/v1/me/encargos', expect.objectContaining({
      credentials: 'same-origin',
      method: 'GET',
    }))
    expect(response.data.encargos[0]).toMatchObject({
      id: 'enc-1',
      status: 'claimed',
      updated_at: '2026-11-19T12:00:00.000Z',
    })
  })

  it('sends upload creation JSON without control fields', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { upload_id: 'upl-1' },
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    await createUpload({
      encargo_id: 'enc-1',
      size_bytes: 4,
      mime: 'video/mp4',
      sha256: 'a'.repeat(64),
    })

    expect(fetch).toHaveBeenCalledWith('/v1/me/uploads', expect.objectContaining({
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        encargo_id: 'enc-1',
        size_bytes: 4,
        mime: 'video/mp4',
        sha256: 'a'.repeat(64),
      }),
    }))
  })

  it('hashes and uploads a raw part with the checksum header', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { part: 1, uploaded: true },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', globalThis.crypto)
    const blob = new Blob(['clip'], { type: 'video/mp4' })

    await uploadPart('upl-1', 1, blob)

    expect(fetch).toHaveBeenCalledWith('/v1/me/uploads/upl-1/parts/1', expect.objectContaining({
      credentials: 'same-origin',
      method: 'PUT',
      body: blob,
      headers: {
        'content-type': 'video/mp4',
        'x-content-sha256': expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    }))
  })

  it('sends only the scheduling contract and returns Worker errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: 'CONFLICT', message: 'Solo se programa un encargo aprobado' },
    }), { status: 409 }))
    vi.stubGlobal('fetch', fetch)

    const response = await scheduleEncargo('enc-1', { when: 'now' })

    expect(fetch.mock.calls[0][1].body).toBe('{"when":"now"}')
    expect(response).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      error: { code: 'CONFLICT', message: 'Solo se programa un encargo aprobado' },
    }))
  })

  it('reuses encargo snapshots when the Worker answers 304', async () => {
    const payload = { encargo_id: 'enc-etag', status: 'claimed', version: 1, updated_at: '2026-11-19T12:00:00.000Z' }
    const etag = '"2026-11-19T12:00:00.000Z:1:claimed::"'
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag } }))
    vi.stubGlobal('fetch', fetch)

    const first = await getEncargo('enc-etag')
    const second = await getEncargo('enc-etag')

    expect(first.ok).toBe(true)
    expect(first.data.id).toBe('enc-etag')
    expect(second).toMatchObject({ ok: true, notModified: true, status: 304, data: first.data })
    expect(fetch.mock.calls[1][1].headers['If-None-Match']).toBe(etag)
  })

  it('returns private media as a Blob URL and exposes every person route helper', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new TextEncoder().encode('video'), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'x-content-sha256': 'b'.repeat(64) },
    }))
    vi.stubGlobal('fetch', fetch)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')

    const response = await getMedia('b'.repeat(64))

    expect(fetch).toHaveBeenCalledWith(`/v1/me/media/${'b'.repeat(64)}`, {
      credentials: 'same-origin',
    })
    expect(response.data.url).toBe('blob:preview')
    expect(createObjectURL).toHaveBeenCalled()
    expect(api.cancelEncargo).toEqual(expect.any(Function))
    expect(api.listEncargos).toEqual(expect.any(Function))
    expect(api.listConnections).toEqual(expect.any(Function))
    expect(api.getConnection).toEqual(expect.any(Function))
  })
})
