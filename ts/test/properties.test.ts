/**
 * fast-check property tests mirroring the Lean safety theorems.
 *
 * Third pass (rules H1–H8, `docs/test-review.md` §TS-P):
 *
 * - **H2/H8.** Seeds are fresh per run (`test/harness.ts`); `FC_SEED=<n>`
 *   replays a run, and replay is itself asserted (`replay` test below).
 * - **H1/H5/H6.** Every safety property reports total / valid / boundary
 *   counts: a run is *valid* if at least a quarter of its commands had an
 *   effect (the others are no-ops such as renewing a lock one does not
 *   hold), and a *boundary* run contains an `acquire` exactly at the expiry
 *   instant of the current lease or one millisecond after it. Both are
 *   asserted, not just printed.
 * - **H3.** The mutant-adequacy test now runs on fresh seeds; detection
 *   power was measured over 40 seeds (`docs/test-review.md`).
 *
 * Earlier notes (second pass), kept for the history of the file:
 *
 * Rewritten against `docs/testing-guidelines.md` (see `docs/test-audit.md`):
 *
 * - **E3 (superseded by H2).** Seeds used to be fixed; they are now fresh
 *   per run and logged, with `FC_SEED` for replay.
 * - **A2 / B5 (antecedent coverage).** `simulate` returns counts of the
 *   interesting events (takeovers, 429s, stale writes rejected, `completed`
 *   observed by another job, two jobs believing they hold a lock). The
 *   coverage test asserts each stratum is hit at least `MIN_HITS` times over
 *   the seeded runs; `MIN_HITS = ceil(ln(1/δ))` for δ = 10⁻³.
 * - **E1 (mutation adequacy).** The same property is run against planted
 *   mutants of R2 (`test/mutantStore.ts`). Every non-neutral mutant must be
 *   detected; the neutral one (stale reads) must *not* be, and its neutrality
 *   is justified by the Lean fencing theorem rather than eyeballed.
 * - The old "the generator produces real contention" test asserted only that
 *   a hand-written list did not throw; it is replaced by the coverage test
 *   and by a hand-written run that asserts the takeover actually happened.
 *
 * Time is virtual: one global clock `t` (R2's), each job reading `t + offset`.
 * `Effect.sleep` (rate-limit retries) advances `t` immediately.
 */
import { Clock, Duration, Effect, Result } from "../src/fx/index.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type CobuildLock, type HeldLock, makeCobuildLock, type MemoryStore } from "../src/index.js"
import { announce, assertMeaningful, params, replay, SEED, type Tally } from "./harness.js"
import { makeMutantStore, type Mutation } from "./mutantStore.js"
import { CacheKey, JobId } from "../src/ids.js"

announce("test/properties.test.ts")

const JOBS = [0, 1, 2] as const
const KEYS = ["a", "b"] as const
type Job = (typeof JOBS)[number]
type Key = (typeof KEYS)[number]

type Cmd =
  | { readonly t: "tick"; readonly d: number }
  | { readonly t: "acquire"; readonly j: Job; readonly k: Key }
  | { readonly t: "renew"; readonly j: Job; readonly k: Key }
  | { readonly t: "publish"; readonly j: Job; readonly k: Key; readonly ok: boolean }
  | { readonly t: "abandon"; readonly j: Job; readonly k: Key }

const job = fc.constantFrom(...JOBS)
const key = fc.constantFrom(...KEYS)
/**
 * Tick amounts are biased to the thresholds (B1): 999/1000/1001 around the
 * rate limit, 30 000/30 001 at a lease. The lease-length ticks are weighted up
 * (B5): with uniform 0–12 s ticks only 6 of 500 runs contained a takeover, and
 * the `ignoreIfMatch` mutant survived (see `docs/test-audit.md`, second pass).
 */
const tickAmount = fc.oneof(
  { arbitrary: fc.constantFrom(0, 500, 999, 1_000, 1_001, 10_000), weight: 2 },
  { arbitrary: fc.constantFrom(30_000, 30_001), weight: 2 },
  { arbitrary: fc.integer({ min: 0, max: 12_000 }), weight: 1 }
)
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant("tick" as const), d: tickAmount }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant("acquire" as const), j: job, k: key }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant("renew" as const), j: job, k: key }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant("publish" as const), j: job, k: key, ok: fc.boolean() }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("abandon" as const), j: job, k: key }), weight: 2 }
)
/**
 * `size: "max"` is essential: with fast-check's default size, `maxLength: 80`
 * still yields at most 10 commands (mean 4.3 over the seeded runs), so the
 * old suite never ran past a lease renewal cycle (second pass in
 * `docs/test-audit.md`).
 */
const cmds = fc.array(cmd, { maxLength: 80, size: "max" })
/**
 * Skew offsets with a boundary generator (H6): equal clocks, ±1 ms, ±1 s and
 * ±a lease are sampled on purpose; uniform offsets almost never make the
 * acquirer's clock hit the expiry instant exactly (3 boundary runs in 500).
 */
const offset = fc.oneof(
  { arbitrary: fc.constantFrom(0, 1, -1, 1_000, -1_000, 30_000, -30_000), weight: 3 },
  { arbitrary: fc.integer({ min: -20_000, max: 20_000 }), weight: 1 }
)
const offsets = fc.array(offset, { minLength: 3, maxLength: 3 })

/** Run count shared by all randomized tests; the seed comes from the harness (H2). */
const RUNS = 500
/** ceil(ln(1/δ)) for δ = 10⁻³ (B5): minimum hits per coverage stratum. */
const MIN_HITS = Math.ceil(Math.log(1 / 1e-3))

interface World {
  t: number
}

const virtualClock = (w: World, offset: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => w.t + offset,
  currentTimeMillis: Effect.sync(() => w.t + offset),
  currentTimeNanosUnsafe: () => BigInt(w.t + offset) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(w.t + offset) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(w.t + offset) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(w.t + offset) * 1_000_000n),
  sleep: (d: Duration.Duration) =>
    Effect.sync(() => {
      w.t += Duration.toMillis(d)
    })
})

/** Counts of interesting events in one run (A2). */
interface Stats {
  takeovers: number
  rateLimited: number
  staleRejected: number
  completedSeen: number
  twoBelievers: number
}

/** Per-run meaningfulness counts (H1, H6), kept apart from the coverage strata. */
interface RunInfo {
  readonly stats: Stats
  /** Commands that were not skipped as no-ops. */
  readonly effective: number
  /** `acquire` attempts exactly at `expiresAt` or `expiresAt + 1` of the current manifest. */
  readonly boundaryAcquires: number
  /** Final R2 state, for the replay property. */
  readonly snapshot: ReadonlyArray<unknown>
}

/**
 * Run a command list against a fresh store; check the invariants after every
 * step (throws on violation) and return the event counts.
 */
const simulateRun = (
  cmdList: ReadonlyArray<Cmd>,
  offs: ReadonlyArray<number>,
  mutation: Mutation = "none",
  /** Use the lock's default (random) nonce source: the replay mutant. */
  hiddenRandomness = false
): RunInfo => {
  let effective = 0
  let boundaryAcquires = 0
  const skewFree = offs.every((o) => o === 0)
  const w: World = { t: 1_000_000 }
  const store: MemoryStore = makeMutantStore(mutation, 1_000, () => w.t)
  // Deterministic nonce source (rule 5: randomness is a parameter), shared by
  // the three jobs so nonces stay unique within the run.
  let nonceCounter = 0
  const nonce = () => `n${nonceCounter++}`
  const locks: ReadonlyArray<CobuildLock> = JOBS.map((j) =>
    makeCobuildLock(store, hiddenRandomness ? { scope: "trusted", context: "ctx/1", jobId: JobId(`job${j}`) } : { scope: "trusted", context: "ctx/1", jobId: JobId(`job${j}`), nonce })
  )
  const held = new Map<string, HeldLock>()
  const hk = (j: Job, k: Key) => `${j}|${k}`
  const succeeded = new Map<Key, { etag: string; body: string }>()
  const stats: Stats = { takeovers: 0, rateLimited: 0, staleRejected: 0, completedSeen: 0, twoBelievers: 0 }
  const runAs = <A, E>(j: Job, eff: Effect.Effect<A, E>) =>
    Effect.runSync(Effect.result(Effect.provideService(eff, Clock.Clock, virtualClock(w, offs[j] ?? 0))))

  const objectKey = (k: Key) => locks[0]!.objectKey(CacheKey(k))

  const check = () => {
    for (const k of KEYS) {
      const cur = store.peek(objectKey(k))
      // `no_duplicate_builds` / `cache_coherence`: a succeeded manifest never changes.
      const s = succeeded.get(k)
      if (s) expect(cur).toEqual(s)
      else if (cur && JSON.parse(cur.body).outcome.status === "succeeded") {
        succeeded.set(k, { etag: cur.etag, body: cur.body })
      }
      // `rate_limit_compliance`: accepted writes to a key are >= 1 s apart (R2 time).
      const log = store.writeLog.get(objectKey(k)) ?? []
      for (let i = 1; i < log.length; i++) expect(log[i]! - log[i - 1]!).toBeGreaterThanOrEqual(1_000)
      const believers = JOBS.filter((j) => held.has(hk(j, k)))
      if (believers.length >= 2) stats.twoBelievers++
      if (skewFree) {
        // `mutual_exclusion`: at most one job holds an unexpired lease, and its
        // manifest is the current object.
        const valid = JOBS.filter((j) => {
          const h = held.get(hk(j, k))
          return h !== undefined && w.t <= h.manifest.expiresAt
        })
        expect(valid.length).toBeLessThanOrEqual(1)
        for (const j of valid) expect(held.get(hk(j, k))!.etag).toBe(cur?.etag)
      }
    }
  }

  for (const c of cmdList) {
    switch (c.t) {
      case "tick":
        w.t += c.d
        if (c.d > 0) effective++
        break
      case "acquire": {
        if (held.has(hk(c.j, c.k))) break
        effective++
        {
          const cur = store.peek(objectKey(c.k))
          const m = cur ? (JSON.parse(cur.body) as { expiresAt?: number }) : undefined
          // Boundary in the acquirer's own clock, which is the clock the takeover test uses.
          const local = w.t + (offs[c.j] ?? 0)
          if (m?.expiresAt !== undefined && (local === m.expiresAt || local === m.expiresAt + 1)) boundaryAcquires++
        }
        const wasSucceeded = succeeded.has(c.k)
        const existed = store.peek(objectKey(c.k)) !== undefined
        const writesBefore = (store.writeLog.get(objectKey(c.k)) ?? []).length
        const r = runAs(c.j, locks[c.j]!.acquire(CacheKey(c.k)))
        if (Result.isSuccess(r) && r.success.state === "obtained") {
          // INV-2: no successful acquire after a published success.
          expect(wasSucceeded).toBe(false)
          if (existed) stats.takeovers++
          held.set(hk(c.j, c.k), r.success.lock)
        }
        if (Result.isSuccess(r) && r.success.state === "completed") {
          expect(wasSucceeded).toBe(true)
          stats.completedSeen++
        }
        if (Result.isSuccess(r) && r.success.state === "pending" && r.success.owner === null) {
          // `pending` without an owner: rate limited (or lost a race).
          if ((store.writeLog.get(objectKey(c.k)) ?? []).length === writesBefore) stats.rateLimited++
        }
        break
      }
      case "renew": {
        const h = held.get(hk(c.j, c.k))
        if (!h) break
        effective++
        const r = runAs(c.j, locks[c.j]!.renewOnce(h))
        if (Result.isSuccess(r)) held.set(hk(c.j, c.k), r.success)
        else if (r.failure._tag === "LockLost") {
          stats.staleRejected++
          held.delete(hk(c.j, c.k))
        } else if (r.failure._tag === "RateLimited") stats.rateLimited++
        break
      }
      case "publish": {
        const h = held.get(hk(c.j, c.k))
        if (!h) break
        effective++
        const r = runAs(
          c.j,
          locks[c.j]!.markCompleted(
            h,
            c.ok ? { status: "succeeded", buildCacheKey: `cache/${c.k}` } : { status: "failed", logKey: null }
          )
        )
        if (Result.isFailure(r) && r.failure._tag === "LockLost") stats.staleRejected++
        held.delete(hk(c.j, c.k))
        break
      }
      case "abandon": {
        const h = held.get(hk(c.j, c.k))
        if (!h) break
        effective++
        const r = runAs(c.j, locks[c.j]!.abandon(h))
        if (Result.isFailure(r) && r.failure._tag === "LockLost") stats.staleRejected++
        held.delete(hk(c.j, c.k))
        break
      }
    }
    check()
  }
  const snapshot = KEYS.map((k) => store.peek(objectKey(k)) ?? null)
  return { stats, effective, boundaryAcquires, snapshot }
}

const simulate = (cmdList: ReadonlyArray<Cmd>, offs: ReadonlyArray<number>, mutation: Mutation = "none"): Stats =>
  simulateRun(cmdList, offs, mutation).stats

/** H1/H6 verdict of one run. */
const verdictOf = (cs: ReadonlyArray<Cmd>, info: RunInfo) => ({
  valid: cs.length > 0 && info.effective * 4 >= cs.length,
  boundary: info.boundaryAcquires > 0
})

const DOMAIN =
  "≤80 commands over 3 jobs × 2 keys; ticks from {0,500,999,1000,1001,10000,30000,30001} ∪ [0,12000] ms; " +
  "skew offsets from {0,±1,±1000,±30000} ∪ [-20000,20000] ms"

type Counter = { tally: Tally }
const bump = (c: Counter, v: { valid: boolean; boundary: boolean }) => {
  c.tally = {
    total: c.tally.total + 1,
    valid: c.tally.valid + (v.valid ? 1 : 0),
    boundary: c.tally.boundary + (v.boundary ? 1 : 0)
  }
}
const newCounter = (): Counter => ({ tally: { total: 0, valid: 0, boundary: 0 } })

/** The single-clock safety property, for a given store. */
const oneClock = (mutation: Mutation, c: Counter = newCounter()) =>
  fc.property(cmds, (cs) => {
    bump(c, verdictOf(cs, simulateRun(cs, [0, 0, 0], mutation)))
  })

/** The skewed-clock safety property (everything except belief-level mutual exclusion). */
const skewed = (mutation: Mutation, c: Counter = newCounter()) =>
  fc.property(cmds, offsets, (cs, os) => {
    bump(c, verdictOf(cs, simulateRun(cs, os, mutation)))
  })

/** Minimum valid share and boundary runs for the safety properties (measured: `docs/test-review.md`). */
const MEANINGFUL = { domain: DOMAIN, minValidFraction: 0.8, minBoundary: 10 }

describe("properties", () => {
  it("one clock: mutual exclusion, no rebuild after success, rate-limit compliance", () => {
    const c = newCounter()
    fc.assert(oneClock("none", c), params(RUNS))
    assertMeaningful("one-clock safety", c.tally, MEANINGFUL)
  })

  it("skewed clocks: R2 state stays safe (fencing; renew/publish/takeover need no clock agreement)", () => {
    const c = newCounter()
    fc.assert(skewed("none", c), params(RUNS))
    assertMeaningful("skewed-clock safety", c.tally, MEANINGFUL)
  })

  it("replay (H8): the same seed reproduces the same command lists, event counts and final R2 state", () => {
    replay(
      fc.tuple(cmds, offsets),
      ([cs, os]) => {
        const r = simulateRun(cs, os)
        return { stats: r.stats, snapshot: r.snapshot }
      },
      5,
      20
    )
  })

  it("replay mutant (H3 for H8): with the lock's random nonce source the same run does NOT reproduce its R2 state", () => {
    // The replay property is falsifiable: hidden randomness in the logic breaks it
    // as soon as a run writes anything. This is why the nonce source is a parameter.
    const writes = cmds.filter((cs) => cs.some((c) => c.t === "acquire"))
    expect(
      fc.check(
        fc.property(writes, (cs) => {
          const a = simulateRun(cs, [0, 0, 0], "none", true).snapshot
          const b = simulateRun(cs, [0, 0, 0], "none", true).snapshot
          return JSON.stringify(a) === JSON.stringify(b)
        }),
        params(50)
      ).failed
    ).toBe(true)
  })

  it("coverage: the seeded runs exercise every interesting branch at least MIN_HITS times (A2, B5)", () => {
    const total: Stats = { takeovers: 0, rateLimited: 0, staleRejected: 0, completedSeen: 0, twoBelievers: 0 }
    const samples = fc.sample(cmds, { seed: SEED, numRuns: RUNS })
    // Non-degeneracy (H4): the runs end in many different R2 states.
    const finals = new Set(samples.map((cs) => JSON.stringify(simulateRun(cs, [0, 0, 0]).snapshot)))
    expect(finals.size).toBeGreaterThan(RUNS / 10)
    for (const cs of samples) {
      const s = simulate(cs, [0, 0, 0])
      for (const k of Object.keys(total) as Array<keyof Stats>) total[k] += s[k]
    }
    // Reported for the per-release detection surface (G2).
    console.log(`coverage over ${samples.length} runs (MIN_HITS = ${MIN_HITS}):`, total)
    // Standing caveat (D1, G2), printed on every run.
    console.log(
      "standing caveat: these properties are checked against an in-memory R2 that follows the Lean model; " +
        "a wrong model of R2 passes all of them. Only runs against real R2 and independent review can catch that."
    )
    for (const k of Object.keys(total) as Array<keyof Stats>) {
      expect(total[k], `stratum ${k}`).toBeGreaterThanOrEqual(MIN_HITS)
    }
  })

  it("mutation adequacy: every non-neutral R2 mutant is detected; the neutral one is not (E1)", () => {
    const nonNeutral: ReadonlyArray<Mutation> = ["ignoreIfNoneMatch", "ignoreIfMatch", "noRateLimit"]
    const detected = nonNeutral.filter((m) => fc.check(oneClock(m), params(RUNS)).failed)
    console.log(`mutation adequacy: ${detected.length}/${nonNeutral.length} detected`, detected)
    expect(detected).toEqual(nonNeutral)
    // Neutral mutant: stale reads cannot break safety because every write is
    // fenced by an ETag (`Skew.stale_cas_rejected`). Its neutrality is itself
    // property-tested, under one clock and under skew.
    expect(fc.check(oneClock("staleReads"), params(RUNS)).failed).toBe(false)
    expect(fc.check(skewed("staleReads"), params(RUNS)).failed).toBe(false)
  })

  it("a hand-written crash-and-takeover run: the takeover happens and the stale renew is rejected", () => {
    const run: ReadonlyArray<Cmd> = [
      { t: "acquire", j: 0, k: "a" },
      { t: "tick", d: 30_001 },
      { t: "acquire", j: 1, k: "a" },
      { t: "tick", d: 1_000 },
      { t: "renew", j: 0, k: "a" }
    ]
    expect(simulate(run, [0, 0, 0])).toEqual({
      takeovers: 1,
      rateLimited: 0,
      staleRejected: 1,
      completedSeen: 0,
      twoBelievers: 2 // steps after the takeover and after the rejected renew
    })
    // Negation: the same run against the `ignoreIfMatch` mutant violates mutual exclusion.
    expect(() => simulate(run, [0, 0, 0], "ignoreIfMatch")).toThrow()
  })
})
