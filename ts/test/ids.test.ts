/**
 * Branded identifiers (`src/ids.ts`, style guide § 12) and the facade's v4
 * `Brand.make` (`src/fx/Brand.ts`).
 *
 * The nominal brands are compile-time only; the `@ts-expect-error` lines
 * below are the test that a plain string, or another brand, is rejected by
 * the type checker (`tsc --noEmit` fails if any of them stops being an error).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, params } from "./harness.js"
import { Brand, Option } from "../src/fx/index.js"
import { CacheKey, CommitOid, JobId, SessionId } from "../src/ids.js"
import { makeCobuildLock, makeMemoryStore } from "../src/index.js"

announce("test/ids.test.ts")

describe("CommitOid (Brand.make, validated)", () => {
  const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/)

  it("law: accepts exactly the 40-character lowercase hex strings", () => {
    fc.assert(
      fc.property(hex40, (s) => {
        expect(CommitOid(s)).toBe(s)
        expect(CommitOid.is(s)).toBe(true)
      }),
      params(300)
    )
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (s) => {
        expect(CommitOid.is(s)).toBe(/^[0-9a-f]{40}$/.test(s))
      }),
      params(300)
    )
  })

  it("rejects near misses (39/41 chars, upper case, non-hex) by throwing, and Option-returns none", () => {
    const ok = "0123456789abcdef0123456789abcdef01234567"
    for (const bad of [ok.slice(1), `${ok}8`, ok.toUpperCase(), `g${ok.slice(1)}`, ""]) {
      expect(() => CommitOid(bad), bad).toThrow(Brand.BrandError)
      expect(() => CommitOid(bad), bad).toThrow(/40-character lowercase hex/)
      expect(Option.isNone(CommitOid.option(bad))).toBe(true)
    }
    expect(Option.getOrUndefined(CommitOid.option(ok))).toBe(ok)
  })
})

describe("facade Brand.make (v4 shape)", () => {
  type Even = number & Brand.Brand<"Even">
  const Even = Brand.make<Even>((n) => n % 2 === 0 || `Expected ${n} to be even`)

  it("true accepts, a string is the error message", () => {
    expect(Even(4)).toBe(4)
    expect(() => Even(3)).toThrow("Expected 3 to be even")
    expect(Even.is(3)).toBe(false)
  })
})

describe("nominal brands", () => {
  it("are the same string at run time (no runtime check, no encoding change)", () => {
    expect(JobId("A")).toBe("A")
    expect(CacheKey("k")).toBe("k")
    expect(SessionId("0123abcd")).toBe("0123abcd")
    expect(JSON.stringify({ id: JobId("A") })).toBe('{"id":"A"}')
  })

  it("are not interchangeable at compile time", () => {
    const lock = makeCobuildLock(makeMemoryStore(), { scope: "trusted", context: "c", jobId: JobId("A") })
    // @ts-expect-error a plain string is not a CacheKey
    void lock.objectKey("k")
    // @ts-expect-error a JobId is not a CacheKey
    void lock.objectKey(JobId("A"))
    // @ts-expect-error a plain string is not a JobId
    void makeCobuildLock(makeMemoryStore(), { scope: "trusted", context: "c", jobId: "A" })
    expect(lock.objectKey(CacheKey("k"))).toContain("k")
  })
})
