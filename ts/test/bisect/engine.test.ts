/**
 * Behaviour of complete searches (`bisectSync`, `bisectEffect`,
 * `standardBisect`) and of the Artifacts commit-range adapter.
 *
 * Statistical tests use a PRNG seeded from the harness seed (fresh per run,
 * pinned with `FC_SEED`). Their thresholds sit well below the measured
 * values (see each test) so that a correct implementation fails with
 * negligible probability, while the mutants in `scripts/mutation-check.sh`
 * and the planted ones here fall far below them.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilled, mutantKilledAsync, SEED } from "../harness.js"
import {
  type BisectModel,
  bisectEffect,
  bisectRepo as bisectRepoEffect,
  bisectSync,
  type CommitInfo,
  type CommitLog,
  commitRange as commitRangeEffect,
  CommitRangeError,
  LOG_PAGE_LIMIT,
  nextAction,
  standardBisect
} from "../../src/bisect/index.js"
import { Effect, runPromiseOrThrow } from "../../src/fx/index.js"

/** `commitRange` run as a Promise (rejects with the typed failure). */
const commitRange = (repo: CommitLog, goodRef: string, badRef: string, max?: number): Promise<ReadonlyArray<CommitInfo>> =>
  runPromiseOrThrow(commitRangeEffect(repo, goodRef, badRef, max))

announce("test/bisect/engine.test.ts")

/** mulberry32: small seeded PRNG for Monte-Carlo tests. */
const prng = (seed: number) => {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const deterministic = (n: number): BisectModel => ({
  n,
  newRate: { kind: "known", p: 1 },
  oldRate: { kind: "known", p: 0 }
})

describe("deterministic predicate", () => {
  it("finds every culprit for every n ≤ 64 in at most ⌈log₂ n⌉ runs (exhaustive)", () => {
    let cases = 0
    for (let n = 1; n <= 64; n++) {
      for (let culprit = 0; culprit < n; culprit++) {
        const r = bisectSync(deterministic(n), (i) => i >= culprit, { confidence: 1, maxSteps: 100 })
        expect(r.culprit).toBe(culprit)
        expect(r.converged).toBe(true)
        expect(r.confidence).toBe(1)
        expect(r.steps.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)))
        cases++
      }
    }
    expect(cases).toBe((64 * 65) / 2)
  })

  it("standard bisect also finds every culprit when the predicate is deterministic (control for the flaky comparison)", () => {
    for (let n = 1; n <= 64; n++) {
      for (let culprit = 0; culprit < n; culprit++) {
        const r = standardBisect(n, (i) => i >= culprit)
        expect(r.culprit).toBe(culprit)
        expect(r.steps).toBeLessThanOrEqual(Math.ceil(Math.log2(n)))
      }
    }
  })

  it("regression: n = 16, culprit 11 → tests 7, 11, 9, 10 (recorded)", () => {
    const r = bisectSync(deterministic(16), (i) => i >= 11, { confidence: 1, maxSteps: 20 })
    expect(r.steps.map((s) => [s.index, s.failed])).toEqual([
      [7, false],
      [11, true],
      [9, false],
      [10, false]
    ])
    expect(r.culprit).toBe(11)
  })
})

describe("flaky predicate (false negatives: a bad commit sometimes passes)", () => {
  /**
   * Measured on n = 32, 200 trials (seed 42): Bayesian accuracy 0.99 / 0.975
   * / 0.94 / 0.955 at false-negative rates 0.1 / 0.2 / 0.3 / 0.5; standard
   * bisect 0.765 / 0.59 / 0.425 / 0.23. Thresholds: Bayesian ≥ 0.85, and at
   * least 0.12 above standard bisect.
   */
  for (const fnRate of [0.1, 0.2, 0.3, 0.5]) {
    it(`known rates, false-negative rate ${fnRate}: much more accurate than standard bisect`, () => {
      const rand = prng(SEED ^ Math.round(fnRate * 1000))
      const n = 32
      // 600 trials: at fn = 0.1 the gap over 40 random seeds averaged ≈ 0.21
      // (min 0.17) with a standard deviation of ≈ 0.018, so the 0.12 floor
      // sits ≈ 5 sd below it. With 150 trials and a 0.15 floor it sat ≈ 2 sd
      // below and failed in about 2% of runs.
      const trials = 600
      let bayes = 0
      let standard = 0
      for (let t = 0; t < trials; t++) {
        const culprit = Math.floor(rand() * n)
        const predicate = (i: number) => (i >= culprit ? rand() >= fnRate : false)
        const r = bisectSync(
          { n, newRate: { kind: "known", p: 1 - fnRate }, oldRate: { kind: "known", p: 0 } },
          predicate,
          { confidence: 0.95, maxSteps: 120 }
        )
        if (r.culprit === culprit) bayes++
        if (standardBisect(n, predicate).culprit === culprit) standard++
      }
      console.log(`[stat] fn=${fnRate} bayes=${bayes}/${trials} standard=${standard}/${trials} seed=${SEED}`)
      expect(bayes / trials).toBeGreaterThanOrEqual(0.85)
      expect(bayes / trials - standard / trials).toBeGreaterThanOrEqual(0.12)
    })
  }

  it("unknown rates (Beta(1,1) priors on both sides) still finds the culprit at 30% flakiness", () => {
    // Measured: 1.0 accuracy, ≈ 29 runs on average (seed 42, 200 trials). Threshold 0.85.
    const rand = prng(SEED ^ 0x5eed)
    const n = 32
    const trials = 60
    let correct = 0
    for (let t = 0; t < trials; t++) {
      const culprit = Math.floor(rand() * n)
      const r = bisectSync(
        { n, newRate: { kind: "beta", alpha: 1, beta: 1 }, oldRate: { kind: "beta", alpha: 1, beta: 1 } },
        (i) => (i >= culprit ? rand() >= 0.3 : false),
        { confidence: 0.95, maxSteps: 150 }
      )
      if (r.culprit === culprit) correct++
    }
    console.log(`[stat] beta-prior fn=0.3 correct=${correct}/${trials} seed=${SEED}`)
    expect(correct / trials).toBeGreaterThanOrEqual(0.85)
  })

  it("calibration: when it stops at confidence ≥ 0.9, it is right at least ~90% of the time (truth drawn from the prior)", () => {
    // Bayesian calibration survives optional stopping when the model is correct.
    // 400 trials; the binomial standard deviation at 0.9 is 0.015, threshold 0.9 − 4σ = 0.84.
    const rand = prng(SEED ^ 0xca1)
    const trials = 400
    let stopped = 0
    let correct = 0
    for (let t = 0; t < trials; t++) {
      const n = 2 + Math.floor(rand() * 30)
      const culprit = Math.floor(rand() * n)
      const pNew = 0.5 + 0.45 * rand()
      const pOld = 0.2 * rand()
      const r = bisectSync(
        { n, newRate: { kind: "known", p: pNew }, oldRate: { kind: "known", p: pOld } },
        (i) => rand() < (i >= culprit ? pNew : pOld),
        { confidence: 0.9, maxSteps: 200 }
      )
      if (r.converged) {
        stopped++
        if (r.culprit === culprit) correct++
      }
    }
    console.log(`[stat] calibration stopped=${stopped}/${trials} correct=${correct} seed=${SEED}`)
    expect(stopped).toBeGreaterThan(trials * 0.9)
    expect(correct / stopped).toBeGreaterThanOrEqual(0.84)
  })
})

describe("runner contract", () => {
  it("bisectEffect makes the same decisions as bisectSync", async () => {
    const rand = prng(SEED ^ 0xa5)
    for (let t = 0; t < 20; t++) {
      const n = 1 + Math.floor(rand() * 40)
      const culprit = Math.floor(rand() * n)
      const answers = Array.from({ length: 300 }, () => rand() >= 0.2)
      let k1 = 0
      let k2 = 0
      const m: BisectModel = { n, newRate: { kind: "beta", alpha: 2, beta: 1 }, oldRate: { kind: "known", p: 0.01 } }
      const opts = { confidence: 0.95, maxSteps: 80 }
      const a = bisectSync(m, (i) => (i >= culprit ? answers[k1++]! : false), opts)
      const b = await runPromiseOrThrow(bisectEffect(m, (i) => Effect.sync(() => (i >= culprit ? answers[k2++]! : false)), opts))
      expect(b).toEqual(a)
    }
  })

  /*
   * Rule (replaces one run with n = 50, maxSteps = 7): for any model,
   * predicate and step budget k, a search runs at most k tests; it reports
   * `converged` iff its final confidence reaches the threshold; and if it did
   * not converge it used the whole budget.
   */
  const budgetCase = fc.record({
    n: fc.integer({ min: 2, max: 60 }),
    k: fc.integer({ min: 0, max: 25 }),
    pNew: fc.double({ min: 0.3, max: 0.95, noNaN: true }),
    gap: fc.double({ min: 0, max: 0.25, noNaN: true }),
    threshold: fc.constantFrom(0.5, 0.9, 0.99, 0.999),
    seed: fc.integer()
  })
  type BudgetCase = { n: number; k: number; pNew: number; gap: number; threshold: number; seed: number }
  type Search = (m: BisectModel, p: (i: number) => boolean, o: { confidence: number; maxSteps: number }) => { steps: ReadonlyArray<unknown>; converged: boolean; confidence: number }
  const budgetFollowsRule = (search: Search, c: BudgetCase): boolean => {
    const rand = prng(c.seed)
    const culprit = Math.floor(rand() * c.n)
    const pOld = Math.max(0, c.pNew - c.gap)
    const r = search({ n: c.n, newRate: { kind: "known", p: c.pNew }, oldRate: { kind: "known", p: pOld } }, (i) => rand() < (i >= culprit ? c.pNew : pOld), {
      confidence: c.threshold,
      maxSteps: c.k
    })
    return r.steps.length <= c.k && r.converged === r.confidence >= c.threshold && (r.converged || r.steps.length === c.k)
  }
  /** Mutant 1: off by one — runs one test more than the budget. */
  const overBudget: Search = (m, p, o) => bisectSync(m, p, { ...o, maxSteps: o.maxSteps + 1 })
  /** Mutant 2: claims convergence whenever it stops. */
  const alwaysConverged: Search = (m, p, o) => ({ ...bisectSync(m, p, o), converged: true })

  it("law: at most maxSteps tests; converged ⇔ confidence ≥ threshold; not converged ⇒ budget used up", () => {
    let exhausted = 0
    law(
      "step budget",
      budgetCase,
      (c) => {
        expect(budgetFollowsRule(bisectSync, c), JSON.stringify(c)).toBe(true)
        const rand = prng(c.seed)
        const culprit = Math.floor(rand() * c.n)
        const pOld = Math.max(0, c.pNew - c.gap)
        const r = bisectSync({ n: c.n, newRate: { kind: "known", p: c.pNew }, oldRate: { kind: "known", p: pOld } }, (i) => rand() < (i >= culprit ? c.pNew : pOld), { confidence: c.threshold, maxSteps: c.k })
        if (!r.converged) exhausted++
        return { valid: c.k > 0, boundary: c.k === 0 || r.steps.length === c.k }
      },
      200,
      { domain: "n 2–60, budget 0–25, weakly informative known rates (gap 0–0.25), thresholds 0.5–0.999", minValidFraction: 0.8, minBoundary: 30 }
    )
    expect(exhausted).toBeGreaterThan(20)
  })

  it("budget counterexample 1 (mutant: one step over budget): n = 50, uninformative rates, budget 7", () => {
    const c = { n: 50, k: 7, pNew: 0.5, gap: 0.1, threshold: 0.999, seed: 1 }
    expect(budgetFollowsRule(bisectSync, c)).toBe(true)
    expect(budgetFollowsRule(overBudget, c)).toBe(false)
  })

  it("budget counterexample 2 (mutant: always claims convergence): the same search stopped by its budget", () => {
    const c = { n: 50, k: 7, pNew: 0.5, gap: 0.1, threshold: 0.999, seed: 2 }
    expect(budgetFollowsRule(bisectSync, c)).toBe(true)
    expect(budgetFollowsRule(alwaysConverged, c)).toBe(false)
  })

  it("budget negation 1: the law is refuted for the over-budget mutant", () => {
    expect(mutantKilled(budgetCase, (c) => budgetFollowsRule(overBudget, c), 200)).toBe(true)
  })

  it("budget negation 2: the law is refuted for the always-converged mutant", () => {
    expect(mutantKilled(budgetCase, (c) => budgetFollowsRule(alwaysConverged, c), 200)).toBe(true)
  })

  it("n = 1 needs no runs", () => {
    const r = bisectSync(deterministic(1), () => {
      throw new Error("must not run")
    }, { confidence: 0.99, maxSteps: 10 })
    expect(r).toMatchObject({ culprit: 0, confidence: 1, converged: true, steps: [] })
  })

  it("rejects invalid options", () => {
    expect(() => nextAction(deterministic(4), [], { confidence: 0, maxSteps: 3 })).toThrow(RangeError)
    expect(() => nextAction(deterministic(4), [], { confidence: 1.1, maxSteps: 3 })).toThrow(RangeError)
    expect(() => nextAction(deterministic(4), [], { confidence: 0.9, maxSteps: -1 })).toThrow(RangeError)
    expect(() => standardBisect(0, () => true)).toThrow(RangeError)
  })

  it("confidence after each step is reported consistently with the final result", () => {
    law(
      "last step's confidence = result confidence",
      fc.record({ n: fc.integer({ min: 2, max: 30 }), culprit: fc.nat(), seed: fc.integer() }),
      ({ n, culprit, seed }) => {
        const b = culprit % n
        const rand = prng(seed)
        const r = bisectSync(
          { n, newRate: { kind: "known", p: 0.8 }, oldRate: { kind: "known", p: 0.05 } },
          (i) => rand() < (i >= b ? 0.8 : 0.05),
          { confidence: 0.9, maxSteps: 60 }
        )
        const last = r.steps.at(-1)!
        expect(last.confidence).toBe(r.confidence)
        expect(last.map).toBe(r.culprit)
        return { valid: r.steps.length > 0, boundary: b === 0 || b === n - 1 }
      },
      60,
      { domain: "n∈[2,30], flaky known rates 0.8 / 0.05", minValidFraction: 0.9, minBoundary: 2 }
    )
  })
})

// ---------------------------------------------------------------------------
// Artifacts commit range

/** In-memory first-parent history: `refs` name an index into `chain` (newest first from that index). */
const fakeRepo = (chain: ReadonlyArray<CommitInfo>, refs: Record<string, number>) => {
  const calls: Array<{ ref: string; limit: number | undefined; offset: number | undefined }> = []
  const repo: CommitLog = {
    log: async ({ ref, limit, offset }) => {
      calls.push({ ref, limit, offset })
      if (limit !== undefined && limit > LOG_PAGE_LIMIT) throw new Error("limit above documented maximum")
      const start = refs[ref]
      if (start === undefined) return []
      const from = start + (offset ?? 0)
      return chain.slice(from, from + (limit ?? 50))
    }
  }
  return { repo, calls }
}

/** `chain[0]` is the newest commit; `chain[k]` is k first-parent steps older. */
const history = (len: number): Array<CommitInfo> =>
  Array.from({ length: len }, (_, i) => ({ oid: `c${len - 1 - i}`, message: `commit ${len - 1 - i}` }))

describe("commitRange (Artifacts log adapter)", () => {
  it("returns the commits after good up to bad, oldest first, across page boundaries", async () => {
    const rand = prng(SEED ^ 0xc0)
    let crossedPage = 0
    for (let t = 0; t < 40; t++) {
      const len = 2 + Math.floor(rand() * 2600)
      const bad = Math.floor(rand() * (len - 1))
      const good = bad + 1 + Math.floor(rand() * (len - 1 - bad))
      const chain = history(len)
      const { repo } = fakeRepo(chain, { main: bad, good: good })
      const range = await commitRange(repo, "good", "main")
      expect(range).toEqual(chain.slice(bad, good).reverse())
      if (good - bad > LOG_PAGE_LIMIT) crossedPage++
    }
    // Pin the multi-page path deterministically as well.
    const chain = history(2500)
    const { repo, calls } = fakeRepo(chain, { main: 0, good: 2300 })
    const range = await commitRange(repo, "good", "main")
    expect(range.length).toBe(2300)
    expect(range[0]!.oid).toBe("c200")
    expect(range.at(-1)!.oid).toBe("c2499")
    // "main" is resolved (pinned) first. This fake's log() does not accept a
    // commit id, so the pinned page 0 is empty and the branch is paged by name,
    // then re-resolved to check it did not move.
    expect(calls.filter((c) => c.limit === LOG_PAGE_LIMIT).map((c) => [c.ref, c.offset])).toEqual([
      [chain[0]!.oid, 0],
      ["main", 0],
      ["main", 1000],
      ["main", 2000]
    ])
    expect(calls.filter((c) => c.ref === "main" && c.limit === 1).length).toBe(2)
    console.log(`[law] commitRange random cases crossing a page boundary: ${crossedPage}`)
  })

  it("uses the newest commit of the good ref, not the oldest commit of its first page (proposal bug)", async () => {
    const chain = history(30)
    const { repo } = fakeRepo(chain, { main: 0, good: 10 })
    const range = await commitRange(repo, "good", "main")
    // good = c19, so candidates are c20 … c29. The proposal's `goodCommits[goodCommits.length - 1]`
    // would have picked c0 (the oldest commit in the page) and returned 29 candidates.
    expect(range.map((c) => c.oid)).toEqual(Array.from({ length: 10 }, (_, i) => `c${20 + i}`))
  })

  /*
   * Rule (replaces three hand-picked rejections): for a first-parent history
   * and refs good, bad, `commitRange(good, bad, max)` returns the commits
   * strictly after good up to bad, oldest first, iff good is a strict
   * first-parent ancestor of bad and there are at most `max` such commits;
   * otherwise (good newer than or equal to bad, unknown ref, more than `max`
   * commits) it throws CommitRangeError. Positions, lengths and caps are
   * generated, including equal endpoints and caps at range length ± 1.
   */
  const rangeCase = fc
    .record({
      len: fc.oneof(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 990, max: 2300 })),
      a: fc.nat({ max: 1_000_000 }),
      b: fc.nat({ max: 1_000_000 }),
      order: fc.constantFrom("older", "older", "older", "equal", "newer"),
      goodKnown: fc.oneof({ weight: 5, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
      cap: fc.constantFrom("default", "exact", "above", "below")
    })
    .map((c) => {
      // `bad` is a chain index (0 = newest); "older" puts good strictly further down the chain.
      const bad = c.a % (c.len - 1)
      const good = c.order === "equal" ? bad : c.order === "older" ? bad + 1 + (c.b % (c.len - 1 - bad)) : c.b % (bad + 1)
      const size = good - bad
      const max = c.cap === "default" ? undefined : c.cap === "exact" ? Math.max(1, size) : c.cap === "below" ? Math.max(1, size - 1) : Math.max(1, size + 1)
      return { len: c.len, goodKnown: c.goodKnown, bad, good, max }
    })
  type RangeCase = { len: number; bad: number; good: number; goodKnown: boolean; max: number | undefined }
  type RangeFn = (repo: CommitLog, goodRef: string, badRef: string, max?: number) => Promise<ReadonlyArray<CommitInfo>>
  /** Oracle from the rule: the expected range, or null for "must throw". */
  const expectedRange = (c: RangeCase, chain: ReadonlyArray<CommitInfo>): ReadonlyArray<CommitInfo> | null => {
    if (!c.goodKnown || c.good <= c.bad) return null
    if (c.good - c.bad > (c.max ?? 10_000)) return null
    return chain.slice(c.bad, c.good).reverse()
  }
  const rangeFollowsRule = async (impl: RangeFn, c: RangeCase): Promise<boolean> => {
    const chain = history(c.len)
    const { repo } = fakeRepo(chain, c.goodKnown ? { main: c.bad, good: c.good } : { main: c.bad })
    const want = expectedRange(c, chain)
    try {
      const got = await impl(repo, "good", "main", c.max)
      return want !== null && JSON.stringify(got) === JSON.stringify(want)
    } catch (e) {
      return want === null && e instanceof CommitRangeError
    }
  }
  /** Mutant 1: equal endpoints give an empty range instead of an error. */
  const emptyOnEqual: RangeFn = async (repo, g, b, max) => {
    const [pg, pb] = await Promise.all([repo.log({ ref: g, limit: 1 }), repo.log({ ref: b, limit: 1 })])
    if (pg.length > 0 && pb.length > 0 && JSON.stringify(pg[0]) === JSON.stringify(pb[0])) return []
    return commitRange(repo, g, b, max)
  }
  /** Mutant 2: the candidate cap is ignored. */
  const uncapped: RangeFn = (repo, g, b) => commitRange(repo, g, b)

  it("law: commitRange returns (good, bad] iff good is a strict first-parent ancestor within the cap; otherwise CommitRangeError", async () => {
    let accepted = 0
    let rejected = 0
    let capBound = 0
    await lawAsync(
      "commitRange accepts exactly the valid ranges",
      rangeCase,
      async (c) => {
        expect(await rangeFollowsRule(commitRange, c), JSON.stringify(c)).toBe(true)
        const want = expectedRange(c, history(c.len))
        if (want === null) rejected++
        else accepted++
        if (c.goodKnown && c.max !== undefined && c.good - c.bad > c.max) capBound++
        return { valid: true, boundary: c.good === c.bad || c.good - c.bad === c.max || c.good - c.bad === (c.max ?? 0) + 1 }
      },
      150,
      { domain: "histories of 2–60 or 990–2300 commits, good older/equal/newer than bad, unknown good, caps at size−1/size/size+1", minValidFraction: 1, minBoundary: 15 }
    )
    // Both verdicts must be frequent, or the law degenerates into "always throws" / "always accepts".
    expect(accepted).toBeGreaterThan(30)
    expect(rejected).toBeGreaterThan(30)
    expect(capBound, "cases where the cap decides").toBeGreaterThanOrEqual(5)
  })

  it("commitRange counterexample 1 (mutant: equal endpoints → empty range)", async () => {
    const c = { len: 30, bad: 10, good: 10, goodKnown: true, max: undefined }
    expect(await rangeFollowsRule(commitRange, c)).toBe(true)
    expect(await rangeFollowsRule(emptyOnEqual, c)).toBe(false)
  })

  it("commitRange counterexample 2 (mutant: cap ignored): 40 candidates with a cap of 20", async () => {
    const c = { len: 50, bad: 0, good: 40, goodKnown: true, max: 20 }
    expect(await rangeFollowsRule(commitRange, c)).toBe(true)
    expect(await rangeFollowsRule(uncapped, c)).toBe(false)
  })

  it("commitRange negation 1: the law is refuted for the empty-on-equal mutant", async () => {
    expect(await mutantKilledAsync(rangeCase.chain((c) => fc.boolean().map((equal) => (equal ? { ...c, good: c.bad } : c))), (c) => rangeFollowsRule(emptyOnEqual, c), 150)).toBe(true)
  })

  it("commitRange negation 2: the law is refuted for the uncapped mutant", async () => {
    // Restricted to cases where the cap binds (the only region where the mutant can differ).
    const capBinds = rangeCase.filter((c) => c.goodKnown && c.max !== undefined && c.good - c.bad > c.max)
    expect(await mutantKilledAsync(capBinds, (c) => rangeFollowsRule(uncapped, c), 50)).toBe(true)
  })

  it("bisectRepo finds the culprit commit by oid with a flaky predicate", async () => {
    const chain = history(200)
    const { repo } = fakeRepo(chain, { main: 0, good: 150 })
    // Fixed seed: this is a pinned regression, not a statistical test.
    const rand = prng(12345)
    const culpritNumber = 120 // commit c120 introduced the bug; candidates are c50 … c199
    const r = await runPromiseOrThrow(bisectRepoEffect({
      repo,
      goodRef: "good",
      badRef: "main",
      newRate: { kind: "known", p: 0.75 },
      oldRate: { kind: "known", p: 0 },
      predicate: (c) => Effect.sync(() => Number(c.oid.slice(1)) >= culpritNumber && rand() < 0.75),
      options: { confidence: 0.99, maxSteps: 200 }
    }))
    expect(r.range.length).toBe(150)
    expect(r.converged).toBe(true)
    expect(r.culpritCommit.oid).toBe("c120")
  })
})
