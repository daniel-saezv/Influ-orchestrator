import { describe, expect, it } from 'vitest'
import { uploadParts } from '../src/lib/upload-parts.js'

const sourceOf = (size) => ({ size, slice: (start, end) => ({ start, end, size: end - start }) })

describe('parallel part upload', () => {
  it('caps concurrency, retries one part and reports every part', async () => {
    let active = 0
    let max = 0
    const attempts = new Map()
    const done = []
    const result = await uploadParts({
      source: sourceOf(6),
      partSize: 1,
      partHashes: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      concurrency: 3,
      attempts: 3,
      wait: () => Promise.resolve(),
      onPartDone: (number) => done.push(number),
      uploadPart: (number, _blob, sha256) => new Promise((resolve) => {
        expect(sha256).toBe(`h${number}`)
        active += 1
        max = Math.max(max, active)
        const count = (attempts.get(number) ?? 0) + 1
        attempts.set(number, count)
        setTimeout(() => {
          active -= 1
          if (number === 2 && count < 3) resolve({ ok: false, status: 503, error: { message: 'luego' } })
          else resolve({ ok: true })
        }, number === 1 ? 40 : 5)
      }),
    })

    expect(result.ok).toBe(true)
    expect(max).toBeLessThanOrEqual(3)
    expect(max).toBeGreaterThan(1)
    expect(attempts.get(2)).toBe(3)
    expect([...done].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('does not retry a checksum or quota failure', async () => {
    let calls = 0
    const result = await uploadParts({
      source: sourceOf(1),
      partSize: 1,
      concurrency: 3,
      wait: () => Promise.resolve(),
      uploadPart: async () => {
        calls += 1
        return { ok: false, status: 400, error: { message: 'La huella no coincide' } }
      },
    })
    expect(result).toMatchObject({ ok: false, status: 400, error: { message: 'La huella no coincide' } })
    expect(calls).toBe(1)
  })

  it('skips parts already stored and aborts the rest', async () => {
    const seen = []
    const resumed = await uploadParts({
      source: sourceOf(3),
      partSize: 1,
      uploadedParts: new Set([2]),
      wait: () => Promise.resolve(),
      uploadPart: async (number) => {
        seen.push(number)
        return { ok: true }
      },
      onPartDone: (number) => seen.push(`done-${number}`),
    })
    expect(resumed.ok).toBe(true)
    expect(seen.filter((item) => typeof item === 'number').sort()).toEqual([1, 3])
    expect(seen).toContain('done-2')

    const controller = new AbortController()
    let started = 0
    await expect(uploadParts({
      source: sourceOf(6),
      partSize: 1,
      concurrency: 3,
      signal: controller.signal,
      wait: () => Promise.resolve(),
      uploadPart: async () => {
        started += 1
        controller.abort()
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        throw error
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBeGreaterThan(0)
    expect(started).toBeLessThanOrEqual(3)
  })
})
