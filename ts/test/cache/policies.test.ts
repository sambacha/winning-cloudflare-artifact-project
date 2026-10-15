/**
 * Status after the third test pass (`docs/test-review.md` §TS-Po): the
 * concrete counterexamples here (fixed 5 s deadline, floor/cap examples,
 * breaker threshold, literal telemetry counts) are labelled regressions;
 * the laws (tightness, clamp, monotonicity, run-length oracle, exact outage
 * count, redelivery invariance) are in `policyLaws.test.ts`.
 *
 * Pure policies: restore deadline (D-11), circuit breaker (D-12), telemetry
 * (D-14). Each Lean result is re-checked as a property on the TypeScript, and
 * each claim of the reviewed analysis that turned out false is pinned by a
 * concrete counterexample (see `docs/cache-path-review.md` §3).
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, params } from "../harness.js"
import {
  type BreakerConfig,
  type BreakerState,
  allowsRequest,
  breakerStep,
  initialBreaker,
  runBreaker
} from "../../src/cache/breaker.js"
import { competitiveRatio, costTimeout, optimalCost, restoreDeadlineMs } from "../../src/cache/deadline.js"
import { Duration } from "../../src/fx/index.js"
import { effectiveHitRate, IdempotentCounter, type OutcomeReport } from "../../src/cache/telemetry.js"

announce("test/cache/policies.test.ts")

const ms = fc.integer({ min: 0, max: 1_000_000 })
const pos = fc.integer({ min: 1, max: 1_000_000 })

describe("D-11 restore deadline", () => {
  it("property: T = R is 2-competitive (deadline_R_two_competitive)", () => {
    fc.assert(
      fc.property(ms, ms, (d, R) => {
        expect(costTimeout(R, d, R)).toBeLessThanOrEqual(2 * optimalCost(d, R))
      }),
      params(2000)
    )
  })

  it("property: any deadline costs at most T over no cache (timeout_cost_le)", () => {
    fc.assert(
      fc.property(ms, ms, ms, (T, d, R) => {
        expect(costTimeout(T, d, R)).toBeLessThanOrEqual(R + T)
      }),
      params(2000)
    )
  })

  it("property: with an estimate T ≠ R the ratio is at most 1 + max(R/T, T/R) (deadline_ratio_le_under/over)", () => {
    fc.assert(
      fc.property(pos, ms, pos, (T, d, R) => {
        // Integer form, as in Lean: min(T,R) · cost ≤ (T + R) · opt.
        expect(Math.min(T, R) * costTimeout(T, d, R)).toBeLessThanOrEqual((T + R) * optimalCost(d, R))
      }),
      params(5000)
    )
  })

  it("the bound is attained: under- and over-estimates both hurt (deadline_under_tight / deadline_over_tight)", () => {
    // Under-estimate (e.g. a cap): T = 1 s, R = 100 s, restore needs 1.001 s.
    expect(costTimeout(1_000, 1_001, 100_000) / optimalCost(1_001, 100_000)).toBeGreaterThan(99)
    expect(competitiveRatio(1_000, 100_000)).toBe(101)
    // Over-estimate (producing build ran on a slower machine): T = 100 s, R = 1 s.
    expect(costTimeout(100_000, 100_001, 1_000) / optimalCost(100_001, 1_000)).toBe(101)
    expect(competitiveRatio(1_000, 1_000)).toBe(2)
  })

  it("fixed 5 s deadline: a legitimate 20 s hit becomes a 605 s miss (fixed_timeout_counterexample)", () => {
    expect(costTimeout(5_000, 20_000, 600_000)).toBe(605_000)
    expect(costTimeout(restoreDeadlineMs(600_000), 20_000, 600_000)).toBe(20_000)
  })

  it("property (falsifies the reviewed claim): a cap never lengthens the deadline, so it cannot fix a too-short estimate", () => {
    fc.assert(
      fc.property(ms, pos, (est, cap) => {
        const base = { floor: Duration.zero, lookup: Duration.millis(1) }
        expect(restoreDeadlineMs(est, { ...base, cap: Duration.millis(cap) })).toBeLessThanOrEqual(restoreDeadlineMs(est, base))
      }),
      params(1000)
    )
  })

  it("floor, cap and garbage estimates", () => {
    const p = { floor: Duration.millis(250), cap: Duration.minutes(10), lookup: Duration.seconds(2) }
    expect(restoreDeadlineMs(0, p)).toBe(250)
    expect(restoreDeadlineMs(Number.NaN, p)).toBe(250)
    expect(restoreDeadlineMs(-5, p)).toBe(250)
    expect(restoreDeadlineMs(249, p)).toBe(250)
    expect(restoreDeadlineMs(251, p)).toBe(251)
    expect(restoreDeadlineMs(600_001, p)).toBe(600_000)
    expect(restoreDeadlineMs(Number.POSITIVE_INFINITY, p)).toBe(250)
  })
})

// ---------------------------------------------------------------------------

/** Mutant: the breaker of the reviewed text, without a probe (`noProbeStep`). */
const noProbeStep = (cfg: BreakerConfig, s: BreakerState, bad: boolean): BreakerState =>
  s.tag === "closed" ? breakerStep(cfg, s, bad) : s

const cfgArb = fc.record({ threshold: fc.integer({ min: 1, max: 6 }), coolDown: fc.integer({ min: 0, max: 10 }) })

describe("D-12 circuit breaker", () => {
  it("property: from open(c), c + 2 healthy requests close it (probe_recovers)", () => {
    fc.assert(
      fc.property(cfgArb, fc.integer({ min: 0, max: 20 }), (cfg, c) => {
        expect(runBreaker(cfg, { tag: "open", cool: c }, Array(c + 2).fill(false))).toEqual(initialBreaker)
        // ... and not one request earlier (the bound is exact).
        expect(runBreaker(cfg, { tag: "open", cool: c }, Array(c + 1).fill(false)).tag).toBe("halfOpen")
      }),
      params(500)
    )
  })

  it("mutant: without the probe, open is absorbing (noProbe_open_absorbing) and the recovery property fails", () => {
    fc.assert(
      fc.property(cfgArb, fc.integer({ min: 0, max: 20 }), fc.array(fc.boolean()), (cfg, c, obs) => {
        expect(obs.reduce((s, o) => noProbeStep(cfg, s, o), { tag: "open", cool: c } as BreakerState)).toEqual({ tag: "open", cool: c })
      }),
      params(500)
    )
    const r = fc.check(
      fc.property(cfgArb, fc.integer({ min: 0, max: 20 }), (cfg, c) =>
        Array<boolean>(c + 2).fill(false).reduce((s, o) => noProbeStep(cfg, s, o), { tag: "open", cool: c } as BreakerState).tag === "closed"
      ),
      params(100)
    )
    expect(r.failed).toBe(true)
  })

  it("threshold: N − 1 consecutive bad observations keep it closed, the N-th opens it; a good one resets", () => {
    const cfg = { threshold: 3, coolDown: 4 }
    expect(runBreaker(cfg, initialBreaker, [true, true])).toEqual({ tag: "closed", bad: 2 })
    expect(runBreaker(cfg, initialBreaker, [true, true, true])).toEqual({ tag: "open", cool: 4 })
    expect(runBreaker(cfg, initialBreaker, [true, true, false, true, true])).toEqual({ tag: "closed", bad: 2 })
    expect(allowsRequest({ tag: "open", cool: 0 })).toBe(false)
    expect(allowsRequest({ tag: "halfOpen" })).toBe(true)
    expect(breakerStep(cfg, { tag: "halfOpen" }, true)).toEqual({ tag: "open", cool: 4 })
  })

  /**
   * Cost per request (ms): hit 1; slow outage = deadline then rebuild 2R;
   * skipped by the breaker = rebuild R.
   */
  const simulate = (cfg: BreakerConfig | null, down: (i: number) => boolean, n: number, R = 10) => {
    let s: BreakerState = initialBreaker
    let cost = 0
    for (let i = 0; i < n; i++) {
      if (cfg && !allowsRequest(s)) {
        cost += R
        s = breakerStep(cfg, s, false)
        continue
      }
      const bad = down(i)
      cost += bad ? 2 * R : 1
      if (cfg) s = breakerStep(cfg, s, bad)
    }
    return cost
  }

  it("falsifies 'the breaker is strictly better': a short outage costs more with it, a long one less", () => {
    const cfg = { threshold: 3, coolDown: 5 }
    const short = (i: number) => i < 3
    expect(simulate(null, short, 10)).toBe(67)
    expect(simulate(cfg, short, 10)).toBe(121)
    const long = (i: number) => i < 50
    expect(simulate(cfg, long, 60)).toBeLessThan(simulate(null, long, 60))
  })
})

// ---------------------------------------------------------------------------

describe("D-14 telemetry", () => {
  const kinds = ["hit", "miss"] as const
  const eventsArb = fc.uniqueArray(fc.record({ id: fc.uuid(), kind: fc.constantFrom(...kinds) }), {
    selector: (e) => e.id,
    maxLength: 30
  })

  it("property: deduplicated counts equal distinct events under any redelivery (idempotent_count_dup)", () => {
    fc.assert(
      fc.property(eventsArb, fc.array(fc.integer({ min: 1, max: 4 })), fc.integer(), (events, reps, seed) => {
        const deliveries = events.flatMap((e, i) => Array(reps[i % Math.max(1, reps.length)] ?? 1).fill(e))
        // Deterministic shuffle.
        let x = seed | 0
        for (let i = deliveries.length - 1; i > 0; i--) {
          x = (x * 1103515245 + 12345) | 0
          const j = Math.abs(x) % (i + 1)
          ;[deliveries[i], deliveries[j]] = [deliveries[j], deliveries[i]]
        }
        const c = new IdempotentCounter<(typeof kinds)[number]>()
        for (const e of deliveries) c.record(e.id, e.kind)
        for (const k of kinds) expect(c.count(k)).toBe(events.filter((e) => e.kind === k).length)
      }),
      params(500)
    )
  })

  it("mutant: counting deliveries over-counts as soon as one event is redelivered (naive_count_overcounts)", () => {
    const c = new IdempotentCounter<"hit">()
    const deliveries = ["e1", "e2", "e1"]
    const naive = deliveries.length
    deliveries.forEach((id) => c.record(id, "hit"))
    expect(c.count("hit")).toBe(2)
    expect(naive).toBe(3)
  })

  it("the Worker's hit rate overstates the jobs' hit rate (worker_hit_rate_overstates)", () => {
    // The Worker served a manifest 4 times; the client rejected two of them (digest mismatch, deadline).
    const reports: OutcomeReport[] = [
      { eventId: "1", scope: "trusted", lookup: "l", outcome: { kind: "hit", restoreMs: 10 } },
      { eventId: "2", scope: "trusted", lookup: "l", outcome: { kind: "hit", restoreMs: 12 } },
      { eventId: "3", scope: "trusted", lookup: "l", outcome: { kind: "miss", reason: "digest_mismatch" } },
      { eventId: "4", scope: "trusted", lookup: "l", outcome: { kind: "miss", reason: "restore_deadline" } },
      { eventId: "4", scope: "trusted", lookup: "l", outcome: { kind: "miss", reason: "restore_deadline" } } // redelivered
    ]
    const workerHitRate = 4 / 4
    expect(effectiveHitRate(reports)).toBe(0.5)
    expect(effectiveHitRate(reports)).toBeLessThan(workerHitRate)
    expect(effectiveHitRate([])).toBe(0)
  })
})
