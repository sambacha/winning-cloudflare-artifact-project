/**
 * Bayesian bisection for flaky predicates: the probability model.
 *
 * Indexing. The candidate commits are numbered `0 … n-1` from oldest to
 * newest. They are the first-parent commits strictly after the known-good
 * commit, up to and including the known-bad commit (`n-1`). Artifacts'
 * `log()` returns commits newest first, so callers reverse it
 * (`commitRange` in `artifacts.ts` does).
 *
 * Hypotheses. `B = b` means "commit `b` is the first commit with the new
 * behaviour". Under `B = b`, commit `c` is on the *new* side iff `c ≥ b` and
 * on the *old* side iff `c < b`.
 *
 * Observations. Running the predicate at commit `c` gives `failed: true`
 * ("yes, the bug showed") or `failed: false`. Every run is an independent
 * Bernoulli draw: it fails with probability `pNew` on the new side and
 * `pOld` on the old side.
 *
 * Rates. Each of `pNew`, `pOld` is either known, or unknown with a Beta prior
 * (the Beta–Bernoulli conjugate model). For an unknown rate the marginal
 * likelihood of the observations on one side, with `f` failures and `s`
 * passes, is
 *
 *     B(α + f, β + s) / B(α, β) = α^(f) · β^(s) / (α + β)^(f + s)
 *
 * where `x^(k) = x (x + 1) … (x + k - 1)` is the rising factorial, so no
 * Gamma function is needed. The posterior over `B` is
 *
 *     P(B = b | D) ∝ prior(b) · L_new(b) · L_old(b).
 *
 * Fix relative to the proposal's sketch: the sketch multiplied the weights
 * by the *prior* means `α / (α + β)` of the two Beta distributions and never
 * updated `α`, `β`. With the default `Beta(1, 1)` for both rates that factor
 * is `0.5` on both sides, the same for every hypothesis, so the posterior
 * never moves and the search cannot converge (the planted mutant
 * `priorMeanUpdate` in the tests shows this). Here the likelihood is the
 * exact marginal above, which depends on the hypothesis through the counts
 * on each side.
 */
import { Data } from "../fx/index.js"

/** A failure rate: known exactly, or unknown with a `Beta(alpha, beta)` prior. */
export type Rate =
  | { readonly kind: "known"; readonly p: number }
  | { readonly kind: "beta"; readonly alpha: number; readonly beta: number }

export interface BisectModel {
  /** Number of candidate commits (at least 1). */
  readonly n: number
  /** Failure probability on the new side (at and after the culprit). */
  readonly newRate: Rate
  /** Failure probability on the old side (before the culprit). */
  readonly oldRate: Rate
  /**
   * Optional prior weights over the culprit (length `n`, non-negative, not
   * all zero; they are normalised). Default: uniform.
   */
  readonly prior?: ReadonlyArray<number>
}

export interface Observation {
  /** Candidate index, `0 ≤ index < n`. */
  readonly index: number
  /** Did the predicate report the bug ("yes")? */
  readonly failed: boolean
}

export class InvalidModel extends Data.TaggedError("InvalidModel")<{ readonly message: string }> {
  override readonly name = "InvalidModel"
  /** @param message - Human-readable description. */
  constructor(message: string) {
    super({ message })
  }
}

/** All observations have probability zero under every hypothesis (only possible with known rates 0 or 1). */
export class InconsistentObservations extends Data.TaggedError("InconsistentObservations")<{ readonly message: string }> {
  override readonly name = "InconsistentObservations"
  /** @param message - Human-readable description. */
  constructor(message: string) {
    super({ message })
  }
}

/** Throws `InvalidModel` unless `r` is a valid rate (`known` p ∈ [0, 1], or Beta with finite α, β > 0). */
export const checkRate = (name: string, r: Rate): void => {
  if (r.kind === "known") {
    if (!(r.p >= 0 && r.p <= 1)) throw new InvalidModel(`${name}.p must be in [0, 1], got ${r.p}`)
  } else if (!(r.alpha > 0 && r.beta > 0 && Number.isFinite(r.alpha) && Number.isFinite(r.beta))) {
    throw new InvalidModel(`${name} needs alpha > 0 and beta > 0, got Beta(${r.alpha}, ${r.beta})`)
  }
}

export const validateModel = (m: BisectModel): void => {
  if (!Number.isSafeInteger(m.n) || m.n < 1) throw new InvalidModel(`n must be a positive integer, got ${m.n}`)
  checkRate("newRate", m.newRate)
  checkRate("oldRate", m.oldRate)
  if (m.prior !== undefined) {
    if (m.prior.length !== m.n) throw new InvalidModel(`prior has length ${m.prior.length}, expected ${m.n}`)
    if (m.prior.some((w) => !(w >= 0) || !Number.isFinite(w))) throw new InvalidModel("prior weights must be finite and >= 0")
    if (!m.prior.some((w) => w > 0)) throw new InvalidModel("prior weights must not all be zero")
  }
}

export const validateObservation = (m: BisectModel, o: Observation): void => {
  if (!Number.isSafeInteger(o.index) || o.index < 0 || o.index >= m.n) {
    throw new InvalidModel(`observation index ${o.index} outside [0, ${m.n})`)
  }
}

/** Prefix sums of per-commit failure / pass counts. */
export interface Counts {
  /** `failBefore[b]` = failures at commits `< b` (length `n + 1`). */
  readonly failBefore: ReadonlyArray<number>
  /** `passBefore[b]` = passes at commits `< b` (length `n + 1`). */
  readonly passBefore: ReadonlyArray<number>
  readonly totalFail: number
  readonly totalPass: number
}

export const countObservations = (m: BisectModel, obs: ReadonlyArray<Observation>): Counts => {
  const fail = new Array<number>(m.n).fill(0)
  const pass = new Array<number>(m.n).fill(0)
  for (const o of obs) {
    validateObservation(m, o)
    if (o.failed) fail[o.index]!++
    else pass[o.index]!++
  }
  const failBefore = [0]
  const passBefore = [0]
  for (let c = 0; c < m.n; c++) {
    failBefore.push(failBefore[c]! + fail[c]!)
    passBefore.push(passBefore[c]! + pass[c]!)
  }
  return { failBefore, passBefore, totalFail: failBefore[m.n]!, totalPass: passBefore[m.n]! }
}

/** `log(x (x+1) … (x+k-1))`, with `logRising(x, 0) = 0`. */
export const logRising = (x: number, k: number): number => {
  let s = 0
  for (let j = 0; j < k; j++) s += Math.log(x + j)
  return s
}

/** `log p^f (1-p)^s` with the convention `0 · log 0 = 0`. */
const logKnown = (p: number, f: number, s: number): number =>
  (f === 0 ? 0 : f * Math.log(p)) + (s === 0 ? 0 : s * Math.log1p(-p))

/** Log marginal likelihood of `f` failures and `s` passes on one side. */
export const logMarginal = (r: Rate, f: number, s: number): number =>
  r.kind === "known"
    ? logKnown(r.p, f, s)
    : logRising(r.alpha, f) + logRising(r.beta, s) - logRising(r.alpha + r.beta, f + s)

/** Posterior predictive probability that the next run on one side fails, given `f` failures and `s` passes there. */
export const predictiveFail = (r: Rate, f: number, s: number): number =>
  r.kind === "known" ? r.p : (r.alpha + f) / (r.alpha + r.beta + f + s)

/** Failures / passes on each side under hypothesis `b`. */
export const sideCounts = (c: Counts, b: number) => ({
  oldFail: c.failBefore[b]!,
  oldPass: c.passBefore[b]!,
  newFail: c.totalFail - c.failBefore[b]!,
  newPass: c.totalPass - c.passBefore[b]!
})

const priorWeight = (m: BisectModel, b: number): number => (m.prior === undefined ? 1 : m.prior[b]!)

/** Unnormalised log posterior `log prior(b) + log L_new(b) + log L_old(b)` for every `b`. */
export const logPosteriorUnnormalised = (m: BisectModel, obs: ReadonlyArray<Observation>): Float64Array => {
  validateModel(m)
  const c = countObservations(m, obs)
  const out = new Float64Array(m.n)
  for (let b = 0; b < m.n; b++) {
    const k = sideCounts(c, b)
    out[b] =
      Math.log(priorWeight(m, b)) +
      logMarginal(m.newRate, k.newFail, k.newPass) +
      logMarginal(m.oldRate, k.oldFail, k.oldPass)
  }
  return out
}

/** Normalise log weights with log-sum-exp. Throws if every weight is zero. */
export const normaliseLog = (logw: Float64Array): Float64Array => {
  let max = -Infinity
  for (const v of logw) if (v > max) max = v
  if (max === -Infinity) throw new InconsistentObservations("every hypothesis has probability zero")
  const out = new Float64Array(logw.length)
  let sum = 0
  for (let i = 0; i < logw.length; i++) {
    const e = Math.exp(logw[i]! - max)
    out[i] = e
    sum += e
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sum
  return out
}

/** `P(B = b | observations)` for every `b`. Sums to 1. */
export const posterior = (m: BisectModel, obs: ReadonlyArray<Observation>): Float64Array =>
  normaliseLog(logPosteriorUnnormalised(m, obs))

/**
 * `q[b]` = probability that the next run at commit `index` fails, given the
 * observations and `B = b` (the posterior predictive of the relevant side).
 */
export const conditionalFailProbabilities = (
  m: BisectModel,
  obs: ReadonlyArray<Observation>,
  index: number
): Float64Array => {
  validateObservation(m, { index, failed: false })
  const c = countObservations(m, obs)
  const q = new Float64Array(m.n)
  for (let b = 0; b < m.n; b++) {
    const k = sideCounts(c, b)
    q[b] =
      index >= b
        ? predictiveFail(m.newRate, k.newFail, k.newPass)
        : predictiveFail(m.oldRate, k.oldFail, k.oldPass)
  }
  return q
}

/** Shannon entropy in nats, with `0 log 0 = 0`. */
export const entropy = (w: ArrayLike<number>): number => {
  let h = 0
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!
    if (x > 0) h -= x * Math.log(x)
  }
  return h
}
