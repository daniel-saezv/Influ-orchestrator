import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fakeApi, {
  markEncargoFailedForTests,
  FAKE_ACCESS_EMAIL,
  MAX_FILE_BYTES,
  MAX_GLOBAL_BYTES,
  MAX_USER_BYTES,
  MIB,
  PART_SIZE_BYTES,
  configureFakeApi,
  getFakeApiState,
  clearInterruptedUploadId,
  getInterruptedUploadId,
  rememberInterruptedUploadId,
  resetFakeApi,
} from '../src/api/fake-api.js'

beforeEach(() => resetFakeApi({ onboarded: true }))
afterEach(() => vi.unstubAllGlobals())

async function firstAccount() {
  return (await fakeApi.getMe()).data.accounts[0]
}

async function createReadyEncargo() {
  const account = await firstAccount()
  const created = await fakeApi.createEncargo({
    account_id: account.id,
    kind: 'from_scratch',
    note: 'Un vídeo de prueba',
    format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }, { platform: 'instagram', target: 'reel' }, { platform: 'tiktok', target: 'video' }],
  })
  await fakeApi.getEncargo(created.data.id)
  const ready = await fakeApi.getEncargo(created.data.id)
  return { account, encargo: ready.data }
}

describe('fake Phase B API', () => {
  it('keeps all methods asynchronous and response-shaped', async () => {
    const result = fakeApi.getMe()
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ email: FAKE_ACCESS_EMAIL }),
    }))
  })

  it('completes onboarding and edits names without accepting secrets', async () => {
    resetFakeApi()
    const created = await fakeApi.createMe({ name: 'Alex', time_zone: 'Atlantic/Canary' })
    expect(created.status).toBe(201)
    expect(created.data.guide_required).toBe(false)
    expect(created.data.time_zone).toBe('Atlantic/Canary')
    const account = created.data.accounts[0]
    await fakeApi.updateAccount(account.id, { name: 'Estudio' })
    const updated = await fakeApi.updateMe({ name: 'Alicia' })
    expect(updated.data.display_name).toBe('Alicia')
    expect((await fakeApi.getMe()).data.accounts[0].name).toBe('Estudio')
  })

  it('creates accounts and routes every listed endpoint verb', async () => {
    const account = await fakeApi.post('/v1/me/accounts', { name: 'Segunda' })
    expect(account.ok).toBe(true)
    expect((await fakeApi.patch(`/v1/me/accounts/${account.data.id}`, { name: 'Nueva' })).data.name).toBe('Nueva')
    const archived = await fakeApi.post(`/v1/me/accounts/${account.data.id}/archive`)
    expect(archived.data.archived_at).toEqual(expect.any(String))
    expect((await fakeApi.getMe()).data.accounts.some((item) => item.id === account.data.id)).toBe(false)
    expect((await fakeApi.listArchivedAccounts()).data.accounts.map((item) => item.id)).toEqual([account.data.id])
    const blocked = await fakeApi.createEncargo({
      account_id: account.data.id, kind: 'from_scratch', note: 'idea', format: 'short_video',
      targets: [{ platform: 'youtube', target: 'short' }],
    })
    expect(blocked.status).toBe(409)
    expect((await fakeApi.post(`/v1/me/accounts/${account.data.id}/restore`)).data.archived_at).toBeNull()
    expect((await fakeApi.getMe()).data.accounts.some((item) => item.id === account.data.id)).toBe(true)
    expect((await fakeApi.get('/v1/me')).ok).toBe(true)
    expect((await fakeApi.request('/v1/unknown')).ok).toBe(false)
  })

  it('isolates another Access email from every resource kind', async () => {
    resetFakeApi({ onboarded: true, seedOtherAccount: true })
    const snapshot = getFakeApiState()
    const other = snapshot.accounts.find((account) => account.owner_email === 'otra-persona@example.test')
    expect((await fakeApi.getEncargo('enc-other')).status).toBe(404)
    expect((await fakeApi.listEncargos()).data.encargos.map((item) => item.id)).not.toContain('enc-other')
    expect((await fakeApi.getMedia('media-other')).status).toBe(404)
    expect((await fakeApi.getStreak(other.id)).status).toBe(404)
    expect((await fakeApi.getActivity(other.id)).status).toBe(404)
    expect((await fakeApi.updateAccount(other.id, { name: 'Robo' })).status).toBe(404)
    expect((await fakeApi.createEncargo({ account_id: other.id, kind: 'edit', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }], note: 'x' })).status).toBe(404)
  })

  it('rejects file, user and global byte limits before reserving', async () => {
    expect((await fakeApi.createUpload({ size: MAX_FILE_BYTES + 1 })).status).toBe(413)
    configureFakeApi({ initialGlobalBytes: MAX_GLOBAL_BYTES })
    expect((await fakeApi.createUpload({ size: 1 })).status).toBe(413)
    configureFakeApi({ initialGlobalBytes: 0 })
    await fakeApi.createUpload({ size: MAX_FILE_BYTES })
    await fakeApi.createUpload({ size: MAX_FILE_BYTES })
    expect((await fakeApi.createUpload({ size: 1 })).status).toBe(413)
    expect(MAX_USER_BYTES).toBe(300 * MIB)
  })

  it('simulates exactly 5 MiB resumable parts and validates integrity ordering', async () => {
    const size = 5 * MIB + 7
    const opened = await fakeApi.createUpload({ size, sha256: 'whole', name: 'x.mp4' })
    expect(opened.data.part_size).toBe(PART_SIZE_BYTES)
    expect(opened.data.part_count).toBe(2)
    expect((await fakeApi.uploadPart(opened.data.id, 1, { size: PART_SIZE_BYTES + 1 })).ok).toBe(false)
    await fakeApi.uploadPart(opened.data.id, 1, { size: PART_SIZE_BYTES, sha256: 'p1' })
    expect((await fakeApi.completeUpload(opened.data.id, { sha256: 'whole' })).status).toBe(409)
    await fakeApi.uploadPart(opened.data.id, 2, { size: 7, sha256: 'p2' })
    expect((await fakeApi.completeUpload(opened.data.id, { sha256: 'whole' })).data.complete).toBe(true)
  })

  it('returns queued, preparing and ready while polling deterministically', async () => {
    const account = await firstAccount()
    const created = await fakeApi.createEncargo({
      account_id: account.id, kind: 'from_scratch', note: 'Vídeo', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
    })
    expect(created.data.status).toBe('queued')
    expect((await fakeApi.getEncargo(created.data.id)).data.status).toBe('preparing')
    const ready = (await fakeApi.getEncargo(created.data.id)).data
    expect(ready.status).toBe('ready')
    expect(ready.preview.width / ready.preview.height).toBe(9 / 16)
    const listed = await fakeApi.listEncargos()
    expect(listed.data.encargos).toEqual([
      expect.objectContaining({
        id: created.data.id,
        status: 'ready',
        updated_at: expect.any(String),
        created_at: expect.any(String),
      }),
    ])
  })

  it('only shows an IA notice for synthetic preview data', async () => {
    const { encargo } = await createReadyEncargo()
    expect((await fakeApi.getMedia(encargo.preview.sha256)).data).toEqual(expect.objectContaining({
      contains_synthetic_media: true,
      ai_notice: 'Hecho con ayuda de IA',
    }))
    const account = await firstAccount()
    const edit = await fakeApi.createEncargo({
      account_id: account.id, kind: 'edit', note: 'Recorta', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }], synthetic: false,
    })
    await fakeApi.getEncargo(edit.data.id)
    const readyEdit = await fakeApi.getEncargo(edit.data.id)
    expect(readyEdit.data.preview.ai_notice).toBeNull()
  })

  it('requires an exact version and fingerprint for approval', async () => {
    const { encargo } = await createReadyEncargo()
    expect((await fakeApi.decideEncargo(encargo.id, {
      decision: 'approve', version: 9, fingerprint: encargo.fingerprint,
    })).status).toBe(409)
    const approved = await fakeApi.decideEncargo(encargo.id, {
      decision: 'approve', version: encargo.version, fingerprint: encargo.fingerprint,
    })
    expect(approved.data.approval).toEqual(expect.objectContaining({ approved: true, version: 1 }))
  })

  it('changes invalidate approval, delete preview, and queue a new version', async () => {
    const { encargo } = await createReadyEncargo()
    await fakeApi.decideEncargo(encargo.id, { decision: 'approve', version: 1, fingerprint: encargo.fingerprint })
    const changed = await fakeApi.decideEncargo(encargo.id, {
      decision: 'changes', version: 1, fingerprint: encargo.fingerprint, note: 'Más corto',
    })
    expect(changed.data.status).toBe('queued')
    expect(changed.data.version).toBe(2)
    expect(changed.data.approved).toBe(false)
    expect((await fakeApi.getMedia(encargo.preview.sha256)).status).toBe(404)
  })

  it('schedules only approved work and records platform-specific MOCK ids', async () => {
    const { account, encargo } = await createReadyEncargo()
    expect((await fakeApi.scheduleEncargo(encargo.id, { when: 'now' })).status).toBe(409)
    await fakeApi.decideEncargo(encargo.id, {
      decision: 'approve', version: encargo.version, fingerprint: encargo.fingerprint,
    })
    const scheduled = await fakeApi.scheduleEncargo(encargo.id, { when: 'now' })
    expect(scheduled.data.mock_ids.youtube).toMatch(/^MOCK-YOUTUBE-/)
    expect((await fakeApi.getActivity(account.id)).data.items).toHaveLength(3)
    expect((await fakeApi.getStreak(account.id)).data.current).toBe(1)
  })

  it('cancels owned work and releases its upload reservation', async () => {
    const upload = await fakeApi.createUpload({ size: MIB })
    await fakeApi.uploadPart(upload.data.id, 1, { size: MIB })
    const completed = await fakeApi.completeUpload(upload.data.id)
    const account = await firstAccount()
    const created = await fakeApi.createEncargo({
      account_id: account.id, kind: 'edit', note: 'Editar', format: 'short_video', targets: [{ platform: 'youtube', target: 'short' }],
      source_sha256: completed.data.sha256,
    })
    await fakeApi.cancelEncargo(created.data.id)
    expect((await fakeApi.createUpload({ size: MAX_FILE_BYTES })).ok).toBe(true)
  })

  it('retries only a failed encargo that still has its source', async () => {
    const account = await firstAccount()
    const created = await fakeApi.createEncargo({
      account_id: account.id,
      kind: 'from_scratch',
      note: 'Rehacer',
      format: 'short_video',
      targets: [{ platform: 'youtube', target: 'short' }],
    })
    expect((await fakeApi.retryEncargo(created.data.id)).status).toBe(409)
    markEncargoFailedForTests(created.data.id)
    const retried = await fakeApi.retryEncargo(created.data.id)
    expect(retried.data.status).toBe('queued')
    expect((await fakeApi.retryEncargo('enc-other')).status).toBe(404)
  })

  it('releases a completed upload back into the byte budget', async () => {
    const upload = await fakeApi.createUpload({ size: MIB })
    await fakeApi.uploadPart(upload.data.id, 1, { size: MIB })
    await fakeApi.completeUpload(upload.data.id)
    const released = await fakeApi.releaseUpload(upload.data.id)
    expect(released.data.released).toBe(true)
    expect(getFakeApiState().reservedBytes).toBe(0)
    expect((await fakeApi.releaseUpload(upload.data.id)).status).toBe(404)
  })

  it('resumes a session from only its persisted upload id', async () => {
    const values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    })
    const upload = await fakeApi.createUpload({ size: PART_SIZE_BYTES + 1, storageKey: 'clip-1' })
    expect(getInterruptedUploadId('clip-1')).toBe(upload.data.id)
    await fakeApi.uploadPart(upload.data.id, 1, { size: PART_SIZE_BYTES })
    const resumed = await fakeApi.createUpload({ resume_id: getInterruptedUploadId('clip-1') })
    expect(resumed.data).toEqual(expect.objectContaining({ id: upload.data.id, resumed: true, uploaded_parts: [1] }))
    rememberInterruptedUploadId('clip-2', 'upl-2')
    clearInterruptedUploadId('clip-2')
    expect(getInterruptedUploadId('clip-2')).toBeNull()
    delete globalThis.localStorage
  })
})
