import { describe, expect, it, vi } from 'vitest'
import {
  notifyReadyEncargo,
  readyNoticeCopy,
  requestReadyNotices,
  shouldAnnounceReady,
  shouldAskForNotices,
} from '../src/lib/ready-notice.js'

describe('ready notices', () => {
  it('ignores a 304 and a status that was already ready', () => {
    expect(shouldAnnounceReady({ notModified: true, previousStatus: 'queued', nextStatus: 'ready' })).toBe(false)
    expect(shouldAnnounceReady({ notModified: false, previousStatus: 'ready', nextStatus: 'ready' })).toBe(false)
    expect(shouldAnnounceReady({ notModified: false, previousStatus: 'queued', nextStatus: 'ready' })).toBe(true)
    expect(shouldAnnounceReady({ notModified: false, previousStatus: 'claimed', nextStatus: 'approved' })).toBe(false)
  })

  it('keeps the copy free of addresses', () => {
    const copy = readyNoticeCopy('Una toma\ncon detalle')
    expect(copy).toEqual({ title: 'Tu toma está lista', message: '«Una toma con detalle» está lista' })
    expect(`${copy.title} ${copy.message}`).not.toMatch(/https?:|signature|X-Amz-/i)
  })

  it('asks only while the browser permission is still undecided', () => {
    const storage = { getItem: () => null, setItem: vi.fn() }
    expect(shouldAskForNotices({ permission: 'default', requestPermission: vi.fn() }, storage)).toBe(true)
    expect(shouldAskForNotices({ permission: 'granted', requestPermission: vi.fn() }, storage)).toBe(false)
    expect(shouldAskForNotices({ permission: 'denied', requestPermission: vi.fn() }, storage)).toBe(false)
    expect(shouldAskForNotices(undefined, storage)).toBe(false)
  })

  it('posts a browser notification without a media address', async () => {
    const notes = []
    class FakeNotification {
      static permission = 'granted'
      static requestPermission = vi.fn(async () => 'granted')
      constructor(title, options) {
        notes.push({ title, options })
        this.onclick = null
      }
      close() {}
    }
    const focus = vi.fn()
    const result = notifyReadyEncargo({
      title: 'La idea',
      encargoId: 'enc-1',
      notificationApi: FakeNotification,
      focus,
    })
    expect(result.browser).toBe(true)
    expect(notes[0].title).toBe('Tu toma está lista')
    expect(notes[0].options).toEqual({ body: '«La idea» está lista', tag: 'encargo-ready-enc-1' })
    expect(JSON.stringify(notes[0].options)).not.toMatch(/https?:|\/v1\/me\/media/)
    const storage = { getItem: () => null, setItem: vi.fn() }
    await requestReadyNotices(FakeNotification, storage)
    expect(storage.setItem).toHaveBeenCalledWith('influ-ready-notice', 'granted')
  })
})
