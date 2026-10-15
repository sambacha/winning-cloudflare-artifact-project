/**
 * Status after the third test pass (`docs/test-review.md` §TS-Ke): the
 * hand-picked examples of this file (paper collision, scope names, field
 * boundaries, manifest layout) are labelled regressions; the laws they are
 * instances of are in `keyLaws.test.ts`, with inverse round trips, oracles,
 * boundary generators and counts.
 *
 * Keys and digests: D-4 (key encoding), D-5 (tagged digests), D-2 (Merkle
 * lookup keys), D-1 (scopes).
 *
 * Every property is paired with a mutant that must fail it, so the property
 * is not vacuous (the verification rule D-15: satisfiable hypotheses, proof /
 * test on the real code, a named mutant that breaks it).
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, params } from "../harness.js"
import { digestBytes, formatDigest, parseDigest } from "../../src/cache/digest.js"
import {
  decodeKey,
  encodeKey,
  isComponentPrefix,
  KeyTooLong,
  MalformedComponent,
  MAX_KEY_BYTES
} from "../../src/cache/keyEncoding.js"
import {
  type KeyEnvironment,
  type PackageInputs,
  computeLookupDigests,
  DependencyCycle,
  DuplicateInputPath,
  lookupDigest,
  manifestKey,
  UnknownDependency
} from "../../src/cache/lookupKey.js"
import { canWrite, InvalidScope, makeScope, readScopes } from "../../src/cache/scope.js"

announce("test/cache/keys.test.ts")

/** Components drawn from an alphabet rich in separators and escape characters. */
const component = fc.string({
  unit: fc.constantFrom("a", "b", "/", "%", "2", "F", "\n", "é", "😀"),
  maxLength: 6
})
const components = fc.array(component, { maxLength: 5 })
const naiveKey = (cs: ReadonlyArray<string>) => ["v1", ...cs].join("/")

describe("D-4 key encoding", () => {
  it("property: decodeKey ∘ encodeKey = id", () => {
    fc.assert(fc.property(components, (cs) => { expect(decodeKey(encodeKey(cs))).toEqual(cs) }), params(2000))
  })

  it("property: injective (distinct component lists → distinct keys)", () => {
    fc.assert(
      fc.property(components, components, (p, q) => {
        fc.pre(JSON.stringify(p) !== JSON.stringify(q))
        expect(encodeKey(p)).not.toBe(encodeKey(q))
      }),
      params(5000)
    )
  })

  it("property: string prefix ⇔ component prefix (enc_prefix_iff)", () => {
    let prefixCases = 0
    fc.assert(
      fc.property(components, components, (p, q) => {
        const ab = encodeKey(q).startsWith(encodeKey(p))
        if (ab) prefixCases++
        expect(ab).toBe(isComponentPrefix(p, q))
      }),
      params(5000)
    )
    // Non-vacuity: the generator really produces the "prefix" side too.
    expect(prefixCases).toBeGreaterThan(50)
  })

  it("prefix property on extended lists (q = p ++ r always passes)", () => {
    fc.assert(
      fc.property(components, components, (p, r) => {
        expect(encodeKey([...p, ...r]).startsWith(encodeKey(p))).toBe(true)
      }),
      params(1000)
    )
  })

  it("mutant (naive '/'-join) violates both properties: fast-check finds it, and the paper example", () => {
    // naive_not_injective: ("a","b/c") and ("a/b","c").
    expect(naiveKey(["a", "b/c"])).toBe(naiveKey(["a/b", "c"]))
    expect(encodeKey(["a", "b/c"])).not.toBe(encodeKey(["a/b", "c"]))
    // naive_prefix_collateral: branch "a" is a string prefix of branch "a/e1"'s keys.
    expect(naiveKey(["r", "a/e1", "h"]).startsWith(naiveKey(["r", "a"]))).toBe(true)
    expect(encodeKey(["r", "a/e1", "h"]).startsWith(encodeKey(["r", "a"]))).toBe(false)
    const r = fc.check(
      fc.property(components, components, (p, q) => naiveKey(q).startsWith(naiveKey(p)) === isComponentPrefix(p, q)),
      params(5000)
    )
    expect(r.failed).toBe(true)
  })

  it("scope prefixes are disjoint: nothing under 'trusted' is under 'trusted-fork' and vice versa", () => {
    expect(encodeKey(["trusted-fork", "m", "x"]).startsWith(encodeKey(["trusted"]))).toBe(false)
    expect(encodeKey(["trusted", "m", "x"]).startsWith(encodeKey(["trusted"]))).toBe(true)
  })

  it("rejects keys longer than R2's limit and lone surrogates", () => {
    expect(() => encodeKey(["x".repeat(MAX_KEY_BYTES)])).toThrow(KeyTooLong)
    expect(() => encodeKey(["\uD800"])).toThrow(MalformedComponent)
    // R2 NFC-normalizes key names: a decomposed component would collide with its composed form.
    expect(() => encodeKey(["caf\u0065\u0301"])).toThrow(MalformedComponent)
    expect(encodeKey(["caf\u00e9"])).toBe("v1/caf\u00e9/")
    expect(decodeKey("v1/cafe\u0301/")).toBeNull()
    expect(() => encodeKey(["\uD83D\uDE00"])).not.toThrow()
  })

  it("decodeKey rejects non-canonical and foreign-layout keys", () => {
    expect(decodeKey("v2/a/")).toBeNull()
    expect(decodeKey("v1/a")).toBeNull()
    expect(decodeKey("v1/%2f/")).toBeNull() // lower-case escape is not canonical
    expect(decodeKey("v1/%41/")).toBeNull() // 'A' must not be escaped
    expect(decodeKey("v1/%2F/")).toEqual(["/"])
  })
})

describe("D-5 tagged digests", () => {
  it("property: parse ∘ format = id, for any even hex length", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 80 }), (bytes) => {
        const hex = Buffer.from(bytes).toString("hex")
        expect(parseDigest(formatDigest({ alg: "blake3", hex }))).toEqual({ alg: "blake3", hex })
      }),
      params(500)
    )
  })

  it("rejects unknown algorithms, missing tags, upper case and odd lengths (→ cache miss)", () => {
    const h = digestBytes(new Uint8Array([1])).hex
    for (const bad of [`sha256:${h}`, h, `blake3:${h.toUpperCase()}`, `blake3:${h}0`, "blake3:", ":ab"]) {
      expect(parseDigest(bad)).toBeNull()
    }
    expect(parseDigest(`blake3:${h}`)?.hex).toBe(h)
  })
})

describe("D-1 scopes", () => {
  const trusted = makeScope("trusted")
  const fork = makeScope("fork-pr")
  const policy = { trusted: [trusted] }

  it("trusted jobs read only trusted scopes; untrusted read trusted then their own", () => {
    expect(readScopes(policy, { scope: trusted })).toEqual([trusted])
    expect(readScopes(policy, { scope: fork })).toEqual([trusted, fork])
  })

  it("a job writes only into its own scope", () => {
    expect(canWrite({ scope: fork }, trusted)).toBe(false)
    expect(canWrite({ scope: fork }, fork)).toBe(true)
  })

  it("scope names are validated (no '/', no branch-like names, non-empty)", () => {
    for (const bad of ["", "feat/x", "Trusted", "-x", "a".repeat(64)]) expect(() => makeScope(bad)).toThrow(InvalidScope)
  })
})

// ---------------------------------------------------------------------------
// D-2 Merkle lookup keys

const env: KeyEnvironment = { flushSalt: "salt-1", toolchain: "node22" }
const d = (s: string) => digestBytes(new TextEncoder().encode(s))

/** Random DAG on n nodes: node i may depend only on nodes j > i (acyclic by construction). */
const dagArb = fc.integer({ min: 2, max: 7 }).chain((n) =>
  fc.tuple(
    fc.constant(n),
    fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), { minLength: n, maxLength: n }),
    fc.array(fc.string({ maxLength: 3 }), { minLength: n, maxLength: n })
  )
)

const buildGraph = (n: number, adj: boolean[][], contents: string[]): Map<string, PackageInputs> => {
  const g = new Map<string, PackageInputs>()
  for (let i = 0; i < n; i++) {
    const deps: string[] = []
    for (let j = i + 1; j < n; j++) if (adj[i]![j]) deps.push(`p${j}`)
    g.set(`p${i}`, { inputs: [{ path: "src/index.ts", digest: d(contents[i]!) }], deps })
  }
  return g
}

const dependsOn = (g: Map<string, PackageInputs>, from: string, to: string): boolean => {
  if (from === to) return true
  return g.get(from)!.deps.some((x) => dependsOn(g, x, to))
}

/** Mutant: shallow keys that ignore dependencies (`shallow_key_stale_hit`). */
const shallowDigests = (g: Map<string, PackageInputs>) =>
  new Map([...g].map(([id, p]) => [id, lookupDigest(env, p.inputs, [])] as const))

describe("D-2 Merkle lookup keys", () => {
  it("property: changing package m's input changes exactly the keys of packages that depend on m", () => {
    let unaffectedSeen = 0
    fc.assert(
      fc.property(dagArb, fc.nat(), ([n, adj, contents], pick) => {
        const m = pick % n
        const g1 = buildGraph(n, adj, contents)
        const changed = [...contents]
        changed[m] = changed[m] + "!"
        const g2 = buildGraph(n, adj, changed)
        const k1 = computeLookupDigests(env, g1)
        const k2 = computeLookupDigests(env, g2)
        for (const id of g1.keys()) {
          const affected = dependsOn(g1, id, `p${m}`)
          if (!affected) unaffectedSeen++
          // merkle_key_changes / merkle_unaffected_preserved
          expect(formatDigest(k1.get(id)!) !== formatDigest(k2.get(id)!)).toBe(affected)
        }
      }),
      params(300)
    )
    expect(unaffectedSeen).toBeGreaterThan(100)
  })

  it("mutant: shallow keys give a stale hit (a dependent keeps its key although a dependency changed)", () => {
    const r = fc.check(
      fc.property(dagArb, fc.nat(), ([n, adj, contents], pick) => {
        const m = pick % n
        const g1 = buildGraph(n, adj, contents)
        const changed = [...contents]
        changed[m] = changed[m] + "!"
        const k1 = shallowDigests(g1)
        const k2 = shallowDigests(buildGraph(n, adj, changed))
        return [...g1.keys()].every(
          (id) => (formatDigest(k1.get(id)!) !== formatDigest(k2.get(id)!)) === dependsOn(g1, id, `p${m}`)
        )
      }),
      params(300)
    )
    expect(r.failed).toBe(true)
  })

  it("the flush salt and the toolchain change every key; input order does not", () => {
    const inputs = [
      { path: "a", digest: d("1") },
      { path: "b", digest: d("2") }
    ]
    const base = formatDigest(lookupDigest(env, inputs, []))
    expect(formatDigest(lookupDigest({ ...env, flushSalt: "salt-2" }, inputs, []))).not.toBe(base)
    expect(formatDigest(lookupDigest({ ...env, toolchain: "node24" }, inputs, []))).not.toBe(base)
    expect(formatDigest(lookupDigest(env, [...inputs].reverse(), []))).toBe(base)
  })

  it("field boundaries are unambiguous (no concatenation collisions)", () => {
    const a = lookupDigest({ flushSalt: "ab", toolchain: "c" }, [], [])
    const b = lookupDigest({ flushSalt: "a", toolchain: "bc" }, [], [])
    expect(formatDigest(a)).not.toBe(formatDigest(b))
    const p1 = lookupDigest(env, [{ path: "x", digest: d("1") }], [])
    const p2 = lookupDigest(env, [{ path: "y", digest: d("1") }], [])
    expect(formatDigest(p1)).not.toBe(formatDigest(p2))
  })

  it("rejects duplicate input paths, cycles and unknown dependencies", () => {
    expect(() =>
      lookupDigest(env, [
        { path: "a", digest: d("1") },
        { path: "a", digest: d("2") }
      ], [])
    ).toThrow(DuplicateInputPath)
    const cyc = new Map<string, PackageInputs>([
      ["x", { inputs: [], deps: ["y"] }],
      ["y", { inputs: [], deps: ["x"] }]
    ])
    expect(() => computeLookupDigests(env, cyc)).toThrow(DependencyCycle)
    const unk = new Map<string, PackageInputs>([["x", { inputs: [], deps: ["nope"] }]])
    expect(() => computeLookupDigests(env, unk)).toThrow(UnknownDependency)
  })

  it("the manifest key is v1/<scope>/m/<digest>/ and the scope is not hashed", () => {
    const k = lookupDigest(env, [], [])
    expect(manifestKey(makeScope("trusted"), k)).toBe(`v1/trusted/m/${formatDigest(k)}/`)
    expect(manifestKey(makeScope("fork-pr"), k)).toBe(`v1/fork-pr/m/${formatDigest(k)}/`)
  })
})
