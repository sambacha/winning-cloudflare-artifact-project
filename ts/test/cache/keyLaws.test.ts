/**
 * Laws for keys, digests, scopes and lookup keys (third test pass,
 * `docs/test-review.md` §TS-K). Each test of `keys.test.ts` that checked a
 * hand-picked example is generalised here into the law it illustrated:
 *
 * | Example in `keys.test.ts` | Law here |
 * |---|---|
 * | `decodeKey` rejects four hand-written strings | **inverse round trip** `decodeKey(s) = cs ⇒ encodeKey(cs) = s` over near-canonical strings |
 * | `parseDigest` rejects six hand-written strings | inverse round trip `parseDigest(s) = d ⇒ formatDigest(d) = s` |
 * | 1024-byte limit, one lone surrogate | byte-length threshold at `MAX_KEY_BYTES` / `+ 1` for random contents; every string with a lone surrogate is rejected |
 * | `trusted` vs `trusted-fork` | scope prefixes are disjoint for every pair of valid scope names |
 * | five invalid scope names | `makeScope` accepts exactly the names an independent character-class oracle accepts |
 * | read/write scopes for two jobs | `readScopes` / `canWrite` laws for random trust policies |
 * | salt, toolchain, input order (one input set) | metamorphic laws over random inputs |
 * | two concatenation pairs | field boundaries: no two distinct environments with the same concatenation share a key |
 *
 * The inverse round trip found a defect: `decodeKey` accepted keys that no
 * call of `encodeKey` produces (a component with a lone surrogate, or a key
 * longer than R2's limit), so `decodeKey` was not the inverse of `encodeKey`
 * on its domain. Fixed in `src/cache/keyEncoding.ts`; the law below is the
 * permanent regression (H: promote counterexamples to laws).
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { formatDigest, parseDigest } from "../../src/cache/digest.js"
import { decodeKey, encodeKey, isWellFormed, KeyTooLong, MalformedComponent, MAX_KEY_BYTES } from "../../src/cache/keyEncoding.js"
import { type KeyEnvironment, lookupDigest, manifestKey } from "../../src/cache/lookupKey.js"
import { digestBytes } from "../../src/cache/digest.js"
import { canWrite, isValidScope, makeScope, readScopes, type Scope } from "../../src/cache/scope.js"
import { announce, law, mutantKilled } from "../harness.js"

announce("test/cache/keyLaws.test.ts")

const component = fc.string({ unit: fc.constantFrom("a", "b", "/", "%", "2", "F", "\n", "é", "😀", "\u007f"), maxLength: 6 })
const components = fc.array(component, { maxLength: 5 })

/**
 * Near-canonical key strings (H6): an encoded key, then one edit that lands
 * on a boundary of the grammar: a lower-case or non-canonical escape, a
 * truncated escape, a lone surrogate, a missing terminator, a foreign
 * version, or padding to just over the byte limit. A third of the cases are
 * unedited (valid by construction).
 */
const edit = fc.oneof(
  { arbitrary: fc.constant("none" as const), weight: 4 },
  { arbitrary: fc.constantFrom("lower", "escapeA", "truncEscape", "surrogate", "noSlash", "v2", "long", "raw"), weight: 8 }
)
const nearKey = fc.tuple(components, edit, fc.nat(), fc.string({ maxLength: 8 })).map(([cs, e, pos, raw]) => {
  const k = encodeKey(cs)
  const at = k.length === 0 ? 0 : 3 + (pos % Math.max(1, k.length - 3))
  switch (e) {
    case "none":
      return k
    case "lower":
      return k.replace(/%([0-9A-F])([A-F])/, (_, a: string, b: string) => `%${a}${b.toLowerCase()}`)
    case "escapeA":
      return k.slice(0, at) + "%41" + k.slice(at)
    case "truncEscape":
      return k.slice(0, -1) + "%2/"
    case "surrogate":
      return k.slice(0, at) + "\uD800" + k.slice(at)
    case "noSlash":
      return k.slice(0, -1)
    case "v2":
      return "v2" + k.slice(2)
    case "long":
      return `${k}${"x".repeat(MAX_KEY_BYTES)}/`
    case "raw":
      return raw
  }
})

/** Valid scope names (generated, not filtered from random strings). */
const validScope = fc
  .tuple(fc.constantFrom("a", "b", "1"), fc.string({ unit: fc.constantFrom("a", "b", "-", "1"), maxLength: 7 }))
  .map(([h, t]) => (h + t) as Scope)

/** Mutant decoder: accepts lower-case escapes (not canonical). */
const lenientDecode = (key: string): Array<string> | null => decodeKey(key.replace(/%([0-9A-F])([a-f])/g, (_, a: string, b: string) => `%${a}${b.toUpperCase()}`))

describe("D-4 key encoding: inverse round trip", () => {
  it("law: decodeKey(s) = cs ⇒ encodeKey(cs) = s (decodeKey accepts only canonical keys)", () => {
    law(
      "decode then encode",
      nearKey,
      (s) => {
        const cs = decodeKey(s)
        if (cs !== null) expect(encodeKey(cs)).toBe(s)
        return { valid: cs !== null, boundary: cs === null }
      },
      5_000,
      { domain: "encoded keys of ≤5 components over {a,b,/,%,2,F,\\n,é,😀,DEL}, then one of 8 grammar-boundary edits or a random string", minValidFraction: 0.25, minBoundary: 1_000 }
    )
  })

  it("the inverse law refutes a decoder that accepts lower-case escapes", () => {
    expect(mutantKilled(nearKey, (s) => {
      const cs = lenientDecode(s)
      return cs === null || encodeKey(cs) === s
    }, 5_000)).toBe(true)
  })

  it("regression law (found by the inverse round trip): no key containing a lone surrogate or exceeding the byte limit decodes", () => {
    law(
      "decodeKey rejects what encodeKey cannot produce",
      fc.tuple(components, fc.constantFrom("\uD800", "\uDFFF", "\uDBFF"), fc.nat(), fc.integer({ min: 0, max: 2 })),
      ([cs, lone, pos, pad]) => {
        const k = encodeKey(cs)
        const at = 3 + (pos % Math.max(1, k.length - 3))
        const withLone = k.slice(0, at) + lone + k.slice(at)
        const tooLong = `${k}${"y".repeat(MAX_KEY_BYTES - Buffer.byteLength(k, "utf8") + pad)}/`
        expect(decodeKey(withLone)).toBeNull()
        expect(decodeKey(tooLong) === null).toBe(Buffer.byteLength(tooLong, "utf8") > MAX_KEY_BYTES)
        return { valid: true, boundary: Buffer.byteLength(tooLong, "utf8") - MAX_KEY_BYTES <= 1 }
      },
      2_000,
      { domain: "valid keys with one lone surrogate inserted, and keys padded to MAX_KEY_BYTES + {0,1,2}", minValidFraction: 1, minBoundary: 500 }
    )
  })
})

describe("D-4 key encoding: byte-length threshold and well-formedness", () => {
  it("law: a key of exactly MAX_KEY_BYTES bytes is accepted, one byte more is rejected, for random contents", () => {
    law(
      "byte-length threshold",
      fc.tuple(fc.string({ unit: fc.constantFrom("a", "é", "😀", "/"), maxLength: 40 }), fc.integer({ min: -1, max: 1 })),
      ([prefix, delta]) => {
        const head = encodeKey([prefix])
        const fill = MAX_KEY_BYTES - Buffer.byteLength(head, "utf8") - 1 + delta
        if (fill < 0) return { valid: false, boundary: false }
        const cs = [prefix, "z".repeat(fill)]
        const bytes = Buffer.byteLength(`${head}${"z".repeat(fill)}/`, "utf8")
        if (bytes <= MAX_KEY_BYTES) expect(Buffer.byteLength(encodeKey(cs), "utf8")).toBe(bytes)
        else expect(() => encodeKey(cs)).toThrow(KeyTooLong)
        return { valid: true, boundary: Math.abs(bytes - MAX_KEY_BYTES) <= 1 }
      },
      1_000,
      { domain: "first component ≤40 code points over {a,é,😀,/}; second padded to MAX_KEY_BYTES − 1, +0, +1", minValidFraction: 0.95, minBoundary: 600 }
    )
  })

  it("law: encodeKey rejects a component iff it is not well-formed UTF-16 (oracle: TextEncoder round trip)", () => {
    const unit = fc.oneof(fc.constantFrom("a", "\uD800", "\uDC00", "\uD83D", "\uDE00"), fc.string({ maxLength: 1 }))
    law(
      "well-formedness",
      fc.array(unit, { maxLength: 6 }).map((us) => us.join("")),
      (c) => {
        // Independent oracle: a string is well-formed iff UTF-8 encoding and decoding keep it.
        const oracle = new TextDecoder().decode(new TextEncoder().encode(c)) === c
        expect(isWellFormed(c)).toBe(oracle)
        if (oracle) expect(decodeKey(encodeKey([c]))).toEqual([c])
        else expect(() => encodeKey([c])).toThrow(MalformedComponent)
        return { valid: true, boundary: !oracle }
      },
      3_000,
      { domain: "≤6 units from {a, lone high, lone low, 😀 halves} ∪ random 1-char strings", minValidFraction: 1, minBoundary: 500 }
    )
  })
})

describe("D-5 tagged digests: inverse round trip", () => {
  const nearDigest = fc.oneof(
    fc.uint8Array({ minLength: 1, maxLength: 40 }).map((b) => `blake3:${Buffer.from(b).toString("hex")}`),
    fc.tuple(fc.constantFrom("blake3", "sha256", "", "BLAKE3"), fc.string({ unit: fc.constantFrom("a", "f", "0", "9", "A", "g", ":"), maxLength: 9 })).map(([a, h]) => `${a}:${h}`),
    fc.string({ maxLength: 12 })
  )

  it("law: parseDigest(s) = d ⇒ formatDigest(d) = s, and formatted digests always parse", () => {
    law(
      "parse then format",
      nearDigest,
      (s) => {
        const d = parseDigest(s)
        if (d !== null) {
          expect(formatDigest(d)).toBe(s)
          expect(parseDigest(formatDigest(d))).toEqual(d)
        }
        return { valid: d !== null, boundary: d === null }
      },
      3_000,
      { domain: "valid blake3 digests of 1–40 bytes, tag/alphabet edits (upper case, odd length, unknown tag, extra ':'), random strings", minValidFraction: 0.3, minBoundary: 500 }
    )
  })
})

describe("D-1 scopes", () => {
  /** Independent oracle for scope names, from character classes (not the implementation's regex). */
  const scopeOracle = (s: string): boolean => {
    const lowerOrDigit = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9")
    return s.length >= 1 && s.length <= 63 && lowerOrDigit(s[0]!) && [...s].every((c) => lowerOrDigit(c) || c === "-") && [...s].length === s.length
  }
  const scopeName = fc.oneof(
    fc.string({ unit: fc.constantFrom("a", "z", "0", "9", "-", "A", "/", "_", "é"), minLength: 0, maxLength: 5 }),
    fc.integer({ min: 62, max: 65 }).map((n) => "a".repeat(n))
  )

  it("law: makeScope accepts exactly the names the character-class oracle accepts; both verdicts occur", () => {
    let accepted = 0
    law(
      "scope names",
      scopeName,
      (s) => {
        expect(isValidScope(s)).toBe(scopeOracle(s))
        if (scopeOracle(s)) {
          accepted++
          expect(makeScope(s)).toBe(s)
        } else expect(() => makeScope(s)).toThrow()
        return { valid: true, boundary: s.length === 0 || s.length === 63 || s.length === 64 || s.startsWith("-") }
      },
      3_000,
      { domain: "≤5 chars over {a,z,0,9,-,A,/,_,é}, and 62–65 × 'a'", minValidFraction: 1, minBoundary: 300 }
    )
    expect(accepted).toBeGreaterThan(300)
  })

  it("law: the key prefixes of two different scopes are disjoint (no key under one is under the other)", () => {
    law(
      "scope prefixes disjoint",
      fc.tuple(validScope, validScope, components),
      ([s1, s2, rest]) => {
        const under = encodeKey([s1, ...rest]).startsWith(encodeKey([s2]))
        expect(under).toBe(s1 === s2)
        return { valid: true, boundary: s1 !== s2 && (s1.startsWith(s2) || s2.startsWith(s1)) }
      },
      3_000,
      { domain: "pairs of scope names ≤8 chars over {a,b,-,1}, ≤5 further components", minValidFraction: 1, minBoundary: 50 }
    )
  })

  it("law: trusted jobs read exactly the trusted scopes; untrusted jobs read the trusted scopes, then their own; a job writes only its own scope", () => {
    law(
      "read and write scopes",
      fc.tuple(fc.uniqueArray(validScope, { maxLength: 4 }), validScope, validScope),
      ([trusted, own, target]) => {
        const policy = { trusted }
        const job = { scope: own }
        const isTrusted = trusted.includes(own)
        expect(readScopes(policy, job)).toEqual(isTrusted ? trusted : [...trusted, own])
        expect(canWrite(job, target)).toBe(own === target)
        // Metamorphic: adding a scope to the trusted list never removes a readable scope.
        const more = readScopes({ trusted: [...trusted, target] }, job)
        trusted.forEach((t) => expect(more).toContain(t))
        return { valid: true, boundary: isTrusted || trusted.length === 0 }
      },
      2_000,
      { domain: "≤4 distinct trusted scopes; job and target scopes from the same alphabet", minValidFraction: 1, minBoundary: 200 }
    )
  })
})

describe("D-2 lookup keys: metamorphic laws", () => {
  const d = (s: string) => digestBytes(new TextEncoder().encode(s))
  const envArb = fc.record({ flushSalt: fc.string({ maxLength: 4 }), toolchain: fc.string({ maxLength: 4 }) })
  const inputsArb = fc.uniqueArray(fc.record({ path: fc.string({ minLength: 1, maxLength: 4 }), digest: fc.string({ maxLength: 3 }).map(d) }), { selector: (i) => i.path, maxLength: 5 })

  it("law: the key does not depend on input order (permutation invariance) but changes with every environment field", () => {
    law(
      "lookup key metamorphic",
      fc.tuple(envArb, inputsArb, fc.nat(), envArb),
      ([env, inputs, rot, env2]) => {
        const key = (e: KeyEnvironment, xs: typeof inputs) => formatDigest(lookupDigest(e, xs, []))
        const k = rot % Math.max(1, inputs.length)
        const rotated = [...inputs.slice(k), ...inputs.slice(0, k)].reverse()
        expect(key(env, rotated)).toBe(key(env, inputs))
        const sameEnv = env.flushSalt === env2.flushSalt && env.toolchain === env2.toolchain
        expect(key(env2, inputs) === key(env, inputs)).toBe(sameEnv)
        return { valid: inputs.length >= 2, boundary: sameEnv || inputs.length === 0 }
      },
      2_000,
      { domain: "env fields ≤4 chars; ≤5 inputs with distinct paths ≤4 chars", minValidFraction: 0.5, minBoundary: 50 }
    )
  })

  it("law: environments with the same concatenation of fields but different splits get different keys", () => {
    law(
      "field boundaries",
      fc.tuple(fc.string({ maxLength: 6 }), fc.nat(), fc.nat()),
      ([joined, i, j]) => {
        const a = i % (joined.length + 1)
        const b = j % (joined.length + 1)
        const k1 = formatDigest(lookupDigest({ flushSalt: joined.slice(0, a), toolchain: joined.slice(a) }, [], []))
        const k2 = formatDigest(lookupDigest({ flushSalt: joined.slice(0, b), toolchain: joined.slice(b) }, [], []))
        expect(k1 === k2).toBe(a === b)
        return { valid: a !== b, boundary: a === 0 || b === 0 || a === joined.length || b === joined.length }
      },
      2_000,
      { domain: "a string ≤6 chars split at two random positions", minValidFraction: 0.5, minBoundary: 300 }
    )
  })

  it("law: the manifest key is v1/<scope>/m/<digest>/ for every scope and lookup, and differs across scopes", () => {
    law(
      "manifest key layout",
      fc.tuple(fc.oneof(fc.tuple(validScope, validScope), validScope.map((v) => [v, v] as const)), fc.string({ maxLength: 8 })),
      ([[s1, s2], x]) => {
        const k = d(x)
        expect(manifestKey(s1, k)).toBe(`v1/${s1}/m/${formatDigest(k).replace(/%/g, "%25")}/`)
        expect(manifestKey(s1, k) === manifestKey(s2, k)).toBe(s1 === s2)
        return { valid: true, boundary: s1 === s2 }
      },
      1_000,
      { domain: "scope pairs ≤8 chars over {a,b,-,1} (half of them equal on purpose); lookups of random strings", minValidFraction: 1, minBoundary: 300 }
    )
  })
})
