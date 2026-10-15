/**
 * BLAKE3 conformance (D-5).
 *
 * - Published digests: the empty input, one zero byte, "abc" and the "quick
 *   brown fox" sentence (the same four the Lean kernel checks in
 *   `RequestProject/Cobuilds/Tests/Blake3Vectors.lean`).
 * - Multi-chunk inputs (the official vector input pattern `i mod 251`):
 *   digests produced by `#eval` of the independent pure-Lean implementation
 *   `Cobuilds.Blake3Review.Spec.blake3`. Agreement of two independent
 *   implementations on every tree shape up to 9 chunks is evidence, not a
 *   proof; neither table below is the official multi-chunk vector file.
 * - Properties: any split of the input into `update` calls gives the one-shot
 *   digest; single-bit flips change the digest (non-vacuity of the check).
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law } from "../harness.js"
import { Blake3, blake3, toHex } from "../../src/cache/blake3.js"

announce("test/cache/blake3.test.ts")

const utf8 = (s: string) => new TextEncoder().encode(s)
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

const PUBLISHED: ReadonlyArray<readonly [string, Uint8Array, string]> = [
  ["empty", new Uint8Array(0), "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"],
  ["one zero byte", new Uint8Array([0]), "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213"],
  ["abc", utf8("abc"), "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"],
  [
    "quick brown fox",
    utf8("The quick brown fox jumps over the lazy dog"),
    "2f1514181aadccd913abd94cfa592701a5686ab23f8df1dff1b74710febc6d4a"
  ]
]

/** `#eval` of the Lean reference on `pattern(n)`. */
const LEAN_REFERENCE: ReadonlyArray<readonly [number, string]> = [
  [63, "e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b"],
  [64, "4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98"],
  [65, "de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee"],
  [1023, "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11"],
  [1024, "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7"],
  [1025, "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444"],
  [2048, "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a"],
  [2049, "5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030"],
  [3072, "b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2"],
  [3073, "7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3"],
  [4096, "015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969"],
  [4097, "9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995"],
  [5120, "9cadc15fed8b5d854562b26a9536d9707cadeda9b143978f319ab34230535833"],
  [5121, "628bd2cb2004694adaab7bbd778a25df25c47b9d4155a55f8fbd79f2fe154cff"],
  [6144, "3e2e5b74e048f3add6d21faab3f83aa44d3b2278afb83b80b3c35164ebeca205"],
  [7168, "61da957ec2499a95d6b8023e2b0e604ec7f6b50e80a9678b89d2628e99ada77a"],
  [8192, "aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63"],
  [8193, "bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b"]
]

describe("blake3", () => {
  it.each(PUBLISHED)("published digest: %s", (_name, input, hex) => {
    expect(toHex(blake3(input))).toBe(hex)
  })

  it.each(LEAN_REFERENCE)("agrees with the Lean reference on %i bytes", (n, hex) => {
    expect(toHex(blake3(pattern(n)))).toBe(hex)
  })

  /**
   * Third pass (`docs/test-review.md` §TS-B): the two properties used to draw
   * only inputs of the pattern `i mod 251`, so one length fixed the input and
   * the "random" domain was 5001 strings. Inputs are now arbitrary bytes, and
   * the lengths are biased to the chunk (1024) and block (64) boundaries,
   * where the tree and padding logic changes (H6).
   */
  const lengthArb = fc.oneof(
    { arbitrary: fc.integer({ min: 0, max: 9 }).chain((k) => fc.constantFrom(1024 * k - 1, 1024 * k, 1024 * k + 1, 64 * k, 64 * k + 1)).map((n) => Math.max(0, n)), weight: 1 },
    { arbitrary: fc.integer({ min: 0, max: 5_000 }), weight: 1 }
  )
  const bytesArb = lengthArb.chain((n) => fc.uint8Array({ minLength: n, maxLength: n }))
  const onBoundary = (n: number) => n % 1024 <= 1 || n % 1024 === 1023 || n % 64 <= 1

  it("property: any split into update calls gives the one-shot digest (arbitrary bytes, chunk-boundary lengths)", () => {
    law(
      "streaming = one-shot",
      fc.tuple(bytesArb, fc.array(fc.integer({ min: 0, max: 1_500 }), { maxLength: 12 })),
      ([input, cuts]) => {
        const h = new Blake3()
        let off = 0
        for (const c of cuts) {
          const end = Math.min(input.length, off + c)
          h.update(input.subarray(off, end))
          off = end
        }
        h.update(input.subarray(off))
        expect(toHex(h.digest())).toBe(toHex(blake3(input)))
        return { valid: cuts.some((c) => c > 0 && c < input.length), boundary: onBoundary(input.length) }
      },
      300,
      { domain: "byte strings of length ∈ {64k, 64k+1, 1024k±1, 1024k : k ≤ 9} ∪ [0,5000], ≤12 cuts of ≤1500 bytes", minValidFraction: 0.5, minBoundary: 80 }
    )
  })

  it("property (non-degeneracy): flipping any single bit of any input changes the digest; digests are 32 bytes and pairwise distinct", () => {
    const seen = new Set<string>()
    law(
      "bit flip changes digest",
      fc.tuple(bytesArb.filter((b) => b.length > 0), fc.nat()),
      ([a, pos]) => {
        const b = Uint8Array.from(a)
        const bit = pos % (8 * a.length)
        b[bit >>> 3]! ^= 1 << (bit & 7)
        const da = blake3(a)
        expect(da.length).toBe(32)
        expect(toHex(blake3(b))).not.toBe(toHex(da))
        seen.add(Buffer.from(a).toString("hex") + "|" + toHex(da))
        return { valid: true, boundary: onBoundary(a.length) }
      },
      300,
      { domain: "non-empty byte strings as above, one bit flipped at a random position", minValidFraction: 1, minBoundary: 80 }
    )
    // Distinct inputs gave distinct digests over the whole sample (H4).
    const digests = new Map<string, string>()
    for (const e of seen) {
      const [input, d] = e.split("|") as [string, string]
      if (digests.has(d)) expect(digests.get(d)).toBe(input)
      digests.set(d, input)
    }
  })

  it("rejects update after digest", () => {
    const h = new Blake3()
    h.digest()
    expect(() => h.update(new Uint8Array([1]))).toThrow()
  })
})
