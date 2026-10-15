/**
 * Laws of the Bayesian bisection model (`src/bisect/model.ts`,
 * `src/bisect/engine.ts`).
 *
 * Every law is checked against an oracle computed along a *different* path
 * from the code under test (numerical integration, brute-force consistency
 * filtering, the O(n²) direct entropy computation, ratios of marginal
 * likelihoods), with total / valid / boundary counts (`harness.ts`).
 * Mutants of the source are in `scripts/mutation-check.sh`; the planted
 * mutant of the proposal's update rule is at the end of this file.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, mutantKilled } from "../harness.js"
import {
  type BisectModel,
  conditionalFailProbabilities,
  entropy,
  expectedEntropies,
  failProbabilities,
  InconsistentObservations,
  InvalidModel,
  logMarginal,
  logPosteriorUnnormalised,
  type Observation,
  posterior,
  type Rate,
  selectNext
} from "../../src/bisect/index.js"

announce("test/bisect/model.test.ts")

// ---------------------------------------------------------------------------
// Generators

/** Rates strictly inside (0, 1) or Beta priors; includes values near the ends. */
const arbRate: fc.Arbitrary<Rate> = fc.oneof(
  fc.double({ min: 0.001, max: 0.999, noNaN: true }).map((p) => ({ kind: "known" as const, p })),
  fc
    .record({
      alpha: fc.double({ min: 0.2, max: 8, noNaN: true }),
      beta: fc.double({ min: 0.2, max: 8, noNaN: true })
    })
    .map(({ alpha, beta }) => ({ kind: "beta" as const, alpha, beta }))
)

const arbModelObs = (maxN: number, maxObs: number, withPrior = true) =>
  fc.integer({ min: 1, max: maxN }).chain((n) =>
    fc.record({
      model: fc.record({
        n: fc.constant(n),
        newRate: arbRate,
        oldRate: arbRate,
        prior: withPrior
          ? fc.option(fc.array(fc.double({ min: 0.01, max: 10, noNaN: true }), { minLength: n, maxLength: n }), {
              nil: undefined
            })
          : fc.constant(undefined)
      }),
      obs: fc.array(
        fc.record({ index: fc.integer({ min: 0, max: n - 1 }), failed: fc.boolean() }),
        { maxLength: maxObs }
      )
    })
  ).map(({ model, obs }) => ({ model: dropUndefined(model), obs }))

const dropUndefined = (m: { n: number; newRate: Rate; oldRate: Rate; prior: Array<number> | undefined }): BisectModel =>
  m.prior === undefined
    ? { n: m.n, newRate: m.newRate, oldRate: m.oldRate }
    : { n: m.n, newRate: m.newRate, oldRate: m.oldRate, prior: m.prior }

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))

const logSumExp = (xs: ArrayLike<number>): number => {
  let max = -Infinity
  for (let i = 0; i < xs.length; i++) max = Math.max(max, xs[i]!)
  if (max === -Infinity) return -Infinity
  let s = 0
  for (let i = 0; i < xs.length; i++) s += Math.exp(xs[i]! - max)
  return max + Math.log(s)
}

// ---------------------------------------------------------------------------

describe("posterior", () => {
  it("is a probability vector (non-negative, sums to 1)", () => {
    law(
      "posterior is normalised",
      arbModelObs(40, 30),
      ({ model, obs }) => {
        const w = posterior(model, obs)
        expect(w.length).toBe(model.n)
        for (const x of w) expect(x).toBeGreaterThanOrEqual(0)
        expect(Math.abs(w.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9)
        return { valid: obs.length > 0, boundary: model.n === 1 || obs.length === 0 }
      },
      300,
      { domain: "n∈[1,40], ≤30 observations, rates known∈(0,1) or Beta(0.2..8)", minValidFraction: 0.8, minBoundary: 3 }
    )
  })

  it("never eliminates a hypothesis when rates are strictly between 0 and 1 (no false elimination under flakiness)", () => {
    law(
      "every hypothesis keeps positive probability",
      arbModelObs(30, 40),
      ({ model, obs }) => {
        const logw = logPosteriorUnnormalised(model, obs)
        for (const v of logw) expect(Number.isFinite(v)).toBe(true)
        const w = posterior(model, obs)
        // Underflow to exactly 0 is possible in floating point only far beyond these sizes.
        for (const x of w) expect(x).toBeGreaterThan(0)
        return { valid: obs.length > 0, boundary: obs.length === 0 || model.n === 1 }
      },
      300,
      { domain: "n∈[1,30], ≤40 observations, rates in (0,1)", minValidFraction: 0.8, minBoundary: 3 }
    )
  })

  it("chain rule: adding one observation multiplies by the predictive probability (sequential = batch)", () => {
    law(
      "posterior(obs ++ [o]) ∝ posterior(obs) · P(o | B = b, obs)",
      fc.tuple(arbModelObs(30, 25), fc.nat(), fc.boolean()),
      ([{ model, obs }, i, failed]) => {
        const index = i % model.n
        const before = posterior(model, obs)
        const q = conditionalFailProbabilities(model, obs, index)
        const unnorm = before.map((w, b) => w * (failed ? q[b]! : 1 - q[b]!))
        const z = unnorm.reduce((a, b) => a + b, 0)
        const after = posterior(model, [...obs, { index, failed }])
        for (let b = 0; b < model.n; b++) expect(close(after[b]!, unnorm[b]! / z, 1e-7)).toBe(true)
        return { valid: model.n > 1, boundary: index === 0 || index === model.n - 1 }
      },
      300,
      { domain: "n∈[1,30], ≤25 prior observations, one new observation", minValidFraction: 0.7, minBoundary: 20 }
    )
  })

  it("is invariant under reordering of the observations", () => {
    law(
      "posterior(permutation(obs)) = posterior(obs)",
      arbModelObs(25, 25).chain(({ model, obs }) =>
        fc.shuffledSubarray(obs, { minLength: obs.length, maxLength: obs.length }).map((perm) => ({ model, obs, perm }))
      ),
      ({ model, obs, perm }) => {
        const a = posterior(model, obs)
        const b = posterior(model, perm)
        for (let i = 0; i < model.n; i++) expect(close(a[i]!, b[i]!, 1e-9)).toBe(true)
        return { valid: obs.length > 1, boundary: obs.length <= 1 }
      },
      200,
      { domain: "n∈[1,25], ≤25 observations, random permutation", minValidFraction: 0.7, minBoundary: 2 }
    )
  })

  it("deterministic predicate (pNew = 1, pOld = 0): support is exactly the hypotheses consistent with every observation", () => {
    const det: Omit<BisectModel, "n"> = { newRate: { kind: "known", p: 1 }, oldRate: { kind: "known", p: 0 } }
    law(
      "deterministic posterior = uniform on consistent set",
      fc.integer({ min: 1, max: 40 }).chain((n) =>
        fc.record({
          n: fc.constant(n),
          culprit: fc.integer({ min: 0, max: n - 1 }),
          tested: fc.array(fc.integer({ min: 0, max: n - 1 }), { maxLength: 8 })
        })
      ),
      ({ n, culprit, tested }) => {
        const obs: Array<Observation> = tested.map((index) => ({ index, failed: index >= culprit }))
        const consistent = Array.from({ length: n }, (_, b) => obs.every((o) => o.failed === o.index >= b))
        const k = consistent.filter(Boolean).length
        expect(consistent[culprit]).toBe(true)
        const w = posterior({ n, ...det }, obs)
        for (let b = 0; b < n; b++) expect(close(w[b]!, consistent[b] ? 1 / k : 0, 1e-12)).toBe(true)
        return { valid: k < n, boundary: k === 1 || tested.length === 0 }
      },
      300,
      { domain: "n∈[1,40], ≤8 noiseless observations of a random culprit", minValidFraction: 0.5, minBoundary: 10 }
    )
  })

  /*
   * Rule (replaces one example: n = 4, a pass at index 3): under the
   * deterministic model (pNew = 1, pOld = 0) `posterior` throws
   * InconsistentObservations iff NO hypothesis b is consistent with every
   * observation (failed ⇔ index ≥ b); otherwise it returns a finite
   * probability vector. The single example could be passed by an
   * implementation that only looks for a pass at the last commit.
   */
  const detModel = (n: number): BisectModel => ({ n, newRate: { kind: "known", p: 1 }, oldRate: { kind: "known", p: 0 } })
  const detObs = fc.integer({ min: 1, max: 12 }).chain((n) =>
    fc.record({ n: fc.constant(n), obs: fc.array(fc.record({ index: fc.integer({ min: 0, max: n - 1 }), failed: fc.boolean() }), { maxLength: 6 }) })
  )
  const consistentExists = (n: number, obs: ReadonlyArray<Observation>) =>
    Array.from({ length: n }, (_, b) => b).some((b) => obs.every((o) => o.failed === o.index >= b))
  type Post = (m: BisectModel, o: ReadonlyArray<Observation>) => ArrayLike<number>
  const contradictionRuleHolds = (post: Post, n: number, obs: ReadonlyArray<Observation>): boolean => {
    try {
      const w = post(detModel(n), obs)
      return consistentExists(n, obs) && Array.from(w).every((x) => Number.isFinite(x))
    } catch (e) {
      return !consistentExists(n, obs) && e instanceof InconsistentObservations
    }
  }
  /** Mutant 1: returns NaN instead of throwing (the defect the original test was written for). */
  const nanOnContradiction: Post = (m, o) => {
    try {
      return posterior(m, o)
    } catch {
      return new Float64Array(m.n).fill(Number.NaN)
    }
  }
  /** Mutant 2: the example read as the rule — reject only a pass at the last commit. */
  const lastCommitOnly: Post = (m, o) => {
    if (o.some((x) => x.index === m.n - 1 && !x.failed)) throw new InconsistentObservations("pass at the last commit")
    const ok = Array.from({ length: m.n }, (_, b) => b).filter((b) => o.every((x) => x.failed === x.index >= b))
    return Float64Array.from({ length: m.n }, (_, b) => (ok.length === 0 ? 1 / m.n : ok.includes(b) ? 1 / ok.length : 0))
  }

  it("law: under a deterministic model, posterior throws InconsistentObservations iff no hypothesis fits every observation", () => {
    let contradictions = 0
    law(
      "contradiction ⇔ empty consistent set",
      detObs,
      ({ n, obs }) => {
        expect(contradictionRuleHolds(posterior, n, obs), JSON.stringify({ n, obs })).toBe(true)
        if (!consistentExists(n, obs)) contradictions++
        return { valid: obs.length > 0, boundary: n === 1 || obs.length === 0 }
      },
      400,
      { domain: "n 1–12, ≤ 6 noiseless-model observations (any outcomes)", minValidFraction: 0.8, minBoundary: 10 }
    )
    expect(contradictions).toBeGreaterThan(50)
  })

  it("counterexample 1 (mutant: NaN instead of an error): n = 4, a pass at commit 3", () => {
    const obs = [{ index: 3, failed: false }]
    expect(contradictionRuleHolds(posterior, 4, obs)).toBe(true)
    expect(contradictionRuleHolds(nanOnContradiction, 4, obs)).toBe(false)
  })

  it("counterexample 2 (mutant: only a pass at the last commit is rejected): fail at 1 and pass at 2 contradict", () => {
    const obs = [{ index: 1, failed: true }, { index: 2, failed: false }]
    expect(() => posterior(detModel(4), obs)).toThrow(InconsistentObservations)
    expect(contradictionRuleHolds(lastCommitOnly, 4, obs)).toBe(false)
    // The original single-example test cannot tell this mutant apart from the real code:
    expect(() => lastCommitOnly(detModel(4), [{ index: 3, failed: false }])).toThrow(InconsistentObservations)
  })

  it("negation 1: the law is refuted for the NaN mutant", () => {
    expect(mutantKilled(detObs, ({ n, obs }) => contradictionRuleHolds(nanOnContradiction, n, obs), 300)).toBe(true)
  })

  it("negation 2: the law is refuted for the last-commit-only mutant", () => {
    expect(mutantKilled(detObs, ({ n, obs }) => contradictionRuleHolds(lastCommitOnly, n, obs), 300)).toBe(true)
  })

  it("validates its inputs", () => {
    const ok: BisectModel = { n: 3, newRate: { kind: "known", p: 0.9 }, oldRate: { kind: "beta", alpha: 1, beta: 1 } }
    expect(() => posterior({ ...ok, n: 0 }, [])).toThrow(InvalidModel)
    expect(() => posterior({ ...ok, newRate: { kind: "known", p: 1.5 } }, [])).toThrow(InvalidModel)
    expect(() => posterior({ ...ok, oldRate: { kind: "beta", alpha: 0, beta: 1 } }, [])).toThrow(InvalidModel)
    expect(() => posterior({ ...ok, prior: [1, 1] }, [])).toThrow(InvalidModel)
    expect(() => posterior({ ...ok, prior: [0, 0, 0] }, [])).toThrow(InvalidModel)
    expect(() => posterior(ok, [{ index: 3, failed: true }])).toThrow(InvalidModel)
    expect(() => posterior(ok, [{ index: -1, failed: true }])).toThrow(InvalidModel)
  })
})

describe("Beta–Bernoulli marginal likelihood", () => {
  /**
   * Independent oracle: tanh-sinh (double-exponential) quadrature of
   * ∫₀¹ p^(α-1+f) (1-p)^(β-1+s) dp divided by the same integral with f = s = 0.
   * The substitution p = (1 + tanh(π/2 · sinh t)) / 2 handles the endpoint
   * singularities of p^(α-1) for α < 1; `p` and `1 - p` are computed separately
   * so that neither suffers cancellation.
   */
  const integrate = (alpha: number, beta: number, f: number, s: number): number => {
    const quad = (a: number, b: number) => {
      const h = 1 / 64
      let acc = 0
      for (let k = -6 * 64; k <= 6 * 64; k++) {
        const t = k * h
        const u = (Math.PI / 2) * Math.sinh(t)
        const p = 1 / (1 + Math.exp(-2 * u))
        const q = 1 / (1 + Math.exp(2 * u))
        const dp = ((Math.PI / 2) * Math.cosh(t)) / (2 * Math.cosh(u) ** 2)
        if (p > 0 && q > 0 && Number.isFinite(dp)) acc += Math.exp(a * Math.log(p) + b * Math.log(q)) * dp
      }
      return acc * h
    }
    return quad(alpha - 1 + f, beta - 1 + s) / quad(alpha - 1, beta - 1)
  }

  it("equals the numerically integrated marginal ∫ p^f (1-p)^s dBeta(α, β)", () => {
    law(
      "logMarginal = log ∫ likelihood dPrior",
      fc.record({
        alpha: fc.double({ min: 0.3, max: 6, noNaN: true }),
        beta: fc.double({ min: 0.3, max: 6, noNaN: true }),
        f: fc.integer({ min: 0, max: 6 }),
        s: fc.integer({ min: 0, max: 6 })
      }),
      ({ alpha, beta, f, s }) => {
        const exact = Math.exp(logMarginal({ kind: "beta", alpha, beta }, f, s))
        expect(close(exact, integrate(alpha, beta, f, s), 1e-5)).toBe(true)
        return { valid: f + s > 0, boundary: f === 0 || s === 0 }
      },
      150,
      { domain: "α,β∈[0.3,6], f,s∈[0,6]", minValidFraction: 0.8, minBoundary: 10 }
    )
  })

  it("regression: Beta(1,1) with 2 failures and 1 pass gives 1/12", () => {
    // B(3, 2) / B(1, 1) = (2! · 1!) / 4! = 2 / 24.
    expect(Math.exp(logMarginal({ kind: "beta", alpha: 1, beta: 1 }, 2, 1))).toBeCloseTo(1 / 12, 14)
  })
})

describe("selection by expected entropy", () => {
  /** Direct O(n²) oracle: build both hypothetical posteriors with `posterior` itself. */
  const directExpectedEntropy = (m: BisectModel, obs: ReadonlyArray<Observation>, c: number): number => {
    const logZ = logSumExp(logPosteriorUnnormalised(m, obs))
    let e = 0
    for (const failed of [true, false]) {
      const next = [...obs, { index: c, failed }]
      const pOutcome = Math.exp(logSumExp(logPosteriorUnnormalised(m, next)) - logZ)
      if (pOutcome > 0) e += pOutcome * entropy(posterior(m, next))
    }
    return e
  }

  it("the O(n) prefix-sum computation equals the direct O(n²) one", () => {
    law(
      "expectedEntropies = direct expected posterior entropy",
      arbModelObs(25, 20),
      ({ model, obs }) => {
        const fast = expectedEntropies(model, obs)
        for (let c = 0; c < model.n; c++) expect(close(fast[c]!, directExpectedEntropy(model, obs, c), 1e-7)).toBe(true)
        return { valid: model.n > 1, boundary: model.n <= 2 }
      },
      200,
      { domain: "n∈[1,25], ≤20 observations", minValidFraction: 0.8, minBoundary: 3 }
    )
  })

  it("the predictive failure probability equals the ratio of marginal likelihoods", () => {
    law(
      "failProbabilities[c] = P(D, fail at c) / P(D)",
      arbModelObs(25, 20),
      ({ model, obs }) => {
        const p = failProbabilities(model, obs)
        const logZ = logSumExp(logPosteriorUnnormalised(model, obs))
        for (let c = 0; c < model.n; c++) {
          const ratio = Math.exp(logSumExp(logPosteriorUnnormalised(model, [...obs, { index: c, failed: true }])) - logZ)
          expect(close(p[c]!, ratio, 1e-8)).toBe(true)
        }
        return { valid: obs.length > 0, boundary: obs.length === 0 }
      },
      200,
      { domain: "n∈[1,25], ≤20 observations", minValidFraction: 0.8, minBoundary: 2 }
    )
  })

  it("information never hurts: expected posterior entropy ≤ current entropy, for every candidate", () => {
    let strict = 0
    law(
      "E(c) ≤ H(posterior)",
      arbModelObs(30, 20),
      ({ model, obs }) => {
        const h = entropy(posterior(model, obs))
        const e = expectedEntropies(model, obs)
        for (const v of e) expect(v).toBeLessThanOrEqual(h + 1e-9)
        if (e.some((v) => v < h - 1e-6)) strict++
        return { valid: model.n > 1, boundary: model.n === 1 }
      },
      300,
      { domain: "n∈[1,30], ≤20 observations", minValidFraction: 0.8, minBoundary: 3 }
    )
    // Non-degeneracy: the inequality is usually strict, so the law is not vacuously "E = H".
    expect(strict).toBeGreaterThan(100)
  })

  it("selectNext returns a minimiser of the expected entropy", () => {
    law(
      "E(selectNext) = min E",
      arbModelObs(30, 20),
      ({ model, obs }) => {
        const e = expectedEntropies(model, obs)
        const i = selectNext(model, obs)
        expect(e[i]!).toBeLessThanOrEqual(Math.min(...e) + 1e-9)
        return { valid: model.n > 2, boundary: i === 0 || i === model.n - 1 }
      },
      200,
      { domain: "n∈[1,30], ≤20 observations", minValidFraction: 0.7, minBoundary: 5 }
    )
  })

  it("regression: uniform prior over 8 commits, deterministic predicate → first test at commit 3", () => {
    // Splitting {0..7} into {0..3} | {4..7} halves the uncertainty: E = log 4.
    const m: BisectModel = { n: 8, newRate: { kind: "known", p: 1 }, oldRate: { kind: "known", p: 0 } }
    expect(selectNext(m, [])).toBe(3)
    expect(expectedEntropies(m, [])[3]).toBeCloseTo(Math.log(4), 12)
  })
})

describe("planted mutant: the proposal's update rule", () => {
  /**
   * The sketch's `recordObservation`: multiply by the *prior means* of the
   * Beta rates, never updating α, β. Reimplemented here only as a mutant.
   */
  const priorMeanUpdate = (m: BisectModel, obs: ReadonlyArray<Observation>): Float64Array => {
    const mean = (r: Rate) => (r.kind === "known" ? r.p : r.alpha / (r.alpha + r.beta))
    const w = new Float64Array(m.n).fill(1 / m.n)
    for (const o of obs) {
      for (let b = 0; b < m.n; b++) {
        const p = o.index >= b ? mean(m.newRate) : mean(m.oldRate)
        w[b] = w[b]! * (o.failed ? p : 1 - p)
      }
      const s = w.reduce((a, b) => a + b, 0)
      for (let b = 0; b < m.n; b++) w[b] = w[b]! / s
    }
    return w
  }

  const beta11: Omit<BisectModel, "n"> = {
    newRate: { kind: "beta", alpha: 1, beta: 1 },
    oldRate: { kind: "beta", alpha: 1, beta: 1 }
  }
  const scenario = fc.integer({ min: 4, max: 20 }).chain((n) =>
    fc.record({ n: fc.constant(n), culprit: fc.integer({ min: 1, max: n - 1 }), reps: fc.integer({ min: 3, max: 6 }) })
  )
  /** Law: after repeated noiseless observations on both sides of the culprit, the culprit is the MAP. */
  const learnsCulprit = (update: (m: BisectModel, o: ReadonlyArray<Observation>) => Float64Array) =>
    ({ n, culprit, reps }: { n: number; culprit: number; reps: number }) => {
      const obs: Array<Observation> = []
      for (let r = 0; r < reps; r++) {
        for (let c = 0; c < n; c++) obs.push({ index: c, failed: c >= culprit })
      }
      const w = update({ n, ...beta11 }, obs)
      return w.indexOf(Math.max(...w)) === culprit && w[culprit]! > 0.5
    }

  it("control: the exact Beta–Bernoulli posterior learns the culprit", () => {
    expect(mutantKilled(scenario, learnsCulprit(posterior), 100)).toBe(false)
  })

  it("mutant: the prior-mean update never moves the posterior (killed)", () => {
    expect(mutantKilled(scenario, learnsCulprit(priorMeanUpdate), 100)).toBe(true)
    // Concrete witness: the posterior stays exactly uniform.
    const w = priorMeanUpdate({ n: 5, ...beta11 }, [{ index: 2, failed: true }, { index: 1, failed: false }])
    for (const x of w) expect(x).toBeCloseTo(0.2, 15)
  })
})
