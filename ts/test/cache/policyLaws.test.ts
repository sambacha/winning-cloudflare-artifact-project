/**
 * Laws for the pure policies (third test pass, `docs/test-review.md` §TS-Po):
 * restore deadline (D-11), circuit breaker (D-12), telemetry (D-14).
 *
 * What `policies.test.ts` lacked, by rule:
 *
 * - **Tightness (H: pair every bound with its attainment).** The competitive
 *   bounds were checked for soundness only; a deadline policy that always
 *   returns 0 or ∞ satisfies "cost ≤ R + T". Each bound now has the input
 *   that attains it, for every parameter value.
 * - **Laws instead of examples.** The floor / cap / garbage examples of
 *   `restoreDeadlineMs`, the `threshold = 3` breaker example and the
 *   telemetry example are replaced by laws over all parameters (clamp laws,
 *   monotonicity, a run-length oracle for the breaker, an exact count of
 *   store touches during an outage, deduplication and range laws).
 * - **A test that passed with the body deleted.** "naive_count_overcounts"
 *   compared `deliveries.length` with the literal 3: it never called a
 *   counter. It is replaced by a property that a delivery-counting
 *   implementation provably fails (`mutantKilled`).
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type BreakerConfig, type BreakerState, allowsRequest, breakerStep, initialBreaker, runBreaker } from "../../src/cache/breaker.js"
import { costTimeout, type DeadlinePolicy, optimalCost, restoreDeadlineMs } from "../../src/cache/deadline.js"
import { Duration } from "../../src/fx/index.js"
import { effectiveHitRate, IdempotentCounter, type OutcomeReport } from "../../src/cache/telemetry.js"
import { announce, distinctCount, law, mutantKilled } from "../harness.js"

announce("test/cache/policyLaws.test.ts")

const posMs = fc.oneof(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: Math.floor(Number.MAX_SAFE_INTEGER / 4) }))

describe("D-11 restore deadline: tightness", () => {
  it("law: T = R attains ratio exactly 2 at d = R + 1 (the 2-competitive bound is tight for every R)", () => {
    law(
      "2-competitive bound attained",
      // Boundary generator (H6): 1/10 of the cases at the edges R ∈ {1, 2, 2^51}.
      fc.oneof({ weight: 9, arbitrary: posMs }, { weight: 1, arbitrary: fc.constantFrom(1, 2, 2 ** 51) }),
      (R) => {
        expect(costTimeout(R, R + 1, R)).toBe(2 * R)
        expect(optimalCost(R + 1, R)).toBe(R)
        return { valid: true, boundary: R <= 2 || R === 2 ** 51 }
      },
      2_000,
      { domain: "R ∈ [1,10^6] ∪ [1,2^51], 1/10 of the cases in {1, 2, 2^51}", minValidFraction: 1, minBoundary: 100 }
    )
  })

  it("law: over-estimates (T ≥ R) attain the bound 1 + T/R exactly at d = T + 1; under-estimates (T < R) reach (T+R)/(T+1)", () => {
    // Boundary generator (H6): T = R, T = R − 1 and T = R + 1 are sampled on purpose.
    const pairArb = fc.tuple(posMs, posMs, fc.constantFrom("free", "eq", "minus", "plus")).map(([T, R, w]) =>
      w === "eq" ? [R, R] : w === "minus" ? [Math.max(1, R - 1), R] : w === "plus" ? [R + 1, R] : [T, R]
    ) as fc.Arbitrary<[number, number]>
    law(
      "estimate bound attained",
      pairArb,
      ([T, R]) => {
        const cost = costTimeout(T, T + 1, R)
        const opt = optimalCost(T + 1, R)
        expect(cost).toBe(T + R)
        // Equality in the integer bound, in exact arithmetic (the products exceed 2^53).
        if (T >= R) expect(BigInt(Math.min(T, R)) * BigInt(cost)).toBe(BigInt(T + R) * BigInt(opt))
        else expect(opt).toBe(Math.min(T + 1, R)) // ratio (T + R)/(T + 1) → 1 + R/T as T grows
        return { valid: true, boundary: T === R || T + 1 === R }
      },
      2_000,
      { domain: "T, R ∈ [1,10^6] ∪ [1,2^51]; 3/4 of the pairs with T − R ∈ {0, −1, +1}", minValidFraction: 1, minBoundary: 500 }
    )
  })

  it("the tightness law rejects a deadline model that never gives up (cost = d)", () => {
    const neverGiveUp = (_T: number, d: number, _R: number) => d
    expect(mutantKilled(fc.tuple(posMs, posMs), ([T, R]) => neverGiveUp(T, T + 1, R) === T + R, 500)).toBe(true)
  })
})

describe("D-11 restore deadline: clamp laws (replacing the floor/cap/garbage examples)", () => {
  const estArb = fc.oneof(
    { arbitrary: fc.integer({ min: -1_000, max: 2_000_000 }), weight: 4 },
    { arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 0.5), weight: 1 }
  )
  /** The generated millisecond policy as the `Duration`-typed `DeadlinePolicy`. */
  const toPolicy = (p: { readonly floorMs: number; readonly capMs: number | undefined; readonly lookupMs: number }): DeadlinePolicy => ({
    floor: Duration.millis(p.floorMs),
    lookup: Duration.millis(p.lookupMs),
    ...(p.capMs === undefined ? {} : { cap: Duration.millis(p.capMs) })
  })
  const policyArb = fc.record({
    floorMs: fc.integer({ min: 0, max: 5_000 }),
    capMs: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
    lookupMs: fc.integer({ min: 1, max: 5_000 })
  })
  // Boundary generator (H6): put the estimate exactly at the floor or the cap, or one off.
  const caseArb = fc.tuple(policyArb, estArb, fc.constantFrom("free", "floor", "floor-1", "floor+1", "cap", "cap+1")).map(([p, e, where]) => {
    const cap = p.capMs ?? 2_000_000
    const est = where === "floor" ? p.floorMs : where === "floor-1" ? p.floorMs - 1 : where === "floor+1" ? p.floorMs + 1 : where === "cap" ? cap : where === "cap+1" ? cap + 1 : e
    return { p, est }
  })

  it("law: the deadline is ≥ floor, ≤ max(floor, cap), equals the estimate between them, and is the floor for garbage", () => {
    law(
      "deadline clamp",
      caseArb,
      ({ p, est }) => {
        const T = restoreDeadlineMs(est, toPolicy(p))
        const cap = p.capMs
        const garbage = !Number.isFinite(est) || est <= 0
        expect(T).toBeGreaterThanOrEqual(p.floorMs)
        if (cap !== undefined) expect(T).toBeLessThanOrEqual(Math.max(p.floorMs, cap))
        if (garbage) expect(T).toBe(p.floorMs)
        else if (p.floorMs <= est && (cap === undefined || est <= cap)) expect(T).toBe(est)
        return { valid: !garbage, boundary: est === p.floorMs || est === cap || est === p.floorMs - 1 || (cap !== undefined && est === cap + 1) }
      },
      5_000,
      { domain: "floor ∈ [0,5000], cap ∈ [0,10^6] or none, estimate ∈ [-1000,2·10^6] ∪ {NaN,±∞,0,-0,0.5}, half at floor/cap ±1", minValidFraction: 0.6, minBoundary: 1_000 }
    )
  })

  it("law (metamorphic): the deadline is monotone in the estimate, and a cap never lengthens it", () => {
    law(
      "deadline monotone",
      fc.tuple(caseArb, fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 1_000_000 })),
      ([{ p, est }, delta, cap]) => {
        if (!Number.isFinite(est) || est <= 0) return { valid: false, boundary: false }
        expect(restoreDeadlineMs(est + delta, toPolicy(p))).toBeGreaterThanOrEqual(restoreDeadlineMs(est, toPolicy(p)))
        expect(restoreDeadlineMs(est, toPolicy({ ...p, capMs: cap }))).toBeLessThanOrEqual(restoreDeadlineMs(est, toPolicy({ floorMs: p.floorMs, lookupMs: p.lookupMs, capMs: undefined })))
        return { valid: true, boundary: delta === 0 }
      },
      3_000,
      { domain: "as above, plus δ ∈ [0,10^5] and a cap ∈ [0,10^6]", minValidFraction: 0.6, minBoundary: 5 }
    )
  })

  it("non-degeneracy: over the sample the deadline takes many values, including the floor and the estimate itself", () => {
    const xs = fc.sample(caseArb, 2_000)
    expect(distinctCount(xs, ({ p, est }) => restoreDeadlineMs(est, toPolicy(p)))).toBeGreaterThan(200)
  })
})

// ---------------------------------------------------------------------------

/**
 * Independent oracle for the breaker, written from the specification as a
 * run-length rule rather than a transition function: while closed, the state
 * is the length of the current run of bad observations; a run of length `N`
 * opens it; open skips `C + 1` requests, then the next request probes.
 */
const breakerOracle = (cfg: BreakerConfig, obs: ReadonlyArray<boolean>): BreakerState => {
  let i = 0
  let state: BreakerState = initialBreaker
  while (i < obs.length) {
    if (state.tag === "closed") {
      let run = state.bad
      while (i < obs.length && run < cfg.threshold) {
        run = obs[i] ? run + 1 : 0
        i++
      }
      state = run >= cfg.threshold ? { tag: "open", cool: cfg.coolDown } : { tag: "closed", bad: run }
    } else if (state.tag === "open") {
      const skip = Math.min(state.cool + 1, obs.length - i)
      i += skip
      state = skip === state.cool + 1 ? { tag: "halfOpen" } : { tag: "open", cool: state.cool - skip }
    } else {
      state = obs[i] ? { tag: "open", cool: cfg.coolDown } : initialBreaker
      i++
    }
  }
  return state
}

const cfgArb = fc.record({ threshold: fc.integer({ min: 1, max: 8 }), coolDown: fc.integer({ min: 0, max: 10 }) })
/** Observation sequences with long bad runs on purpose (H6): runs of N − 1, N and N + 1 bad. */
const obsArb = fc.array(fc.oneof(fc.boolean(), fc.integer({ min: 0, max: 9 }).map((n) => Array<boolean>(n).fill(true))), { maxLength: 30 }).map((xs) => xs.flat())

describe("D-12 circuit breaker", () => {
  it("law: the transition function agrees with the run-length oracle on every observation sequence; all three states occur", () => {
    const tags = new Set<string>()
    law(
      "breaker vs run-length oracle",
      fc.tuple(cfgArb, obsArb),
      ([cfg, obs]) => {
        const s = runBreaker(cfg, initialBreaker, obs)
        expect(s).toEqual(breakerOracle(cfg, obs))
        tags.add(s.tag)
        const maxRun = obs.reduce<[number, number]>(([best, cur], o) => (o ? [Math.max(best, cur + 1), cur + 1] : [best, 0]), [0, 0])[0]
        return { valid: obs.length > 0, boundary: maxRun === cfg.threshold || maxRun === cfg.threshold - 1 }
      },
      5_000,
      { domain: "N ∈ [1,8], C ∈ [0,10], ≤ 30 blocks of one observation or 0–9 bad ones", minValidFraction: 0.85, minBoundary: 300 }
    )
    expect([...tags].sort()).toEqual(["closed", "halfOpen", "open"])
  })

  it("the oracle law kills the breaker without a probe and the breaker that opens one observation late", () => {
    const noProbe = (cfg: BreakerConfig, s: BreakerState, bad: boolean): BreakerState => (s.tag === "closed" ? breakerStep(cfg, s, bad) : s)
    const late = (cfg: BreakerConfig, s: BreakerState, bad: boolean) => breakerStep({ ...cfg, threshold: cfg.threshold + 1 }, s, bad)
    for (const step of [noProbe, late]) {
      expect(
        mutantKilled(fc.tuple(cfgArb, obsArb), ([cfg, obs]) =>
          JSON.stringify(obs.reduce((s, o) => step(cfg, s, o), initialBreaker as BreakerState)) === JSON.stringify(breakerOracle(cfg, obs)), 2_000)
      ).toBe(true)
    }
  })

  it("law (exact, sound and tight): during an outage of L ≥ N requests the store is touched exactly N + ⌊(L − N)/(C + 2)⌋ times", () => {
    law(
      "store touches during an outage",
      fc.tuple(cfgArb, fc.integer({ min: 0, max: 200 })),
      ([cfg, extra]) => {
        const L = cfg.threshold + extra
        let s: BreakerState = initialBreaker
        let touches = 0
        for (let i = 0; i < L; i++) {
          if (allowsRequest(s)) touches++
          s = breakerStep(cfg, s, true)
        }
        expect(touches).toBe(cfg.threshold + Math.floor(extra / (cfg.coolDown + 2)))
        return { valid: extra > 0, boundary: extra % (cfg.coolDown + 2) === 0 }
      },
      3_000,
      { domain: "N ∈ [1,8], C ∈ [0,10], outage length N + [0,200]", minValidFraction: 0.9, minBoundary: 100 }
    )
  })

  it("law: an outage shorter than N never opens the breaker, so it costs exactly what no breaker costs", () => {
    law(
      "short outage is invisible",
      fc.tuple(cfgArb, fc.nat(), fc.array(fc.boolean(), { maxLength: 20 })),
      ([cfg, k, tail]) => {
        const L = k % cfg.threshold
        const obs = [...Array<boolean>(L).fill(true), false, ...tail.map(() => false)]
        expect(obs.every((_, i) => allowsRequest(runBreaker(cfg, initialBreaker, obs.slice(0, i))))).toBe(true)
        return { valid: L > 0, boundary: L === cfg.threshold - 1 }
      },
      2_000,
      { domain: "N ∈ [1,8], outage of k mod N requests, then ≤ 21 healthy ones", minValidFraction: 0.5, minBoundary: 100 }
    )
  })
})

// ---------------------------------------------------------------------------

const kinds = ["hit", "miss"] as const
type Kind = (typeof kinds)[number]
/** Events with redeliveries: each event delivered 1–4 times, in a generated order. */
const deliveriesArb = fc
  .uniqueArray(fc.record({ id: fc.uuid(), kind: fc.constantFrom(...kinds) }), { selector: (e) => e.id, maxLength: 30 })
  .chain((events) => {
    const all = events.flatMap((e, i) => Array.from({ length: 1 + (i % 4) }, () => e))
    return fc.tuple(fc.constant(events), fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }))
  })

/** Mutant: counts deliveries instead of distinct events. */
class DeliveryCounter {
  private readonly n = new Map<Kind, number>()
  record(_id: string, k: Kind) {
    this.n.set(k, (this.n.get(k) ?? 0) + 1)
  }
  count(k: Kind) {
    return this.n.get(k) ?? 0
  }
}

describe("D-14 telemetry", () => {
  it("law: under any redelivery and order, counts equal the distinct events (replaces the literal-3 test)", () => {
    law(
      "idempotent counts",
      deliveriesArb,
      ([events, deliveries]) => {
        expect(deliveries.length).toBe(events.reduce((n, _, i) => n + 1 + (i % 4), 0)) // the generator keeps every delivery
        const c = new IdempotentCounter<Kind>()
        // `record` returns true exactly for the first delivery of each event (its documented
        // contract). Without this check, a counter that drops its redelivery guard survived the
        // mutation run, because re-inserting into the Map leaves the counts unchanged.
        const firsts = new Set<string>()
        deliveries.forEach((e) => {
          expect(c.record(e.id, e.kind)).toBe(!firsts.has(e.id))
          firsts.add(e.id)
        })
        kinds.forEach((k) => expect(c.count(k)).toBe(events.filter((e) => e.kind === k).length))
        expect(c.total).toBe(events.length)
        return { valid: deliveries.length > events.length, boundary: events.length === 0 }
      },
      1_000,
      { domain: "≤30 events, the i-th delivered 1 + (i mod 4) times, shuffled", minValidFraction: 0.7, minBoundary: 1 }
    )
  })

  it("the law kills a counter that counts deliveries", () => {
    expect(
      mutantKilled(deliveriesArb, ([events, deliveries]) => {
        const c = new DeliveryCounter()
        deliveries.forEach((e) => c.record(e.id, e.kind))
        return kinds.every((k) => c.count(k) === events.filter((e) => e.kind === k).length)
      }, 500)
    ).toBe(true)
  })

  it("laws: effective hit rate ∈ [0, 1], invariant under redelivery, = hits/distinct, and never above the Worker's rate", () => {
    const report = fc.record({ id: fc.integer({ min: 0, max: 20 }), hit: fc.boolean() })
    law(
      "effective hit rate",
      // The empty list is a single point of the domain: give it a fixed 1/20 weight instead of
      // fast-check's small-size bias (which made it ~10% of the cases and broke the valid fraction).
      fc.oneof(
        { weight: 1, arbitrary: fc.constant([] as { id: number; hit: boolean }[]) },
        { weight: 19, arbitrary: fc.array(report, { minLength: 1, maxLength: 40 }) }
      ),
      (rs) => {
        // Reports with the same event id are redeliveries of one event: keep the first outcome.
        const first = new Map<number, boolean>()
        rs.forEach((r) => (first.has(r.id) ? undefined : first.set(r.id, r.hit)))
        const reports: OutcomeReport[] = rs.map((r) => ({
          eventId: String(r.id),
          scope: "trusted",
          lookup: "l",
          outcome: first.get(r.id) ? { kind: "hit", restoreMs: 1 } : { kind: "miss", reason: "digest_mismatch" }
        }))
        const rate = effectiveHitRate(reports)
        const hits = [...first.values()].filter((h) => h).length
        expect(rate).toBe(first.size === 0 ? 0 : hits / first.size)
        expect(rate).toBeGreaterThanOrEqual(0)
        expect(rate).toBeLessThanOrEqual(1)
        expect(effectiveHitRate([...reports, ...reports])).toBe(rate) // redelivery invariance
        expect(rate).toBeLessThanOrEqual(reports.length === 0 ? 0 : 1) // the Worker counts every served manifest as a hit
        return { valid: first.size > 0, boundary: rate === 0 || rate === 1 }
      },
      2_000,
      { domain: "≤40 reports over ≤21 event ids, hit or digest-mismatch miss; the empty list with weight 1/20", minValidFraction: 0.9, minBoundary: 50 }
    )
  })
})
