/**
 * BLAKE3 (default hash mode, 32-byte output), pure TypeScript, incremental.
 *
 * Decision D-5 of `docs/cache-proxy-plan.md`: every digest the cache computes
 * (lookup keys, manifests, blobs) is BLAKE3. Node's `crypto` has no BLAKE3 and
 * this project installs no native addon, so the hash is implemented here,
 * following the reference implementation's structure (chunk state + chaining
 * value stack). `test/cache/blake3.test.ts` checks it against the published
 * digests of four short inputs and against the independent pure-Lean
 * implementation in `RequestProject/Cobuilds/Blake3Review/Compression.lean`
 * on multi-chunk inputs (up to 8193 bytes, i.e. trees of depth 4).
 *
 * The hasher is incremental: `update` may be called with any split of the
 * input, which is what streaming verification (D-7) needs. Splitting does not
 * change the digest (property-tested).
 *
 * Only the plain hash mode is implemented (no keyed / derive-key modes, no
 * extended output); those are roadmap items in the plan.
 */

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
])
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8] as const

const CHUNK_START = 1
const CHUNK_END = 2
const PARENT = 4
const ROOT = 8

const BLOCK_LEN = 64
const CHUNK_LEN = 1024

const ror = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

/** One application of the BLAKE3 compression function. Returns all 16 output words. */
const compress = (
  cv: Uint32Array,
  block: Uint32Array,
  counter: number,
  blockLen: number,
  flags: number
): Uint32Array => {
  const s = new Uint32Array(16)
  s.set(cv.subarray(0, 8), 0)
  s.set(IV.subarray(0, 4), 8)
  s[12] = counter >>> 0
  s[13] = Math.floor(counter / 0x1_0000_0000) >>> 0
  s[14] = blockLen
  s[15] = flags
  let m = Uint32Array.from(block)
  const g = (a: number, b: number, c: number, d: number, mx: number, my: number) => {
    s[a] = (s[a]! + s[b]! + mx) >>> 0
    s[d] = ror(s[d]! ^ s[a]!, 16)
    s[c] = (s[c]! + s[d]!) >>> 0
    s[b] = ror(s[b]! ^ s[c]!, 12)
    s[a] = (s[a]! + s[b]! + my) >>> 0
    s[d] = ror(s[d]! ^ s[a]!, 8)
    s[c] = (s[c]! + s[d]!) >>> 0
    s[b] = ror(s[b]! ^ s[c]!, 7)
  }
  for (let r = 0; r < 7; r++) {
    g(0, 4, 8, 12, m[0]!, m[1]!)
    g(1, 5, 9, 13, m[2]!, m[3]!)
    g(2, 6, 10, 14, m[4]!, m[5]!)
    g(3, 7, 11, 15, m[6]!, m[7]!)
    g(0, 5, 10, 15, m[8]!, m[9]!)
    g(1, 6, 11, 12, m[10]!, m[11]!)
    g(2, 7, 8, 13, m[12]!, m[13]!)
    g(3, 4, 9, 14, m[14]!, m[15]!)
    if (r < 6) {
      const p = new Uint32Array(16)
      for (let i = 0; i < 16; i++) p[i] = m[MSG_PERMUTATION[i]!]!
      m = p
    }
  }
  for (let i = 0; i < 8; i++) {
    s[i] = (s[i]! ^ s[i + 8]!) >>> 0
    s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0
  }
  return s
}

/** Little-endian message words of the first `len` bytes, zero padded to 64 bytes. */
const wordsOf = (bytes: Uint8Array, len: number): Uint32Array => {
  const w = new Uint32Array(16)
  for (let i = 0; i < len; i++) {
    const j = i >>> 2
    w[j] = (w[j]! | (bytes[i]! << (8 * (i & 3)))) >>> 0
  }
  return w
}

/** The inputs of a pending compression, so the caller can still add ROOT. */
interface Output {
  readonly cv: Uint32Array
  readonly block: Uint32Array
  readonly counter: number
  readonly blockLen: number
  readonly flags: number
}

const outputCv = (o: Output): Uint32Array =>
  compress(o.cv, o.block, o.counter, o.blockLen, o.flags).subarray(0, 8)

const parentOutput = (left: Uint32Array, right: Uint32Array): Output => {
  const block = new Uint32Array(16)
  block.set(left, 0)
  block.set(right, 8)
  return { cv: IV, block, counter: 0, blockLen: BLOCK_LEN, flags: PARENT }
}

class ChunkState {
  cv: Uint32Array = IV
  readonly buf = new Uint8Array(BLOCK_LEN)
  bufLen = 0
  blocksCompressed = 0

  constructor(readonly counter: number) {}

  get len(): number {
    return BLOCK_LEN * this.blocksCompressed + this.bufLen
  }

  private startFlag(): number {
    return this.blocksCompressed === 0 ? CHUNK_START : 0
  }

  update(input: Uint8Array): void {
    let off = 0
    while (off < input.length) {
      // A full buffer is compressed only once more input arrives: the last
      // block of a chunk must carry CHUNK_END.
      if (this.bufLen === BLOCK_LEN) {
        const words = wordsOf(this.buf, BLOCK_LEN)
        this.cv = compress(this.cv, words, this.counter, BLOCK_LEN, this.startFlag()).subarray(0, 8)
        this.blocksCompressed++
        this.buf.fill(0)
        this.bufLen = 0
      }
      const take = Math.min(BLOCK_LEN - this.bufLen, input.length - off)
      this.buf.set(input.subarray(off, off + take), this.bufLen)
      this.bufLen += take
      off += take
    }
  }

  output(): Output {
    return {
      cv: this.cv,
      block: wordsOf(this.buf, this.bufLen),
      counter: this.counter,
      blockLen: this.bufLen,
      flags: this.startFlag() | CHUNK_END
    }
  }
}

/** Incremental BLAKE3 hasher (plain hash mode). */
export class Blake3 {
  private chunk = new ChunkState(0)
  /** Chaining values of completed subtrees; after `n` chunks it holds popcount(n) entries. */
  private readonly stack: Array<Uint32Array> = []
  private finalized = false

  update(input: Uint8Array): this {
    if (this.finalized) throw new Error("Blake3: update after digest")
    let off = 0
    while (off < input.length) {
      if (this.chunk.len === CHUNK_LEN) {
        const total = this.chunk.counter + 1
        this.pushCv(outputCv(this.chunk.output()), total)
        this.chunk = new ChunkState(total)
      }
      const take = Math.min(CHUNK_LEN - this.chunk.len, input.length - off)
      this.chunk.update(input.subarray(off, off + take))
      off += take
    }
    return this
  }

  private pushCv(cv: Uint32Array, totalChunks: number): void {
    let newCv = cv
    let t = totalChunks
    while (t % 2 === 0) {
      const left = this.stack.pop()
      if (left === undefined) throw new Error("Blake3: internal stack underflow")
      newCv = outputCv(parentOutput(left, newCv))
      t /= 2
    }
    this.stack.push(newCv)
  }

  /** The 32-byte digest. The hasher cannot be updated afterwards. */
  digest(): Uint8Array {
    this.finalized = true
    let out = this.chunk.output()
    for (let i = this.stack.length - 1; i >= 0; i--) {
      out = parentOutput(this.stack[i]!, outputCv(out))
    }
    const words = compress(out.cv, out.block, out.counter, out.blockLen, out.flags | ROOT)
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 8; i++) {
      const w = words[i]!
      bytes[4 * i] = w & 0xff
      bytes[4 * i + 1] = (w >>> 8) & 0xff
      bytes[4 * i + 2] = (w >>> 16) & 0xff
      bytes[4 * i + 3] = (w >>> 24) & 0xff
    }
    return bytes
  }
}

/** One-shot BLAKE3 of a byte string. */
export const blake3 = (input: Uint8Array): Uint8Array => new Blake3().update(input).digest()

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
