/**
 * Cobuild metrics, built from the five metric types of Effect
 * ({@link https://effect.website/docs/v4/observability/metrics}).
 *
 * @remarks
 * Production-readiness audit item "no logging or metrics": nothing measured
 * how often locks were contended, how slow R2 was, or how long builds took.
 * Each metric below answers one of those questions and is fed with the
 * documented pattern `effect.pipe(Effect.trackSuccesses(metric))` or
 * `Effect.trackDuration(timer)`, so instrumenting an effect never changes its
 * type or result.
 *
 * | Metric | Type | Fed by |
 * |---|---|---|
 * | `cobuild_store_requests` | frequency of `<operation>:<outcome>` | {@link withStoreMetrics} |
 * | `cobuild_store_request_duration` | timer (ms) | {@link withStoreMetrics} |
 * | `cobuild_lock_acquire_outcomes` | frequency of `obtained`/`pending`/`completed`/`failed` | `lock.ts` `acquire` |
 * | `cobuild_lock_renewals` | increment-only counter | `cobuild.ts` heartbeat |
 * | `cobuild_lock_lost` | increment-only counter | `cobuild.ts` heartbeat |
 * | `cobuild_operation_outcomes` | frequency of `CobuildResult` tags | `cobuild.ts` `runCobuild` |
 * | `cobuild_build_duration` | timer (ms) | `cobuild.ts` `runCobuild` |
 * | `cobuild_input_files_hashed` | increment-only counter | `cli/workspace.ts` input digest cache |
 *
 * Metrics live in the process-wide registry, so readers should compare two
 * {@link snapshotMetrics} results rather than assume a fresh start.
 *
 * @packageDocumentation
 */
import { Clock, Duration, Effect, Exit, Metric } from "./fx/index.js"
import { type ObjectStore, type StoreError } from "./store.js"
import { isTimeoutFailure } from "./storeTimeout.js"

/**
 * Bucket boundaries (ms) for request latencies: R2 round trips are typically tens of ms; the default limit is 2 s.
 * `Metric.boundariesFromIterable` appends the `Infinity` bucket (Effect v4 histograms use the boundaries as given).
 */
const LATENCY_BOUNDARIES_MS: ReadonlyArray<number> = Metric.boundariesFromIterable([5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000])

/** Bucket boundaries (ms) for build durations: from one second to one hour. */
const BUILD_BOUNDARIES_MS: ReadonlyArray<number> = Metric.boundariesFromIterable([1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 3_600_000])

/** Requests to the lock store, by `<operation>:<outcome>` (outcome `ok`, an error tag, or `timeout`). */
export const storeRequests = Metric.frequency("cobuild_store_requests", {
  description: "Lock-store requests by operation and outcome"
})

/** Duration of every lock-store request, successful or not. */
export const storeRequestDuration = Metric.timer("cobuild_store_request_duration", {
  boundaries: LATENCY_BOUNDARIES_MS,
  description: "Lock-store request latency in milliseconds"
})

/** Result of every lock acquisition attempt (`LockState.state`). */
export const lockAcquireOutcomes = Metric.frequency("cobuild_lock_acquire_outcomes", {
  description: "Lock acquisition attempts by resulting state"
})

/** Successful lease renewals. */
export const lockRenewals = Metric.counter("cobuild_lock_renewals", {
  description: "Successful lease renewals",
  incremental: true
}).pipe(Metric.withConstantInput(1))

/** Leases lost while building (another job took the lock over). */
export const lockLost = Metric.counter("cobuild_lock_lost", {
  description: "Leases lost while building",
  incremental: true
}).pipe(Metric.withConstantInput(1))

/** Outcome of every `runCobuild` call (`CobuildResult._tag`). */
export const operationOutcomes = Metric.frequency("cobuild_operation_outcomes", {
  description: "Cobuild operations by outcome"
})

/** Duration of builds this job ran under the lock (successful and failed; interrupted builds are not recorded). */
export const buildDuration = Metric.timer("cobuild_build_duration", {
  boundaries: BUILD_BOUNDARIES_MS,
  description: "Build duration in milliseconds"
})

/** Input files read and hashed (each distinct file once per run, thanks to the digest cache). */
export const inputFilesHashed = Metric.counter("cobuild_input_files_hashed", {
  description: "Input files read and hashed",
  incremental: true
}).pipe(Metric.withConstantInput(1))

/**
 * Records `value` in a frequency metric, with the documented
 * `trackSuccesses` pattern.
 *
 * @param metric - The frequency metric.
 * @param value - The occurrence to count.
 * @returns An effect that updates the metric.
 */
export const countOccurrence = (metric: typeof storeRequests, value: string): Effect.Effect<void> =>
  Effect.asVoid(Effect.succeed(value).pipe(Effect.trackSuccesses(metric)))

/**
 * Bumps an increment-only counter created with `withConstantInput(1)`.
 *
 * @param metric - The counter.
 * @returns An effect that adds one to it.
 */
export const bump = (metric: typeof lockRenewals): Effect.Effect<void> =>
  Effect.asVoid(Effect.succeed(1).pipe(Effect.trackSuccesses(metric)))

/** The outcome label of one store request. */
const outcomeLabel = (e: StoreError): string => (isTimeoutFailure(e) ? "timeout" : e._tag)

/**
 * Times `self` on the Effect clock and records the duration in `timer` when
 * it succeeds **or fails** (an interrupted run is not recorded).
 *
 * @remarks
 * `Effect.trackDuration` records successful runs only, which would hide
 * exactly the slow, failing requests a latency metric is for. The duration
 * is fed with the documented `trackSuccesses` pattern.
 *
 * @param timer - A timer metric.
 * @returns A function from an effect to the same effect, timed.
 */
export const trackDurationOfAnyExit =
  (timer: typeof storeRequestDuration) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(self)
      const end = yield* Clock.currentTimeMillis
      if (!Exit.hasInterrupts(exit)) {
        yield* Effect.succeed(Duration.millis(end - start)).pipe(Effect.trackSuccesses(timer))
      }
      return yield* exit
    })

/**
 * `store` with every request counted in {@link storeRequests} and timed in
 * {@link storeRequestDuration}. Results and errors pass through unchanged.
 *
 * @param store - The store to instrument (wrap it outside `withRequestTimeout` so timeouts are counted).
 * @returns The instrumented store.
 */
export const withStoreMetrics = (store: ObjectStore): ObjectStore => {
  const instrument =
    (operation: "putIfNoneMatch" | "putIfMatch" | "get") =>
    <A>(eff: Effect.Effect<A, StoreError>): Effect.Effect<A, StoreError> =>
      eff.pipe(
        Effect.tap(() => countOccurrence(storeRequests, `${operation}:ok`)),
        Effect.tapError((e) => countOccurrence(storeRequests, `${operation}:${outcomeLabel(e)}`)),
        trackDurationOfAnyExit(storeRequestDuration)
      )
  return {
    putIfNoneMatch: (key, body) => instrument("putIfNoneMatch")(store.putIfNoneMatch(key, body)),
    putIfMatch: (key, etag, body) => instrument("putIfMatch")(store.putIfMatch(key, etag, body)),
    get: (key) => instrument("get")(store.get(key))
  }
}

/** A histogram's state in plain JSON form. */
export interface HistogramSnapshot {
  readonly count: number
  readonly min: number
  readonly max: number
  readonly sum: number
  /** `[upperBoundary, cumulativeCount]` pairs; the last boundary is `"Infinity"`. */
  readonly buckets: ReadonlyArray<readonly [number | "Infinity", number]>
}

/** Every cobuild metric in plain JSON form (what `cobuild run --metrics-json` writes). */
export interface MetricsSnapshot {
  readonly storeRequests: Readonly<Record<string, number>>
  readonly storeRequestDurationMs: HistogramSnapshot
  readonly lockAcquireOutcomes: Readonly<Record<string, number>>
  readonly lockRenewals: number
  readonly lockLost: number
  readonly operationOutcomes: Readonly<Record<string, number>>
  readonly buildDurationMs: HistogramSnapshot
  readonly inputFilesHashed: number
}

const histogramOf = (s: {
  readonly count: number
  readonly min: number
  readonly max: number
  readonly sum: number
  readonly buckets: ReadonlyArray<readonly [number, number]>
}): HistogramSnapshot => ({
  count: s.count,
  min: s.count === 0 ? 0 : s.min,
  max: s.count === 0 ? 0 : s.max,
  sum: s.sum,
  buckets: s.buckets.map(([b, n]) => [Number.isFinite(b) ? b : "Infinity", n] as const)
})

const frequencyOf = (s: { readonly occurrences: ReadonlyMap<string, number> }): Record<string, number> =>
  Object.fromEntries([...s.occurrences.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/**
 * Reads every cobuild metric with `Metric.value`.
 *
 * @returns The current values, JSON-serialisable.
 */
export const snapshotMetrics: Effect.Effect<MetricsSnapshot> = Effect.gen(function* () {
  return {
    storeRequests: frequencyOf(yield* Metric.value(storeRequests)),
    storeRequestDurationMs: histogramOf(yield* Metric.value(storeRequestDuration)),
    lockAcquireOutcomes: frequencyOf(yield* Metric.value(lockAcquireOutcomes)),
    lockRenewals: (yield* Metric.value(lockRenewals)).count,
    lockLost: (yield* Metric.value(lockLost)).count,
    operationOutcomes: frequencyOf(yield* Metric.value(operationOutcomes)),
    buildDurationMs: histogramOf(yield* Metric.value(buildDuration)),
    inputFilesHashed: (yield* Metric.value(inputFilesHashed)).count
  }
})
