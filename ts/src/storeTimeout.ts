/**
 * Per-request time limits for an `ObjectStore` (audit item B-3).
 *
 * The lock's configuration predicate (`checkCobuildConfig`) assumes that
 * every request finishes within `maxLatencyMs` (the resolved `maxLatency`):
 *
 *     renewIntervalMs + maxLatencyMs + maxSkewMs < leaseMs
 *
 * Without a limit that assumption is just hoped for: a hung renewal stalls
 * the heartbeat while the build keeps running past its lease. This decorator
 * makes the assumption true by construction: each call is interrupted after
 * `timeout` (Effect `timeoutOrElse`), and interruption aborts the underlying
 * request (`Effect.tryPromise` hands the SDK an `AbortSignal`, see
 * `r2Store.ts`).
 *
 * A timed-out call fails with `StoreFailure` whose cause is a
 * `RequestTimeout`. That is the right classification: R2 may or may not have
 * applied a write whose response never arrived, and `StoreFailure` is exactly
 * the error that `lock.ts` (`casWrite`, `createWrite`) reconciles by reading
 * back the per-version nonce. Successful and failing calls that finish in
 * time are passed through unchanged.
 */
import { Data, Duration, Effect } from "./fx/index.js"
import { type ObjectStore, StoreFailure } from "./store.js"

/** The cause recorded in `StoreFailure` when a request exceeded its limit. */
export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly operation: "putIfNoneMatch" | "putIfMatch" | "get"
  readonly key: string
  readonly timeout: Duration.Duration
}> {}

/** Is `e` a `StoreFailure` caused by a request timeout? */
export const isTimeoutFailure = (e: unknown): e is StoreFailure & { readonly cause: RequestTimeout } =>
  e instanceof StoreFailure && e.cause instanceof RequestTimeout

/**
 * Validated time limit: a positive, finite whole number of milliseconds.
 *
 * @param timeout - The limit.
 * @returns The same limit.
 * @throws `RangeError` for zero, infinite or sub-millisecond-fractional limits.
 */
export const checkTimeout = (timeout: Duration.Duration): Duration.Duration => {
  const ms = Duration.toMillis(timeout)
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new RangeError(`request timeout must be a positive whole number of ms, got ${Duration.format(timeout)}`)
  }
  return timeout
}

/**
 * `store` with every request limited to `timeout` (Effect clock).
 *
 * @param store - The store to decorate.
 * @param timeout - Per-request limit (see {@link checkTimeout}).
 * @returns The decorated store.
 */
export const withRequestTimeout = (store: ObjectStore, timeout: Duration.Duration): ObjectStore => {
  const limitDuration = checkTimeout(timeout)
  const limit =
    (operation: RequestTimeout["operation"], key: string) =>
    <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, E | StoreFailure> =>
      Effect.timeoutOrElse(eff, {
        duration: limitDuration,
        orElse: () => Effect.fail(new StoreFailure({ key, cause: new RequestTimeout({ operation, key, timeout: limitDuration }) }))
      })
  return {
    putIfNoneMatch: (key, body) => limit("putIfNoneMatch", key)(store.putIfNoneMatch(key, body)),
    putIfMatch: (key, etag, body) => limit("putIfMatch", key)(store.putIfMatch(key, etag, body)),
    get: (key) => limit("get", key)(store.get(key))
  }
}
