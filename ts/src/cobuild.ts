/**
 * Running one operation under the cobuild lock:
 *
 *   acquire -> (heartbeat || build) -> stop heartbeat -> upload -> publish
 *
 * Fixes relative to the reviewed usage example and heartbeat:
 * - the heartbeat stores the ETag of every renewal in a `Ref`, and each
 *   renewal plus its `Ref.set` is uninterruptible, so stopping the heartbeat
 *   never loses the latest ETag (items 2, 3);
 * - the heartbeat is stopped before publishing, and the publish uses the
 *   latest lock from the `Ref`, not the one from the acquisition (item 3);
 * - the first renewal happens one interval after the acquisition, not
 *   immediately (which would be `429`, `fast_publish_rate_limited`);
 *   `429` and transient errors are retried after the rate-limit period while
 *   the lease is still valid (`rate_limit_clears`) instead of killing the
 *   heartbeat; when the lock is lost the build is interrupted (item 7);
 * - build failures are Effect failures, observed with `Effect.exit`, not
 *   `try/catch`, so the failure marker is actually published (item 8);
 * - nothing is released after publishing; publishing ends the lease
 *   (item 1, `delete_after_success_rebuilds`);
 * - success is published only after the upload succeeded (`cache_coherence`,
 *   `publish_before_upload_incoherent`).
 */
import { Clock, Deferred, Effect, Exit, Ref, type Cause } from "./fx/index.js"
import { type CobuildLock, type HeldLock, LockLost } from "./lock.js"
import { buildDuration, bump, countOccurrence, lockLost, lockRenewals, operationOutcomes, trackDurationOfAnyExit } from "./metrics.js"
import type { StoreFailure } from "./store.js"
import type { CacheKey } from "./ids.js"

export type CobuildResult<A, E> =
  /** We built it, uploaded the output and published `succeeded`. */
  | { readonly _tag: "Built"; readonly value: A; readonly buildCacheKey: string }
  /** We built it, it failed, and we published a failure marker. */
  | { readonly _tag: "BuildFailed"; readonly cause: Cause.Cause<E> }
  /** Another job already succeeded: restore from the build cache. */
  | { readonly _tag: "CompletedElsewhere"; readonly buildCacheKey: string }
  /** Another job failed recently (failure marker within its shelf life). */
  | { readonly _tag: "FailedElsewhere"; readonly failedAt: number; readonly logKey: string | null }
  /** Another job holds a live lease: try again later. */
  | { readonly _tag: "Pending"; readonly owner: string | null; readonly expiresAt: number | null }
  /** We lost the lease while building; nothing was published by us. */
  | { readonly _tag: "LockLost" }

export interface CobuildTask<A, E, EU, R> {
  readonly cacheKey: CacheKey
  readonly build: Effect.Effect<A, E, R>
  /** Upload the build output to the build cache. Returns the build cache key. */
  readonly upload: (value: A) => Effect.Effect<string, EU, R>
  /** Optionally upload the failure log. Returns its key. */
  readonly uploadFailureLog?: (cause: Cause.Cause<E>) => Effect.Effect<string | null, never, R>
}

/** Renew every `renewIntervalMs`, keeping `ref` up to date; complete `lost` if the lease is lost. */
const heartbeat = (
  lock: CobuildLock,
  ref: Ref.Ref<HeldLock>,
  lost: Deferred.Deferred<void>
): Effect.Effect<never> => {
  const { renewIntervalMs, rateLimitMs } = lock.config
  const attempt = Effect.uninterruptible(
    Ref.get(ref).pipe(
      Effect.flatMap(lock.renewOnce),
      Effect.tap((next) => Ref.set(ref, next)),
      Effect.tap(() => bump(lockRenewals))
    )
  )
  const renewWithRetry: Effect.Effect<void, LockLost> = attempt.pipe(
    Effect.asVoid,
    Effect.catchTags({
      RateLimited: () => retryLater,
      StoreFailure: () => retryLater
    })
  )
  // Retry after one rate-limit period while our lease would still be valid then.
  const retryLater: Effect.Effect<void, LockLost> = Effect.gen(function* () {
    const held = yield* Ref.get(ref)
    const now = yield* Clock.currentTimeMillis
    if (now + rateLimitMs > held.manifest.expiresAt) {
      return yield* Effect.fail(new LockLost({ cacheKey: held.cacheKey }))
    }
    yield* Effect.sleep(rateLimitMs)
    yield* renewWithRetry
  })
  return Effect.sleep(renewIntervalMs).pipe(
    Effect.andThen(renewWithRetry),
    Effect.forever,
    Effect.catch(() => Effect.andThen(bump(lockLost), Deferred.succeed(lost, undefined))),
    Effect.andThen(Effect.never)
  )
}

export const runCobuild = <A, E, EU, R>(
  lock: CobuildLock,
  task: CobuildTask<A, E, EU, R>
): Effect.Effect<CobuildResult<A, E>, StoreFailure | EU, R> =>
  runCobuildOnce(lock, task).pipe(Effect.tap((r) => countOccurrence(operationOutcomes, r._tag)))

const runCobuildOnce = <A, E, EU, R>(
  lock: CobuildLock,
  task: CobuildTask<A, E, EU, R>
): Effect.Effect<CobuildResult<A, E>, StoreFailure | EU, R> =>
  Effect.gen(function* () {
    const state = yield* lock.acquire(task.cacheKey)
    switch (state.state) {
      case "completed":
        return { _tag: "CompletedElsewhere", buildCacheKey: state.buildCacheKey } as const
      case "failed":
        return { _tag: "FailedElsewhere", failedAt: state.failedAt, logKey: state.logKey } as const
      case "pending":
        return { _tag: "Pending", owner: state.owner, expiresAt: state.expiresAt } as const
      case "obtained":
        break
    }

    const ref = yield* Ref.make(state.lock)
    const lost = yield* Deferred.make<void>()

    // Build while the heartbeat runs. The heartbeat is forked into a local
    // scope (`Effect.forkScoped`) that closes when the race below ends:
    // closing the scope interrupts the heartbeat and waits until any
    // in-flight renewal (and its `Ref.set`, which is uninterruptible) has
    // finished, so `ref` holds the latest ETag afterwards.
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(Effect.interruptible(heartbeat(lock, ref, lost)))
        return yield* Effect.raceFirst(
          Effect.map(Effect.exit(task.build.pipe(trackDurationOfAnyExit(buildDuration))), (exit) => ({
            _tag: "Done" as const,
            exit
          })),
          Effect.as(Deferred.await(lost), { _tag: "Lost" as const })
        )
      })
    ).pipe(
      // If we are interrupted while building, give the lock up for others.
      Effect.onInterrupt(() => Ref.get(ref).pipe(Effect.flatMap(lock.abandon), Effect.ignore))
    )

    if (outcome._tag === "Lost") return { _tag: "LockLost" } as const

    const latest = yield* Ref.get(ref)
    const publish = (o: Parameters<CobuildLock["markCompleted"]>[1]) =>
      lock.markCompleted(latest, o).pipe(Effect.catchTag("LockLost", () => Effect.succeed("lost" as const)))

    if (Exit.isSuccess(outcome.exit)) {
      const value = outcome.exit.value
      const uploaded = yield* Effect.result(task.upload(value))
      if (uploaded._tag === "Failure") {
        // Never publish success without the cache entry; let someone else retry.
        yield* lock.abandon(latest).pipe(Effect.ignore)
        return yield* Effect.fail(uploaded.failure)
      }
      const r = yield* publish({ status: "succeeded", buildCacheKey: uploaded.success })
      if (r === "lost") return { _tag: "LockLost" } as const
      return { _tag: "Built", value, buildCacheKey: uploaded.success } as const
    }

    const cause = outcome.exit.cause
    const logKey = task.uploadFailureLog ? yield* task.uploadFailureLog(cause) : null
    const r = yield* publish({ status: "failed", logKey })
    if (r === "lost") return { _tag: "LockLost" } as const
    return { _tag: "BuildFailed", cause } as const
  })
