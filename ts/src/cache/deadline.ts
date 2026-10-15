/**
 * Restore deadline (decision D-11) and its cost model.
 *
 * Model (Lean: `BlacksmithReview/Timeout.lean`, `costTimeout`): a restore that
 * would take `d` ms is abandoned at the deadline `T` and the job rebuilds in
 * `R` ms. The job's cost is `d` if `d ≤ T`, else `T + R`; the hindsight
 * optimum is `min(d, R)`.
 *
 * - `T = R` costs at most `2 · min(d, R)` (`deadline_R_two_competitive`), and
 *   no deterministic `T` does better than `2 − 1/R` (`deterministic_lower_bound`).
 * - With an *estimate* `T ≠ R` the guarantee degrades to
 *   `1 + max(R/T, T/R)` (`PathReview/Deadline.lean`, `deadline_ratio_le_under`,
 *   `deadline_ratio_le_over`), and that bound is attained
 *   (`deadline_under_tight`, `deadline_over_tight`). Under- *and*
 *   over-estimating both hurt.
 * - A cap `T = min(buildMs, cap)` with `cap < R` is an under-estimate: it bounds
 *   the absolute wait (a latency budget) at the price of ratio `1 + R/cap`.
 *   It does **not** protect against "stale, too short" estimates, as the
 *   analysis under review claimed: a cap can only shorten the deadline.
 *
 * The manifest (which carries `buildMs`) must be fetched before this deadline
 * can be computed, so lookups get their own short deadline (`lookup`).
 *
 * Units: the policy ({@link DeadlinePolicy}) is configuration and is typed
 * `Duration`; estimates and the cost model stay in milliseconds, because they
 * are measurements (`buildMs` in the manifest) and mirror the Lean `Nat`
 * millisecond model.
 */
import { Duration } from "../fx/index.js"

/** The cost model, exactly as in Lean's `costTimeout T d R`. */
export const costTimeout = (T: number, d: number, R: number): number => (d <= T ? d : T + R)

/** The hindsight optimum. */
export const optimalCost = (d: number, R: number): number => Math.min(d, R)

/** Worst-case ratio `cost / optimum` over all restore times, for deadline `T` and rebuild time `R`. */
export const competitiveRatio = (T: number, R: number): number => {
  if (T <= 0 || R <= 0) return T === R ? 1 : Number.POSITIVE_INFINITY
  return 1 + Math.max(R / T, T / R)
}

export interface DeadlinePolicy {
  /** Lower bound, so that tiny `buildMs` values still allow a lookup round trip. */
  readonly floor: Duration.Duration
  /** Optional latency budget. Lowers the deadline; see the module comment for its price. */
  readonly cap?: Duration.Duration
  /** Deadline for fetching the manifest (from measured lookup p99). */
  readonly lookup: Duration.Duration
}

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = { floor: Duration.millis(250), lookup: Duration.seconds(2) }

/**
 * `T = clamp(estimateMs, floor, cap)`, in milliseconds.
 *
 * @param estimateMs - Rebuild-time estimate on this runner class (a measurement, ms);
 * non-finite or non-positive values count as 0.
 * @param policy - Floor and optional cap.
 * @returns The restore deadline in milliseconds.
 */
export const restoreDeadlineMs = (estimateMs: number, policy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY): number => {
  const est = Number.isFinite(estimateMs) && estimateMs > 0 ? estimateMs : 0
  const capped = policy.cap === undefined ? est : Math.min(est, Duration.toMillis(policy.cap))
  return Math.max(Duration.toMillis(policy.floor), capped)
}

/**
 * {@link restoreDeadlineMs} as a `Duration`, for `Effect.timeout`.
 *
 * @param estimateMs - As for {@link restoreDeadlineMs}.
 * @param policy - As for {@link restoreDeadlineMs}.
 * @returns The restore deadline.
 */
export const restoreDeadline = (estimateMs: number, policy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY): Duration.Duration =>
  Duration.millis(restoreDeadlineMs(estimateMs, policy))
