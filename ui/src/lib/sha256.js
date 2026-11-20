const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export const HASH_CHUNK_BYTES = 1024 * 1024

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

export function abortError() {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

export function toHex(bytes) {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

export function createSha256() {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const block = new Uint8Array(64)
  const words = new Uint32Array(64)
  let filled = 0
  let total = 0

  function compress(chunk) {
    for (let i = 0; i < 16; i += 1) {
      const offset = i * 4
      words[i] = ((chunk[offset] << 24) | (chunk[offset + 1] << 16) | (chunk[offset + 2] << 8) | chunk[offset + 3]) >>> 0
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3)) >>> 0
      const s1 = (rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10)) >>> 0
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0
    }
    let a = state[0]
    let b = state[1]
    let c = state[2]
    let d = state[3]
    let e = state[4]
    let f = state[5]
    let g = state[6]
    let h = state[7]
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + s1 + ch + K[i] + words[i]) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }

  return {
    update(data) {
      let offset = 0
      total += data.length
      if (filled) {
        const take = Math.min(64 - filled, data.length)
        block.set(data.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        if (filled === 64) {
          compress(block)
          filled = 0
        }
      }
      while (offset + 64 <= data.length) {
        compress(data.subarray(offset, offset + 64))
        offset += 64
      }
      if (offset < data.length) {
        block.set(data.subarray(offset), 0)
        filled = data.length - offset
      }
    },
    digest() {
      const bits = total * 8
      const hi = Math.floor(bits / 4294967296)
      const lo = bits >>> 0
      block[filled] = 0x80
      filled += 1
      if (filled > 56) {
        block.fill(0, filled)
        compress(block)
        block.fill(0)
      } else {
        block.fill(0, filled)
      }
      const view = new DataView(block.buffer, block.byteOffset, 64)
      view.setUint32(56, hi)
      view.setUint32(60, lo)
      compress(block)
      const out = new Uint8Array(32)
      const written = new DataView(out.buffer)
      for (let i = 0; i < 8; i += 1) written.setUint32(i * 4, state[i])
      return out
    },
  }
}

export function hashBytes(bytes) {
  const hash = createSha256()
  hash.update(bytes)
  return toHex(hash.digest())
}

export async function hashBlob(blob, { partSize, chunkSize = HASH_CHUNK_BYTES, signal } = {}) {
  if (signal?.aborted) throw abortError()
  const fileHash = createSha256()
  const partHashes = []
  let partHash = partSize ? createSha256() : null
  let partFilled = 0
  const size = blob.size
  for (let offset = 0; offset < size; offset += chunkSize) {
    if (signal?.aborted) throw abortError()
    const end = Math.min(offset + chunkSize, size)
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
    if (signal?.aborted) throw abortError()
    fileHash.update(bytes)
    if (partHash) {
      let cursor = 0
      while (cursor < bytes.length) {
        const take = Math.min(partSize - partFilled, bytes.length - cursor)
        partHash.update(bytes.subarray(cursor, cursor + take))
        partFilled += take
        cursor += take
        if (partFilled === partSize) {
          partHashes.push(toHex(partHash.digest()))
          partHash = createSha256()
          partFilled = 0
        }
      }
    }
  }
  if (partHash && partFilled > 0) partHashes.push(toHex(partHash.digest()))
  return { sha256: toHex(fileHash.digest()), partHashes: partSize ? partHashes : null }
}
