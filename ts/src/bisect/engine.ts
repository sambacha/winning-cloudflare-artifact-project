/**
 * Bayesian bisection: choosing the next commit and running a search.
 *
 * Selection rule: test the commit `c` that minimises the expected entropy of
 * the posterior after observing the result at `c`,
 *
 *     E(c) = Σ_{o ∈ {fail, pass}} P(o at c) · H(P(B | D, o at c)).
 *
 * With `u_b = w_b · P(o at c | B = b, D)` and `Z = Σ_b u_b = P(o at c)`,
 * each term is `Z · H(u / Z) = Z log Z − Σ_b u_b log u_b`. Under `B = b` the
 * predictive probability at `c` depends on `c` only through the side
 * (`c ≥ b`: new, `c < b`: old), so both sums split into a prefix over
 * `b ≤ c` and a suffix over `b > c`, and all `n` values of `E` take O(n)
 * time (the proposal's sketch recomputed every posterior, O(n²)). The test
 * suite checks this against the direct O(n²) computation.
 *
 * `H(w) − E(c)` is the expected information gain of testing `c`; it is
 * never negative (Lean: `Bisect.expected_entropy_le`).
 */
import {
  type BisectModel,
  countObservations,
  entropy,
  type Observation,
  posterior,
  predictiveFail,
  sideCounts,
  validateModel
} from "./model.js"
import { Effect } from "../fx/index.js"
import { validate } from "./artifactsApi.js"

const xlogx = (x: number): number => (x > 0 ? x * Math.log(x) : 0)

/** Predictive failure probabilities of each side, per hypothesis. */
export const sidePredictives = (
  m: BisectModel,
  obs: ReadonlyArray<Observation>
): { readonly pNew: Float64Array; readonly pOld: Float64Array } => {
  const c = countObservations(m, obs)
  const pNew = new Float64Array(m.n)
  const pOld = new Float64Array(m.n)
  for (let b = 0; b < m.n; b++) {
    const k = sideCounts(c, b)
    pNew[b] = predictiveFail(m.newRate, k.newFail, k.newPass)
    pOld[b] = predictiveFail(m.oldRate, k.oldFail, k.oldPass)
  }
  return { pNew, pOld }
}

/** Prefix sums of `f(b)` (length `n + 1`). */
const prefix = (n: number, f: (b: number) => number): Float64Array => {
  const out = new Float64Array(n + 1)
  for (let b = 0; b < n; b++) out[b + 1] = out[b]! + f(b)
  return out
}

/** `E(c)` for every candidate `c`, in nats. O(n + #observations). */
export const expectedEntropies = (m: BisectModel, obs: ReadonlyArray<Observation>): Float64Array => {
  validateModel(m)
  const n = m.n
  const w = posterior(m, obs)
  const { pNew, pOld } = sidePredictives(m, obs)
  const out = new Float64Array(n)
  // One outcome at a time: `aNew[b]`, `aOld[b]` = P(outcome | B = b, side).
  const addOutcome = (aNew: (b: number) => number, aOld: (b: number) => number) => {
    const zNew = prefix(n, (b) => w[b]! * aNew(b))
    const zOld = prefix(n, (b) => w[b]! * aOld(b))
    const sNew = prefix(n, (b) => xlogx(w[b]! * aNew(b)))
    const sOld = prefix(n, (b) => xlogx(w[b]! * aOld(b)))
    for (let c = 0; c < n; c++) {
      // Hypotheses b ≤ c put commit c on the new side; b > c on the old side.
      const z = zNew[c + 1]! + (zOld[n]! - zOld[c + 1]!)
      const s = sNew[c + 1]! + (sOld[n]! - sOld[c + 1]!)
      out[c] = out[c]! + (z > 0 ? xlogx(z) - s : 0)
    }
  }
  addOutcome((b) => pNew[b]!, (b) => pOld[b]!)
  addOutcome((b) => 1 - pNew[b]!, (b) => 1 - pOld[b]!)
  return out
}

/** Probability that the next run at `c` fails, for every `c`: `Σ_b w_b q_b(c)`. */
export const failProbabilities = (m: BisectModel, obs: ReadonlyArray<Observation>): Float64Array => {
  const w = posterior(m, obs)
  const { pNew, pOld } = sidePredictives(m, obs)
  const zNew = prefix(m.n, (b) => w[b]! * pNew[b]!)
  const zOld = prefix(m.n, (b) => w[b]! * pOld[b]!)
  const out = new Float64Array(m.n)
  for (let c = 0; c < m.n; c++) out[c] = zNew[c + 1]! + (zOld[m.n]! - zOld[c + 1]!)
  return out
}

/** Relative tolerance for treating two expected entropies as equal (ties go to the lowest index). */
export const TIE_TOLERANCE = 1e-12

/**
 * The commit with minimal expected posterior entropy (lowest index among
 * ties), ignoring the indices in `exclude` (commits that could not be tested,
 * `git bisect skip`). Returns `-1` if every commit is excluded.
 *
 * Commits with zero one-step information gain are *not* excluded: with
 * unknown rates on both sides and no data yet, every first test has zero
 * one-step gain (both sides predict the same failure probability), yet the
 * search must start somewhere.
 */
export const selectNext = (
  m: BisectModel,
  obs: ReadonlyArray<Observation>,
  exclude: ReadonlySet<number> = new Set()
): number => {
  const e = expectedEntropies(m, obs)
  let min = Infinity
  for (let c = 0; c < e.length; c++) if (!exclude.has(c) && e[c]! < min) min = e[c]!
  if (min === Infinity) return -1
  const tol = TIE_TOLERANCE * Math.max(1, Math.abs(min))
  return e.findIndex((v, c) => !exclude.has(c) && v <= min + tol)
}

export interface RateSummary {
  /** Posterior mean of the failure rate on this side. */
  readonly mean: number
}

export interface Summary {
  readonly posterior: Float64Array
  /** Maximum a posteriori culprit (lowest index among ties). */
  readonly map: number
  /** `P(B = map | D)`. */
  readonly confidence: number
  /** Posterior entropy in nats. */
  readonly entropy: number
  readonly newRate: RateSummary
  readonly oldRate: RateSummary
}

export const summarize = (m: BisectModel, obs: ReadonlyArray<Observation>): Summary => {
  const w = posterior(m, obs)
  const { pNew, pOld } = sidePredictives(m, obs)
  let map = 0
  for (let b = 1; b < m.n; b++) if (w[b]! > w[map]!) map = b
  let meanNew = 0
  let meanOld = 0
  for (let b = 0; b < m.n; b++) {
    meanNew += w[b]! * pNew[b]!
    meanOld += w[b]! * pOld[b]!
  }
  return {
    posterior: w,
    map,
    confidence: w[map]!,
    entropy: entropy(w),
    newRate: { mean: meanNew },
    oldRate: { mean: meanOld }
  }
}

export interface BisectOptions {
  /** Stop when the MAP culprit has at least this posterior probability, `0 < confidence ≤ 1`. */
  readonly confidence: number
  /** Stop after this many predicate runs. */
  readonly maxSteps: number
}

export interface BisectStep {
  readonly index: number
  readonly failed: boolean
  /** Summary after this observation. */
  readonly map: number
  readonly confidence: number
  readonly entropy: number
}

/** Why a search stopped. */
export type StopReason = "confidence" | "maxSteps" | "noTestableCommit"

export interface BisectResult {
  readonly culprit: number
  readonly confidence: number
  /** `true` iff the confidence threshold was reached (not just `maxSteps`). */
  readonly converged: boolean
  readonly stopReason: StopReason
  readonly steps: ReadonlyArray<BisectStep>
  readonly observations: ReadonlyArray<Observation>
}

export type NextAction =
  | { readonly done: false; readonly index: number }
  | { readonly done: true; readonly result: BisectResult }

const checkOptions = (o: BisectOptions): void => {
  if (!(o.confidence > 0 && o.confidence <= 1)) throw new RangeError(`confidence must be in (0, 1], got ${o.confidence}`)
  if (!Number.isSafeInteger(o.maxSteps) || o.maxSteps < 0) throw new RangeError(`maxSteps must be a non-negative integer, got ${o.maxSteps}`)
}

/**
 * The pure decision function behind both runners: given the observations so
 * far, either name the next commit to test or stop with a result.
 */
export const nextAction = (
  m: BisectModel,
  steps: ReadonlyArray<BisectStep>,
  opts: BisectOptions,
  exclude: ReadonlySet<number> = new Set()
): NextAction => {
  checkOptions(opts)
  const obs = steps.map(({ index, failed }) => ({ index, failed }))
  const s = summarize(m, obs)
  const converged = s.confidence >= opts.confidence
  const stop = (stopReason: StopReason): NextAction => ({
    done: true,
    result: { culprit: s.map, confidence: s.confidence, converged, stopReason, steps, observations: obs }
  })
  if (converged) return stop("confidence")
  if (steps.length >= opts.maxSteps) return stop("maxSteps")
  const index = selectNext(m, obs, exclude)
  return index < 0 ? stop("noTestableCommit") : { done: false, index }
}

const recordStep = (m: BisectModel, steps: ReadonlyArray<BisectStep>, index: number, failed: boolean): BisectStep => {
  const obs = [...steps.map(({ index, failed }) => ({ index, failed })), { index, failed }]
  const s = summarize(m, obs)
  return { index, failed, map: s.map, confidence: s.confidence, entropy: s.entropy }
}

/** Run a search with a synchronous predicate (`true` = the bug showed). */
export const bisectSync = (
  m: BisectModel,
  predicate: (index: number) => boolean,
  opts: BisectOptions
): BisectResult => {
  const steps: Array<BisectStep> = []
  for (;;) {
    const a = nextAction(m, steps, opts)
    if (a.done) return a.result
    steps.push(recordStep(m, steps, a.index, predicate(a.index)))
  }
}

/**
 * Result of one predicate run: `true` = the bug showed, `false` = it did not,
 * `"skip"` = the commit cannot be tested (it does not build, say). A skipped
 * commit is never proposed again and does not count as an observation.
 */
export type RunOutcome = boolean | "skip"

/**
 * Run a search whose predicate is an effect (e.g. a CI job per commit).
 *
 * @remarks
 * The loop is `Effect.gen`: each round asks the pure {@link nextAction} for
 * the next index and runs `predicate` on it. A failure of `predicate` ends
 * the search with that failure; interrupting the search interrupts the
 * running predicate.
 *
 * @param m - The model.
 * @param predicate - Runs the test at an index.
 * @param opts - Stopping rule.
 * @returns The search result; fails with `RangeError` for invalid options or
 * model, or with the predicate's failure `E`.
 */
export const bisectEffect = <E, R>(
  m: BisectModel,
  predicate: (index: number) => Effect.Effect<RunOutcome, E, R>,
  opts: BisectOptions
): Effect.Effect<BisectResult, E | RangeError, R> =>
  Effect.gen(function* () {
    const steps: Array<BisectStep> = []
    const skipped = new Set<number>()
    for (;;) {
      const a = yield* validate<NextAction, RangeError>(() => nextAction(m, steps, opts, skipped))
      if (a.done) return a.result
      const outcome = yield* predicate(a.index)
      if (outcome === "skip") skipped.add(a.index)
      else steps.push(recordStep(m, steps, a.index, outcome))
    }
  })

/**
 * Classic `git bisect` on the same indexing: commit `n-1` is known bad, the
 * commit before `0` is known good; returns the first index reported bad by
 * binary search. Each commit is tested at most once and every answer is
 * trusted, so one false "pass" sends the search to the wrong half.
 */
export const standardBisect = (n: number, predicate: (index: number) => boolean): { culprit: number; steps: number } => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`)
  let lo = 0
  let hi = n - 1
  let steps = 0
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    steps++
    if (predicate(mid)) hi = mid
    else lo = mid + 1
  }
  return { culprit: lo, steps }
}
