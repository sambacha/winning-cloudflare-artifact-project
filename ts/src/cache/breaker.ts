/**
 * Circuit breaker with cool-down and half-open probe (decision D-12).
 *
 * This is Lean's `probeStep N C` (`BlacksmithReview/Timeout.lean`) as a pure
 * transition function, so the TypeScript and the proved model can be compared
 * observation by observation (`test/cache/breaker.test.ts`):
 *
 * - `closed(n)`: `n` consecutive bad observations; the `N`-th opens it;
 * - `open(c)`: the cache is skipped; each skipped request counts the
 *   cool-down down; at 0 the next request is a probe;
 * - `halfOpen`: the next request goes to the cache; good → closed, bad → open.
 *
 * A breaker without the probe never closes again (`noProbe_open_absorbing`);
 * this one closes after `c + 2` requests once the cache is healthy
 * (`probe_recovers`).
 *
 * The breaker is not "strictly better" than deadlines alone, as the analysis
 * under review claimed: after a short outage it keeps skipping a healthy
 * cache for the cool-down, and each skipped hit costs a rebuild. It wins when
 * outages last longer than the cool-down (see the test "a short outage …").
 */

export type BreakerState =
  | { readonly tag: "closed"; readonly bad: number }
  | { readonly tag: "open"; readonly cool: number }
  | { readonly tag: "halfOpen" }

export interface BreakerConfig {
  /** Consecutive bad observations that open the breaker (`N`). */
  readonly threshold: number
  /** Requests skipped before probing (`C`). */
  readonly coolDown: number
}

export const initialBreaker: BreakerState = { tag: "closed", bad: 0 }

/** Should this request use the cache? (`false` = skip it and rebuild.) */
export const allowsRequest = (s: BreakerState): boolean => s.tag !== "open"

/**
 * One observation. For `open` the value of `bad` is ignored: the request
 * skipped the cache and only counts the cool-down down.
 */
export const breakerStep = (cfg: BreakerConfig, s: BreakerState, bad: boolean): BreakerState => {
  switch (s.tag) {
    case "closed":
      if (!bad) return { tag: "closed", bad: 0 }
      return cfg.threshold <= s.bad + 1 ? { tag: "open", cool: cfg.coolDown } : { tag: "closed", bad: s.bad + 1 }
    case "open":
      return s.cool > 0 ? { tag: "open", cool: s.cool - 1 } : { tag: "halfOpen" }
    case "halfOpen":
      return bad ? { tag: "open", cool: cfg.coolDown } : { tag: "closed", bad: 0 }
  }
}

export const runBreaker = (cfg: BreakerConfig, s: BreakerState, obs: ReadonlyArray<boolean>): BreakerState =>
  obs.reduce((st, o) => breakerStep(cfg, st, o), s)
