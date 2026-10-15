/**
 * Laws of the cobuild runtime (`runCobuild`, `makeCobuildLock`), stated for
 * all parameters instead of one hand-picked run each.
 *
 * Added in the third test pass (`docs/test-review.md` §TS-S). Each test of
 * `scenarios.test.ts` that pinned one run (a 35 s build, a 30.5 s build, a
 * 95 s failing build, a 30 s lease, persistent 429s, the configuration
 * bounds) is generalised here into the rule it was an example of. The rule
 * is written from the requirements (the README's review items and the Lean
 * results), never from the recorded outputs:
 *
 * | Law | Requirement | Oracle |
 * |---|---|---|
 * | renewal schedule | renew every `renewIntervalMs` while building; publish with the latest ETag; a 429 on the publish is retried after `rateLimitMs` | `expectedWrites` |
 * | failure shelf life | a failure marker blocks takeovers for exactly `failureShelfMs` after the failure was published | `failedAt + shelf` |
 * | takeover threshold | a `building` lease can be taken over at `expiresAt + 1` and not before; the old holder's writes are then rejected | `leaseMs + 1` |
 * | persistent 429 | renewals are retried every `rateLimitMs` while the lease would still be valid; the build is interrupted at the last retry instant | `lastRetryInstant` |
 * | abandon | an abandoned lease is stealable as soon as R2's rate limit allows | `abandonAt + rateLimitMs` |
 * | 412 is final | a stale ETag costs exactly one request, however many renewals happened | `1` |
 * | configuration predicate | D-10, compared with an independent BigInt oracle over the whole safe-integer range | `configOracle` |
 *
 * Every law reports total / valid / boundary counts (H1, H5, H6), and the
 * boundary generators put the interesting instants (multiples of the renewal
 * interval, the rate-limit threshold, the expiry instant) in every run. Each
 * law has a source mutant in `scripts/mutation-check.sh` that must make it
 * fail (H3); the in-process mutants below additionally show that the oracle
 * distinguishes the plausible wrong rules.
 */
import { Clock, Duration, Effect, Fiber, Result } from "../src/fx/index.js"
import { TestClock } from "../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  checkCobuildConfig,
  type CobuildConfig,
  resolveConfig,
  type CobuildLock,
  makeCobuildLock,
  makeMemoryStore,
  type MemoryStore,
  type ObjectStore,
  RateLimited,
  type ResolvedConfig,
  runCobuild
} from "../src/index.js"
import { announce, lawAsync, law, mutantKilled } from "./harness.js"
import { CacheKey, JobId } from "../src/ids.js"

announce("test/laws.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

const RATE = 1_000

/** A deterministic nonce source per run (rule 5). */
const counterNonce = () => {
  let n = 0
  return () => `n${n++}`
}

const lockFor = (store: ObjectStore, jobId: string, extra: Partial<CobuildConfig>): CobuildLock =>
  makeCobuildLock(store, {
    scope: "trusted",
    context: "law",
    jobId: JobId(jobId),
    maxLatency: Duration.millis(0),
    maxSkew: Duration.millis(0),
    nonce: counterNonce(),
    ...extra
  })

const writesOf = (store: MemoryStore, lock: CobuildLock, key: string) => store.writeLog.get(lock.objectKey(CacheKey(key))) ?? []

// ---------------------------------------------------------------------------
// Renewal schedule

/**
 * The requirement, as an independent oracle: acquire at 0; renew at every
 * multiple `k · R` with `0 < k · R < D`; publish at `D` if the last write was
 * at least `rateLimitMs` earlier, otherwise one `rateLimitMs` later (a single
 * 429, then the retry).
 *
 * Tie at `k · R = D` (found by the boundary generator, H6): the renewal due at
 * the instant the build ends races with the end of the build. Both outcomes
 * are safe, and both occur (under the test scheduler the build wins at
 * `k = 1` and the renewal at `k ≥ 2`), so at a tie the specification allows
 * either: no renewal at `D`, or a renewal at `D` followed by a 429 on the
 * publish and the retry `rateLimitMs` later (`inclusive = true`).
 */
const expectedWrites = (R: number, D: number, inclusive = false): ReadonlyArray<number> => {
  const n = inclusive ? Math.floor(D / R) : Math.ceil(D / R) - 1
  const renewals = Array.from({ length: n }, (_, i) => (i + 1) * R)
  const last = renewals.at(-1) ?? 0
  return [0, ...renewals, D - last >= RATE ? D : D + RATE]
}

/** The specification as a predicate: one of the allowed write logs. */
const allowedWrites = (R: number, D: number, writes: ReadonlyArray<number>): boolean => {
  const same = (xs: ReadonlyArray<number>) => JSON.stringify(xs) === JSON.stringify(writes)
  return same(expectedWrites(R, D)) || (D % R === 0 && same(expectedWrites(R, D, true)))
}

/** Lease, renewal interval and build duration, with the boundaries put in on purpose (H6). */
const scheduleArb = fc
  .record({
    lease: fc.integer({ min: 2_001, max: 120_000 }),
    renewFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    k: fc.integer({ min: 0, max: 6 }),
    shape: fc.constantFrom("multiple", "multiple+1", "multiple-1", "rate", "rate-1", "free"),
    free: fc.integer({ min: 1, max: 400_000 })
  })
  .map(({ lease, renewFrac, k, shape, free }) => {
    const renew = RATE + Math.floor(renewFrac * (lease - 1 - RATE))
    const base = k * renew
    const D = Math.max(
      1,
      shape === "multiple"
        ? base
        : shape === "multiple+1"
          ? base + 1
          : shape === "multiple-1"
            ? base - 1
            : shape === "rate"
              ? base + RATE
              : shape === "rate-1"
                ? base + RATE - 1
                : free
    )
    return { lease, renew, D }
  })

const buildOnce = (lease: number, renew: number, D: number, fails: boolean, shelf = 1_800_000) =>
  Effect.gen(function* () {
    const store = makeMemoryStore()
    const a = lockFor(store, "A", { lease: Duration.millis(lease), renewInterval: Duration.millis(renew), failureShelf: Duration.millis(shelf) })
    const fiber = yield* Effect.forkChild(
      runCobuild(a, {
        cacheKey: CacheKey("p"),
        build: fails ? Effect.andThen(Effect.sleep(D), Effect.fail("broken" as const)) : Effect.as(Effect.sleep(D), "out"),
        upload: () => Effect.succeed("tarball/p"),
        uploadFailureLog: () => Effect.succeed("logs/p")
      })
    )
    yield* TestClock.adjust(D + 2 * RATE)
    const result = yield* Fiber.join(fiber)
    return { store, a, result, writes: writesOf(store, a, "p") }
  })

describe("renewal schedule (review items 1, 3, 7)", () => {
  it("law: writes are exactly acquire, every renewal interval while building, then one publish (retried once after a 429)", async () => {
    await lawAsync(
      "renewal schedule",
      scheduleArb,
      async ({ lease, renew, D }) => {
        const { result, writes } = await run(buildOnce(lease, renew, D, false))
        expect(result).toEqual({ _tag: "Built", value: "out", buildCacheKey: "tarball/p" })
        expect(allowedWrites(renew, D, writes), `writes ${JSON.stringify(writes)}`).toBe(true)
        // Invariants at every step, not only at the end: consecutive writes respect the rate
        // limit, and every renewal lands while the previous lease is still valid.
        writes.slice(1).forEach((t, i) => {
          expect(t - writes[i]!).toBeGreaterThanOrEqual(RATE)
          if (i < writes.length - 2) expect(t).toBeLessThanOrEqual(writes[i]! + lease)
        })
        const last = expectedWrites(renew, D).at(-2)!
        return { valid: D > renew, boundary: D % renew <= 1 || D % renew === renew - 1 || D - last === RATE || D - last === RATE - 1 }
      },
      150,
      { domain: "lease ∈ [2001,120000] ms, renew ∈ [1000, lease-1], D at k·renew{,±1}, k·renew+1000{,-1} or uniform ≤ 400000", minValidFraction: 0.5, minBoundary: 40 }
    )
  }, 60_000)

  it("the specification rejects the plausible wrong rules (one renewal too few; no retry after a 429; renew right after acquiring)", () => {
    const arb = scheduleArb.filter(({ D, renew }) => D > renew + 1)
    const tooFew = (R: number, D: number) => {
      const w = expectedWrites(R, D)
      return [...w.slice(0, -2), w.at(-1)!]
    }
    const noRetry = (R: number, D: number) => expectedWrites(R, D).map((t, i, a) => (i === a.length - 1 ? D : t))
    const eager = (R: number, D: number) => expectedWrites(R, D).map((t, i, a) => (i > 0 && i < a.length - 1 ? t - R + RATE : t))
    for (const wrong of [tooFew, noRetry, eager]) {
      expect(mutantKilled(arb, ({ renew, D }) => allowedWrites(renew, D, wrong(renew, D)), 500)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Failure shelf life

describe("failure shelf life (review items 4, 8)", () => {
  it("law: the marker blocks takeovers until failedAt + shelf inclusive and allows one at failedAt + shelf + 1; failedAt is the publish time", async () => {
    await lawAsync(
      "failure shelf life",
      fc.record({
        // Boundary generator (H6): builds ending exactly on a renewal instant are sampled on purpose.
        D: fc.oneof(fc.integer({ min: 1, max: 200_000 }), fc.integer({ min: 1, max: 20 }).map((k) => 10_000 * k)),
        shelf: fc.oneof(
          // fc.noBias: fast-check's small-value bias made shelves < 2 s (always past by the time B
          // looks, so the "still failed" branch is skipped) common enough to break the valid fraction
          // on some seeds (seed 21: 0.57). Uniform draws keep the generic interior generic; the edges
          // are sampled explicitly by the constants below.
          { arbitrary: fc.noBias(fc.integer({ min: 0, max: 3_000_000 })), weight: 4 },
          { arbitrary: fc.constantFrom(0, 1, RATE - 1, RATE), weight: 1 }
        )
      }),
      async ({ D, shelf }) =>
        run(
          Effect.gen(function* () {
            const { store, result, writes } = yield* buildOnce(30_000, 10_000, D, true, shelf)
            expect(result._tag).toBe("BuildFailed")
            const failedAt = writes.at(-1)!
            // failedAt is the publish time of an allowed schedule (at a tie k · R = D either is allowed).
            expect(allowedWrites(10_000, D, writes), `writes ${JSON.stringify(writes)}`).toBe(true)
            const b = lockFor(store, "B", { failureShelf: Duration.millis(shelf) })
            const now = D + 2 * RATE
            // Before the end of the shelf life (if that instant is still ahead of us): failed.
            if (failedAt + shelf >= now) {
              yield* TestClock.adjust(failedAt + shelf - now)
              expect(yield* b.acquire(CacheKey("p"))).toEqual({ state: "failed", failedAt, logKey: "logs/p" })
              yield* TestClock.adjust(1)
            } else {
              yield* TestClock.adjust(Math.max(0, failedAt + shelf + 1 - now))
            }
            // One millisecond later the marker is stale: B obtains the lock, unless R2's rate limit
            // (1 write/s after the failure publish) still applies, in which case it is pending.
            const after = yield* b.acquire(CacheKey("p"))
            const t = Math.max(now, failedAt + shelf + 1)
            expect(after.state).toBe(t - failedAt >= RATE ? "obtained" : "pending")
            return { valid: failedAt + shelf >= now, boundary: shelf === RATE || shelf === RATE - 1 || failedAt + shelf >= now }
          })
        ),
      120,
      { domain: "build D ∈ [1,200000] ∪ 10000·[1,20] ms, shelf ∈ [0,3000000] ∪ {0,1,999,1000} ms", minValidFraction: 0.6, minBoundary: 30 }
    )
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Takeover threshold and fencing

describe("takeover threshold and fencing (`failure_recovery`, `stale_cas_rejected`)", () => {
  it("law: for any lease, another job gets pending (with owner and expiry) at expiresAt and the lock at expiresAt + 1; the old holder's writes are then rejected", async () => {
    await lawAsync(
      "takeover threshold",
      fc.record({ lease: fc.integer({ min: 2_001, max: 10_000_000 }), late: fc.integer({ min: 0, max: 50_000 }) }),
      async ({ lease, late }) =>
        run(
          Effect.gen(function* () {
            const store = makeMemoryStore()
            const a = lockFor(store, "A", { lease: Duration.millis(lease), renewInterval: Duration.millis(RATE) })
            const b = lockFor(store, "B", { lease: Duration.millis(lease), renewInterval: Duration.millis(RATE) })
            const s = yield* a.acquire(CacheKey("p"))
            if (s.state !== "obtained") throw new Error("A must obtain a free lock")
            yield* TestClock.adjust(lease)
            expect(yield* b.acquire(CacheKey("p"))).toEqual({ state: "pending", owner: "A", expiresAt: lease })
            yield* TestClock.adjust(1)
            const t = yield* b.acquire(CacheKey("p"))
            expect(t.state).toBe("obtained")
            const etagB = store.peek(a.objectKey(CacheKey("p")))?.etag
            yield* TestClock.adjust(RATE + late)
            const renew = yield* Effect.result(a.renewOnce(s.lock))
            expect(Result.isFailure(renew) && renew.failure._tag).toBe("LockLost")
            const publish = yield* Effect.result(a.markCompleted(s.lock, { status: "succeeded", buildCacheKey: "x" }))
            expect(Result.isFailure(publish) && publish.failure._tag).toBe("LockLost")
            expect(store.peek(a.objectKey(CacheKey("p")))?.etag).toBe(etagB)
            return { valid: true, boundary: true }
          })
        ),
      150,
      { domain: "lease ∈ [2001,10^7] ms, late writes 1000 + [0,50000] ms after the takeover", minValidFraction: 1, minBoundary: 150 }
    )
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Persistent 429

/** Retries at R, R + ρ, R + 2ρ, …; the heartbeat gives up at the first try t with t + ρ > lease. */
const lastRetryInstant = (lease: number, R: number): number => {
  const k = Math.max(0, Math.floor((lease - RATE - R) / RATE) + 1)
  return R + k * RATE
}

describe("persistent 429 on renewals (review item 7)", () => {
  it("law: the build is interrupted at the last retry instant, which is ≤ the expiry (soundness) and > expiry − rateLimitMs (tightness)", async () => {
    await lawAsync(
      "persistent 429",
      fc
        .record({ lease: fc.integer({ min: 2_001, max: 200_000 }), frac: fc.double({ min: 0, max: 1, noNaN: true }), edge: fc.boolean() })
        .map(({ lease, frac, edge }) => {
          const renew = RATE + Math.floor(frac * (lease - 1 - RATE))
          // Boundary generator: make lease − renew an exact multiple of the rate limit.
          return edge ? { lease: renew + RATE * Math.max(1, Math.floor((lease - renew) / RATE)), renew } : { lease, renew }
        })
        .filter(({ lease, renew }) => renew < lease),
      async ({ lease, renew }) =>
        run(
          Effect.gen(function* () {
            const base = makeMemoryStore()
            const store: ObjectStore = { ...base, putIfMatch: (key) => Effect.fail(new RateLimited({ key })) }
            const a = lockFor(store, "A", { lease: Duration.millis(lease), renewInterval: Duration.millis(renew) })
            let interruptedAt: number | null = null
            const fiber = yield* Effect.forkChild(
              runCobuild(a, {
                cacheKey: CacheKey("p"),
                build: Effect.sleep(10 * lease).pipe(
                  Effect.onInterrupt(() =>
                    Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => void (interruptedAt = t)))
                  )
                ),
                upload: () => Effect.succeed("unused")
              })
            )
            yield* TestClock.adjust(2 * lease)
            expect(yield* Fiber.join(fiber)).toEqual({ _tag: "LockLost" })
            const t = interruptedAt as number | null
            expect(t).toBe(lastRetryInstant(lease, renew))
            expect(t!).toBeLessThanOrEqual(lease)
            expect(t!).toBeGreaterThan(lease - RATE)
            return { valid: true, boundary: (lease - renew) % RATE === 0 }
          })
        ),
      60,
      { domain: "lease ∈ [2001,200000] ms, renew ∈ [1000, lease-1], half the cases with (lease − renew) a multiple of 1000", minValidFraction: 1, minBoundary: 10 }
    )
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Abandon, 412

describe("abandon and 412 (review items 5, 6)", () => {
  it("law: after abandon at time t, others get pending before t + rateLimitMs and the lock from t + rateLimitMs on", async () => {
    await lawAsync(
      "abandon then takeover",
      fc.record({ t: fc.integer({ min: RATE, max: 29_000 }), gap: fc.oneof(fc.constantFrom(0, RATE - 1, RATE, RATE + 1), fc.integer({ min: 0, max: 5_000 })) }),
      async ({ t, gap }) =>
        run(
          Effect.gen(function* () {
            const store = makeMemoryStore()
            const a = lockFor(store, "A", {})
            const b = lockFor(store, "B", {})
            const s = yield* a.acquire(CacheKey("p"))
            if (s.state !== "obtained") throw new Error("A must obtain a free lock")
            yield* TestClock.adjust(t)
            yield* a.abandon(s.lock)
            yield* TestClock.adjust(gap)
            expect((yield* b.acquire(CacheKey("p"))).state).toBe(gap >= RATE ? "obtained" : "pending")
            return { valid: true, boundary: gap === RATE || gap === RATE - 1 }
          })
        ),
      150,
      { domain: "abandon at t ∈ [1000,29000] ms, takeover gap ∈ {0,999,1000,1001} ∪ [0,5000] ms", minValidFraction: 1, minBoundary: 10 }
    )
  }, 60_000)

  it("law: a stale ETag is rejected with exactly one request after any number of renewals", async () => {
    await lawAsync(
      "412 is final",
      fc.integer({ min: 1, max: 6 }),
      async (renewals) =>
        run(
          Effect.gen(function* () {
            const store = makeMemoryStore()
            const a = lockFor(store, "A", {})
            const s = yield* a.acquire(CacheKey("p"))
            if (s.state !== "obtained") throw new Error("A must obtain a free lock")
            let h = s.lock
            for (let i = 0; i < renewals; i++) {
              yield* TestClock.adjust(10_000)
              h = yield* a.renewOnce(h)
            }
            yield* TestClock.adjust(RATE)
            const before = store.calls.putIfMatch
            const r = yield* Effect.result(a.markCompleted(s.lock, { status: "succeeded", buildCacheKey: "x" }))
            expect(Result.isFailure(r) && r.failure._tag).toBe("LockLost")
            expect(store.calls.putIfMatch - before).toBe(1)
            // The holder's current ETag still works (the rejected write changed nothing).
            yield* TestClock.adjust(RATE)
            expect((yield* Effect.result(a.markCompleted(h, { status: "succeeded", buildCacheKey: "x" })))._tag).toBe("Success")
            return { valid: true, boundary: renewals === 1 }
          })
        ),
      60,
      { domain: "1–6 renewals before the stale write", minValidFraction: 1, minBoundary: 1 }
    )
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Configuration predicate (D-10) against an independent oracle

/** The predicate written from D-10 in exact integer arithmetic (independent of `checkCobuildConfig`). */
const configOracle = (r: ResolvedConfig): boolean => {
  const nums = [r.leaseMs, r.renewIntervalMs, r.rateLimitMs, r.failureShelfMs, r.maxLatencyMs, r.maxSkewMs]
  if (!nums.every((v) => Number.isSafeInteger(v) && v >= 0)) return false
  const [lease, renew, rate, , lat, skew] = nums.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]
  return lease > 0n && rate <= renew && renew + lat + skew < lease && /^[a-z0-9][a-z0-9-]{0,62}$/.test(r.scope)
}

/** Values over the whole safe-integer range, with the boundaries and garbage sampled on purpose (H6). */
const msArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 100_000 }), weight: 4 },
  { arbitrary: fc.maxSafeNat(), weight: 1 },
  { arbitrary: fc.constantFrom(-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2 ** 53), weight: 1 }
)

const configArb = fc
  .record({
    leaseMs: msArb,
    renewIntervalMs: msArb,
    rateLimitMs: fc.oneof(fc.constant(RATE), msArb),
    failureShelfMs: fc.oneof(fc.constant(1_800_000), msArb),
    maxLatencyMs: msArb,
    maxSkewMs: msArb,
    scope: fc.oneof(
      { arbitrary: fc.constantFrom("trusted", "fork-pr", "a".repeat(63)), weight: 4 },
      { arbitrary: fc.constantFrom("", "feat/x", "Trusted", "-x", "a".repeat(64)), weight: 1 },
      { arbitrary: fc.string({ maxLength: 8 }), weight: 1 }
    ),
    edge: fc.constantFrom(-1, 0, 1, null)
  })
  .map(({ edge, ...r }): ResolvedConfig => {
    // Boundary generator: put renew + latency + skew at lease − 1, lease or lease + 1.
    const base = { ...r, context: "c", jobId: JobId("A"), prefix: "cobuild" }
    if (edge === null || !Number.isSafeInteger(r.renewIntervalMs) || !Number.isSafeInteger(r.maxLatencyMs) || !Number.isSafeInteger(r.maxSkewMs)) return base
    return { ...base, leaseMs: r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs - edge }
  })

describe("configuration predicate (D-10)", () => {
  it("law: checkCobuildConfig accepts exactly the configurations the BigInt oracle accepts; both verdicts occur", () => {
    let accepted = 0
    law(
      "config predicate",
      configArb,
      (r) => {
        const ok = checkCobuildConfig(r).length === 0
        expect(ok).toBe(configOracle(r))
        if (ok) accepted++
        const s = r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs
        return { valid: Number.isSafeInteger(r.leaseMs), boundary: Math.abs(s - r.leaseMs) <= 1 }
      },
      5_000,
      { domain: "each field from [0,100000] ∪ [0,2^53-1] ∪ {-1,0.5,NaN,∞,2^53-1,2^53}; scope from valid/invalid names and random strings; lease at sum{-1,0,+1} for 3/4 of the cases", minValidFraction: 0.5, minBoundary: 500 }
    )
    // Non-degeneracy (H4): both verdicts are reached often.
    expect(accepted).toBeGreaterThan(200)
  })

  it("the oracle rejects the old check (renew < lease) and an off-by-one (≤ instead of <)", () => {
    const old = (r: ResolvedConfig) => configOracle({ ...r, maxLatencyMs: 0, maxSkewMs: 0 })
    const offByOne = (r: ResolvedConfig) => configOracle({ ...r, leaseMs: r.leaseMs + 1 })
    for (const wrong of [old, offByOne]) {
      expect(mutantKilled(configArb, (r) => wrong(r) === configOracle(r), 2_000)).toBe(true)
    }
  })

  it("makeCobuildLock refuses exactly the configurations the predicate rejects", () => {
    law(
      "constructor agrees with the predicate",
      configArb,
      (r) => {
        // The constructor takes Durations; `Duration.millis` clamps negative and NaN inputs to zero,
        // so the oracle is applied to the milliseconds the Durations actually carry.
        const c: CobuildConfig = {
          scope: r.scope,
          context: r.context,
          jobId: r.jobId,
          prefix: r.prefix,
          lease: Duration.millis(r.leaseMs),
          renewInterval: Duration.millis(r.renewIntervalMs),
          rateLimit: Duration.millis(r.rateLimitMs),
          failureShelf: Duration.millis(r.failureShelfMs),
          maxLatency: Duration.millis(r.maxLatencyMs),
          maxSkew: Duration.millis(r.maxSkewMs)
        }
        const carried: ResolvedConfig = {
          ...r,
          leaseMs: Duration.toMillis(c.lease!),
          renewIntervalMs: Duration.toMillis(c.renewInterval!),
          rateLimitMs: Duration.toMillis(c.rateLimit!),
          failureShelfMs: Duration.toMillis(c.failureShelf!),
          maxLatencyMs: Duration.toMillis(c.maxLatency!),
          maxSkewMs: Duration.toMillis(c.maxSkew!)
        }
        const build = () => makeCobuildLock(makeMemoryStore(), c)
        if (configOracle(carried)) {
          expect(build).not.toThrow()
          expect(resolveConfig(c)).toEqual(carried)
        } else expect(build).toThrow(/cobuild config/)
        return { valid: true, boundary: Math.abs(r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs - r.leaseMs) <= 1 }
      },
      1_000,
      { domain: "as for the predicate law", minValidFraction: 1, minBoundary: 100 }
    )
  })
})

// ---------------------------------------------------------------------------
// Randomness kept apart from the logic (rule 5)

describe("nonce source (rule 5: randomness as a parameter)", () => {
  it("integration: the default nonce source gives distinct UUID-shaped nonces (range check only)", async () => {
    const nonces = await run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const a = makeCobuildLock(store, { scope: "trusted", context: "rand", jobId: JobId("A") })
        const keys = Array.from({ length: 300 }, (_, i) => `k${i}`)
        for (const k of keys) yield* a.acquire(CacheKey(k))
        return keys.map((k) => (JSON.parse(store.peek(a.objectKey(CacheKey(k)))!.body) as { nonce: string }).nonce)
      })
    )
    expect(new Set(nonces).size).toBe(nonces.length)
    nonces.forEach((n) => expect(n).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
  })

  it("an injected source is used verbatim, so runs with a deterministic source are replayable", async () => {
    const nonces = await run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const a = lockFor(store, "A", {})
        for (const k of ["x", "y", "z"]) yield* a.acquire(CacheKey(k))
        return ["x", "y", "z"].map((k) => (JSON.parse(store.peek(a.objectKey(CacheKey(k)))!.body) as { nonce: string }).nonce)
      })
    )
    expect(nonces).toEqual(["n0", "n1", "n2"])
  })
})
