import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashFile } from '../src/lib/hash-file.js'
import { createSha256, hashBlob, hashBytes, toHex } from '../src/lib/sha256.js'

const encoded = (text) => new TextEncoder().encode(text)
const reference = (bytes) => createHash('sha256').update(bytes).digest('hex')

describe('streaming SHA-256', () => {
  it('matches the known vectors and chunked updates', () => {
    expect(hashBytes(encoded(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(hashBytes(encoded('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const long = encoded('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
    expect(hashBytes(long)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    const payload = new Uint8Array(200)
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 17) & 255
    for (const size of [1, 3, 63, 64, 65, 100]) {
      const hash = createSha256()
      for (let offset = 0; offset < payload.length; offset += size) {
        hash.update(payload.subarray(offset, Math.min(offset + size, payload.length)))
      }
      expect(toHex(hash.digest())).toBe(reference(payload))
    }
  })

  it('hashes a blob by chunks and keeps each part hash', async () => {
    const partSize = 1000
    const bytes = new Uint8Array(2500)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 13) & 255
    const result = await hashBlob(new Blob([bytes]), { partSize, chunkSize: 64 })
    expect(result.sha256).toBe(reference(bytes))
    expect(result.partHashes).toHaveLength(3)
    for (let index = 0; index < 3; index += 1) {
      const start = index * partSize
      expect(result.partHashes[index]).toBe(reference(bytes.subarray(start, Math.min(start + partSize, bytes.length))))
    }
  })

  it('uses the worker result and falls back to the same whole-file hash', async () => {
    const blob = new Blob(['abc'])
    const expected = hashBytes(encoded('abc'))
    const worker = {
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: { ok: true, sha256: expected, partHashes: [expected] } }))
      },
      terminate() {},
    }
    const hashed = await hashFile(blob, { partSize: 3, createWorker: () => worker })
    expect(hashed).toEqual({ sha256: expected, partHashes: [expected] })

    const fallback = await hashFile(blob, {
      partSize: 3,
      createWorker: () => { throw new Error('no worker') },
    })
    expect(fallback).toEqual({ sha256: expected, partHashes: null })

    const controller = new AbortController()
    const pending = hashFile(blob, {
      partSize: 3,
      signal: controller.signal,
      createWorker: () => ({
        postMessage() { controller.abort() },
        terminate() {},
      }),
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
