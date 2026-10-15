/**
 * Bisection sessions (`src/bisect/session.ts`, `src/bisect/drive.ts`).
 *
 * Requirements (abstract):
 * S1 With a deterministic test (the bug always shows at and after the
 *    culprit, never before), driving a session to the end names the true
 *    culprit for every range size and culprit position, using at most
 *    ⌈log₂ n⌉ test runs.
 * S2 The good commit is never reported as culprit and never ranked, even
 *    when results are recorded at it.
 * S3 `undo` is a left inverse of recording: the status after
 *    record-then-undo equals the status before.
 * S4 A skipped commit is never proposed again; when every remaining commit
 *    is skipped the session stops with `noTestableCommit`.
 * S5 Sessions survive a JSON round trip unchanged, and `parseSession`
 *    rejects values that violate the session invariants.
 * S6 Commit references resolve by full id or unique prefix (≥ 4
 *    characters); short, ambiguous or foreign references are rejected.
 * S7 With a flaky test (the bug shows with probability q < 1 after the
 *    culprit) and the default unknown-rate priors, the reported culprit is
 *    right in a clear majority of runs and far more often than chance.
 * S8 Concurrent writers on one stored session never lose a result
 *    (compare-and-swap with retry).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilled, SEED } from "../harness.js"
import {
  type BisectSession,
  type CommitInfo,
  driveSession as driveSessionEffect,
  makeMemorySessionStore,
  makeSession,
  modifySession,
  parseSession,
  recordResult,
  recordSkip,
  resolveSessionCommit,
  SessionError,
  sessionStatus,
  startSession,
  type RunOutcome,
  type SessionStore,
  undoLast
} from "../../src/bisect/index.js"
import { Effect, runPromiseOrThrow } from "../../src/fx/index.js"
import { SessionId } from "../../src/ids.js"
import { withRepo } from "./run.js"

/** `driveSession` with a synchronous test predicate, as a Promise. */
const driveSession = (s0: BisectSession, run: (c: CommitInfo) => RunOutcome, opts: { readonly now: () => number }) =>
  runPromiseOrThrow(driveSessionEffect(s0, (c) => Effect.sync(() => run(c)), opts))
import { makeFakeNamespace, makeRepo } from "./fakeArtifacts.js"

announce("test/bisect/session.test.ts")

const prng = (seed: number) => {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const commits = (n: number, salt = 0): CommitInfo[] =>
  Array.from({ length: n }, (_, i) => ({ oid: (salt * 7919 + i).toString(16).padStart(8, "0") + "c".repeat(32), message: `m${i}` }))

const session = (n: number, extra: Partial<Parameters<typeof makeSession>[0]> = {}): BisectSession => {
  const all = commits(n + 1, extra.now ?? 0)
  return makeSession({ repo: "r", goodRef: "g", badRef: "b", good: all[0]!, candidates: all.slice(1), now: 0, ...extra })
}

const deterministic = { newRate: { kind: "known", p: 1 } as const, oldRate: { kind: "known", p: 0 } as const }

describe("session search", () => {
  it("law S1: deterministic test → true culprit in ≤ ⌈log₂ n⌉ runs (exhaustive for n ≤ 48)", async () => {
    let cases = 0
    for (let n = 1; n <= 48; n++) {
      for (let culprit = 0; culprit < n; culprit++) {
        const s0 = session(n, { ...deterministic, confidence: 1 })
        let runs = 0
        const { status } = await driveSession(
          s0,
          (c) => {
            runs++
            return s0.candidates.findIndex((x) => x.oid === c.oid) >= culprit
          },
          { now: () => 0 }
        )
        expect(status.culprit.oid).toBe(s0.candidates[culprit]!.oid)
        expect(status.stopReason).toBe("confidence")
        expect(runs).toBeLessThanOrEqual(Math.ceil(Math.log2(n)))
        cases++
      }
    }
    console.log(`[law] S1 exhaustive cases: ${cases}`)
  })

  it("law S2: the good commit is never the culprit nor ranked, whatever is recorded at it", () => {
    law(
      "good commit excluded",
      fc.record({
        n: fc.integer({ min: 1, max: 30 }),
        atGood: fc.array(fc.boolean(), { maxLength: 8 }),
        elsewhere: fc.array(fc.record({ at: fc.nat(), failed: fc.boolean() }), { maxLength: 20 })
      }),
      ({ n, atGood, elsewhere }) => {
        let s = session(n)
        for (const failed of atGood) s = recordResult(s, s.good.oid, failed, 0)
        for (const e of elsewhere) s = recordResult(s, s.candidates[e.at % n]!.oid, e.failed, 0)
        const st = sessionStatus(s, n + 1)
        expect(st.culprit.oid).not.toBe(s.good.oid)
        expect(st.ranking.map((r) => r.commit.oid)).not.toContain(s.good.oid)
        expect(st.ranking.length).toBe(n)
        expect(st.ranking.reduce((a, r) => a + r.probability, 0)).toBeCloseTo(1, 9)
        return { valid: atGood.length > 0, boundary: n === 1 || elsewhere.length === 0 || atGood.every((f) => f) }
      },
      300,
      { domain: "n 1–30, ≤ 8 results at the good commit (any outcome), ≤ 20 elsewhere", minValidFraction: 0.6, minBoundary: 10 }
    )
  })

  it("law S3: undo after record restores the status exactly", () => {
    law(
      "undo ∘ record = id (status)",
      fc.record({
        n: fc.integer({ min: 1, max: 25 }),
        history: fc.array(fc.record({ at: fc.nat(), failed: fc.boolean(), skip: fc.boolean() }), { maxLength: 15 }),
        last: fc.record({ at: fc.nat(), failed: fc.boolean(), skip: fc.boolean() })
      }),
      ({ n, history, last }) => {
        const apply = (s: BisectSession, e: { at: number; failed: boolean; skip: boolean }) => {
          const c = s.candidates[e.at % n]!
          return e.skip ? recordSkip(s, c.oid, 1) : recordResult(s, c.oid, e.failed, 1)
        }
        const s = history.reduce(apply, session(n))
        expect(sessionStatus(undoLast(apply(s, last)))).toEqual(sessionStatus(s))
        return { valid: true, boundary: history.length === 0 || n === 1 }
      },
      300,
      { domain: "n 1–25, ≤ 15 prior events (results and skips)", minValidFraction: 1, minBoundary: 10 }
    )
    expect(() => undoLast(session(3))).toThrow(SessionError)
  })

  it("law S4: skipped commits are never proposed; all skipped → noTestableCommit", () => {
    law(
      "skips respected",
      // Boundary generator (H6): a quarter of the cases skip every candidate. With random skip sets alone,
      // "all skipped" occurred in about 1–2 % of cases, so the boundary threshold failed by chance.
      fc.record({ n: fc.integer({ min: 1, max: 20 }), skips: fc.uniqueArray(fc.nat({ max: 19 }), { maxLength: 20 }), known: fc.boolean(), all: fc.integer({ min: 0, max: 3 }) }),
      ({ n, skips, known, all }) => {
        let s = session(n, known ? deterministic : {})
        const chosen = all === 0 ? Array.from({ length: n }, (_, i) => i) : skips
        const skipped = new Set(chosen.filter((i) => i < n).map((i) => s.candidates[i]!.oid))
        for (const oid of skipped) s = recordSkip(s, oid, 0)
        const st = sessionStatus(s)
        if (st.next !== null) expect(skipped.has(st.next.oid)).toBe(false)
        if (skipped.size === n && known) {
          expect(st.done).toBe(true)
          expect(st.stopReason).toBe(n === 1 ? "confidence" : "noTestableCommit")
        }
        return { valid: skipped.size > 0, boundary: skipped.size === n }
      },
      300,
      { domain: "n 1–20, random skip sets (a quarter: every candidate), known or unknown rates", minValidFraction: 0.5, minBoundary: 5 }
    )
  })

  it("law S5: JSON round trip is the identity; invalid sessions are rejected", () => {
    law(
      "parseSession",
      fc.record({ n: fc.integer({ min: 1, max: 20 }), events: fc.array(fc.record({ at: fc.nat(), failed: fc.boolean() }), { maxLength: 10 }), corrupt: fc.constantFrom("none", "version", "event", "prior", "dup", "rate") }),
      ({ n, events, corrupt }) => {
        let s = session(n)
        for (const e of events) s = recordResult(s, s.candidates[e.at % n]!.oid, e.failed, 5)
        const json = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
        if (corrupt === "none") {
          expect(parseSession(json)).toEqual(s)
          return { valid: true, boundary: events.length === 0 || n === 1 }
        }
        if (corrupt === "version") json["version"] = 2
        if (corrupt === "event") json["events"] = [...(json["events"] as unknown[]), { kind: "observe", oid: "not-in-range", failed: true, at: 0 }]
        if (corrupt === "prior") json["prior"] = [1, ...Array.from({ length: n }, () => 1)]
        if (corrupt === "dup") json["candidates"] = [...(json["candidates"] as unknown[]), json["good"]]
        if (corrupt === "rate") json["newRate"] = { kind: "known", p: 2 }
        expect(() => parseSession(json)).toThrow(SessionError)
        return { valid: true, boundary: events.length === 0 || n === 1 }
      },
      300,
      { domain: "n 1–20, ≤ 10 events, five kinds of corruption", minValidFraction: 1, minBoundary: 5 }
    )
  })

  /*
   * S6 as a rule: a reference resolves iff it is a full id of a commit in the
   * session, or a prefix of ≥ 4 characters matching exactly one of them.
   *
   * The previous version checked this over ONE hand-picked session whose ids
   * diverge at the 4th character, so the branch "≥ 4 characters but
   * ambiguous" was never generated: an implementation returning the first
   * match passed. The ids are now generated with shared prefixes of random
   * length (0–12), so ambiguity occurs at every length up to 12.
   */
  const hex = fc.stringMatching(/^[0-9a-f]{40}$/)
  const sessionWithSharedPrefixes = fc
    .record({ base: fc.array(hex, { minLength: 2, maxLength: 6 }), shared: fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 5, maxLength: 5 }) })
    .map(({ base, shared }) => {
      // id i (i ≥ 1) copies the first shared[i-1] characters of id i-1.
      const ids = base.map((x, i) => (i === 0 ? x : base[i - 1]!.slice(0, shared[(i - 1) % shared.length]!) + x.slice(shared[(i - 1) % shared.length]!)))
      return [...new Set(ids)]
    })
    .filter((ids) => ids.length >= 2)
  const refQuery = sessionWithSharedPrefixes.chain((ids) =>
    fc.record({
      ids: fc.constant(ids),
      ref: fc.oneof(
        { weight: 4, arbitrary: fc.record({ which: fc.nat({ max: ids.length - 1 }), len: fc.integer({ min: 1, max: 40 }) }).map(({ which, len }) => ids[which]!.slice(0, len)) },
        { weight: 1, arbitrary: fc.stringMatching(/^[0-9a-f]{1,40}$/) }
      )
    })
  )
  const sessionOf = (ids: ReadonlyArray<string>) =>
    makeSession({ repo: "r", goodRef: "g", badRef: "b", good: { oid: ids[0]! }, candidates: ids.slice(1).map((oid) => ({ oid })), now: 0 })
  /** Oracle from the rule (not from the implementation). */
  const expectedResolution = (ids: ReadonlyArray<string>, ref: string): string | null => {
    if (ids.includes(ref)) return ref
    if (ref.length < 4) return null
    const m = ids.filter((id) => id.startsWith(ref))
    return m.length === 1 ? m[0]! : null
  }
  type Resolver = (s: BisectSession, ref: string) => { oid: string }
  const resolvesLikeRule = (resolve: Resolver, ids: ReadonlyArray<string>, ref: string): boolean => {
    const want = expectedResolution(ids, ref)
    let got: string | null
    try {
      got = resolve(sessionOf(ids), ref).oid
    } catch (e) {
      if (!(e instanceof SessionError) && resolve === resolveSessionCommit) throw e
      got = null
    }
    return got === want
  }
  /** Mutant 1: first match wins (ambiguous prefixes accepted). */
  const firstMatch: Resolver = (s, ref) => {
    const all = [s.good, ...s.candidates]
    const c = all.find((x) => x.oid === ref) ?? (ref.length >= 4 ? all.find((x) => x.oid.startsWith(ref)) : undefined)
    if (c === undefined) throw new SessionError("no match")
    return c
  }
  /** Mutant 2: no minimum length (unique prefixes of 1–3 characters accepted). */
  const noMinimum: Resolver = (s, ref) => {
    const all = [s.good, ...s.candidates]
    const m = all.filter((x) => x.oid.startsWith(ref))
    if (m.length !== 1) throw new SessionError("ambiguous or missing")
    return m[0]!
  }

  it("law S6: references resolve by full id or unique prefix (≥ 4 chars) only — ids with shared prefixes", () => {
    let ambiguousLong = 0
    law(
      "resolveSessionCommit",
      refQuery,
      ({ ids, ref }) => {
        expect(resolvesLikeRule(resolveSessionCommit, ids, ref), `${ref} in ${ids.join(",")}`).toBe(true)
        const matches = ids.filter((id) => id.startsWith(ref)).length
        if (ref.length >= 4 && matches > 1) ambiguousLong++
        return { valid: matches > 0, boundary: ref.length === 3 || ref.length === 4 || (ref.length >= 4 && matches > 1) }
      },
      400,
      { domain: "2–6 ids of 40 hex chars sharing prefixes of 0–12 chars; refs = prefixes of length 1–40 (4/5) or random hex (1/5)", minValidFraction: 0.6, minBoundary: 30 }
    )
    // The branch the old test never reached must now be exercised.
    expect(ambiguousLong).toBeGreaterThan(5)
  })

  it("S6 counterexample 1 (mutant: first match wins): two ids sharing 6 characters, reference = 5-character prefix", () => {
    const ids = ["abcdef" + "1".repeat(34), "abcdef" + "2".repeat(34), "9".repeat(40)]
    expect(resolvesLikeRule(resolveSessionCommit, ids, "abcde")).toBe(true) // control: rejected as ambiguous
    expect(() => resolveSessionCommit(sessionOf(ids), "abcde")).toThrow(SessionError)
    expect(resolvesLikeRule(firstMatch, ids, "abcde")).toBe(false)
  })

  it("S6 counterexample 2 (mutant: no minimum length): a unique 1-character prefix", () => {
    const ids = ["1234" + "0".repeat(36), "a".repeat(40)]
    expect(resolvesLikeRule(resolveSessionCommit, ids, "a")).toBe(true) // control: too short, rejected
    expect(resolvesLikeRule(noMinimum, ids, "a")).toBe(false)
  })

  it("S6 negation 1: the law is refuted for the first-match mutant on generated sessions", () => {
    expect(mutantKilled(refQuery, ({ ids, ref }) => resolvesLikeRule(firstMatch, ids, ref), 400)).toBe(true)
  })

  it("S6 negation 2: the law is refuted for the no-minimum-length mutant on generated sessions", () => {
    expect(mutantKilled(refQuery, ({ ids, ref }) => resolvesLikeRule(noMinimum, ids, ref), 400)).toBe(true)
  })

  it("startSession over the Artifacts binding records the good commit and the range", async () => {
    const { repo, mainline } = makeRepo(40, { mergesAt: [10, 20] })
    const ns = makeFakeNamespace({ r: repo }, { idField: "id" })
    const s = await withRepo(ns, "r", (h) => startSession(h, { repo: "r", goodRef: mainline[5]!, badRef: "main", now: 1 }))
    expect(s.good.oid).toBe(mainline[5])
    expect(s.candidates.map((c) => c.oid)).toEqual(mainline.slice(6))
    expect(ns.disposed()).toBe(ns.opened())
  })
})

describe("flaky tests (S7)", () => {
  it("default unknown-rate priors find the culprit in a clear majority of flaky runs", async () => {
    const rand = prng(SEED ^ 0x5e55)
    const trials = 60
    let right = 0
    for (let t = 0; t < trials; t++) {
      const n = 8 + Math.floor(rand() * 40)
      const culprit = Math.floor(rand() * n)
      const q = 0.6 + rand() * 0.35 // probability that the bug shows at a bad commit
      const s0 = session(n, { confidence: 0.95, maxSteps: 150, now: t })
      const { status } = await driveSession(
        s0,
        (c) => s0.candidates.findIndex((x) => x.oid === c.oid) >= culprit && rand() < q,
        { now: () => 0 }
      )
      if (status.culprit.oid === s0.candidates[culprit]!.oid) right++
    }
    console.log(`[law] S7 flaky accuracy: ${right}/${trials} (chance ≈ ${(trials / 28).toFixed(1)})`)
    // Measured 57–60/60 over nine seeds (FC_SEED 1–8 and a fresh one); 40/60 leaves a wide
    // margin, while picking uniformly at random would score about 2/60.
    expect(right).toBeGreaterThanOrEqual(40)
  })
})

describe("concurrent writers (S8)", () => {
  it("law S8: k concurrent result writers on one session all land", async () => {
    await lawAsync(
      "no lost updates",
      fc.record({ n: fc.integer({ min: 2, max: 20 }), k: fc.integer({ min: 1, max: 12 }), seed: fc.integer() }),
      async ({ n, k, seed }) => {
        const inner = makeMemorySessionStore()
        const rand = prng(seed)
        // Interleave: every store call yields to the other fibers a random number of times.
        const yieldSome = Effect.suspend(() => Effect.forEach(Array.from({ length: Math.floor(rand() * 4) }), () => Effect.yieldNow))
        const store: SessionStore = {
          load: (id) => Effect.andThen(yieldSome, inner.load(id)),
          create: (id, s) => Effect.andThen(yieldSome, inner.create(id, s)),
          update: (id, s, v) => Effect.andThen(yieldSome, inner.update(id, s, v))
        }
        const s0 = session(n)
        const final = await runPromiseOrThrow(
          Effect.gen(function* () {
            yield* store.create(SessionId("id"), s0)
            yield* Effect.all(
              Array.from({ length: k }, (_, i) => modifySession(store, SessionId("id"), (s) => recordResult(s, s.candidates[i % n]!.oid, i % 2 === 0, i), 50)),
              { concurrency: "unbounded" }
            )
            return (yield* store.load(SessionId("id")))!.session
          })
        )
        expect(final.events.length).toBe(k)
        expect(new Set(final.events.map((e) => e.at)).size).toBe(k)
        return { valid: k > 1, boundary: k === 1 }
      },
      60,
      { domain: "n 2–20, 1–12 writers, random interleavings", minValidFraction: 0.8, minBoundary: 1 }
    )
  })
})
