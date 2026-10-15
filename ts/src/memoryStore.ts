/**
 * In-memory R2 simulator with the semantics of the Lean `Bucket`
 * (`RequestProject/Cobuilds/R2.lean`):
 *
 * - each call is atomic;
 * - every accepted write gets a fresh ETag;
 * - a write less than `rateLimitMs` after the previous accepted write to the
 *   same key is rejected with `RateLimited` and changes nothing.
 *
 * Time comes from Effect's `Clock`, so tests can drive it with `TestClock`.
 */
import { Clock, Effect, Option } from "./fx/index.js"
import {
  type ObjectStore,
  PreconditionFailed,
  RateLimited,
  type StoreError,
  type StoredObject
} from "./store.js"

interface Entry {
  readonly body: string
  readonly etag: string
}

export interface MemoryStore extends ObjectStore {
  /** Accepted write times per key, in order (for checking rate-limit compliance). */
  readonly writeLog: ReadonlyMap<string, ReadonlyArray<number>>
  /** Number of requests issued per method (for checking retry behaviour). */
  readonly calls: { putIfNoneMatch: number; putIfMatch: number; get: number }
  /** Direct read, bypassing the request counter. */
  readonly peek: (key: string) => StoredObject | undefined
  /** Every stored key (for listing in tests of read-only consumers). */
  readonly keys: () => ReadonlyArray<string>
}

/**
 * `now`: optional source of R2's own time. By default the caller's Effect
 * `Clock` is used; pass `now` to give R2 a clock independent of the jobs'
 * (possibly skewed) clocks.
 */
export const makeMemoryStore = (rateLimitMs = 1000, now?: () => number): MemoryStore => {
  const objects = new Map<string, Entry>()
  const lastWrite = new Map<string, number>()
  const writeLog = new Map<string, Array<number>>()
  const calls = { putIfNoneMatch: 0, putIfMatch: 0, get: 0 }
  let nextETag = 0

  const storeNow: Effect.Effect<number> = now ? Effect.sync(now) : Clock.currentTimeMillis

  const rateOk = (key: string, now: number): boolean => {
    const t = lastWrite.get(key)
    return t === undefined || t + rateLimitMs <= now
  }

  const write = (key: string, body: string, now: number): string => {
    const etag = `"e${nextETag++}"`
    objects.set(key, { body, etag })
    lastWrite.set(key, now)
    const log = writeLog.get(key) ?? []
    log.push(now)
    writeLog.set(key, log)
    return etag
  }

  return {
    writeLog,
    calls,
    peek: (key) => objects.get(key),
    keys: () => [...objects.keys()],
    putIfNoneMatch: (key, body) =>
      Effect.flatMap(storeNow, (now) =>
        Effect.suspend((): Effect.Effect<string, StoreError> => {
          calls.putIfNoneMatch++
          if (!rateOk(key, now)) return Effect.fail(new RateLimited({ key }))
          if (objects.has(key)) return Effect.fail(new PreconditionFailed({ key }))
          return Effect.succeed(write(key, body, now))
        })
      ),
    putIfMatch: (key, etag, body) =>
      Effect.flatMap(storeNow, (now) =>
        Effect.suspend((): Effect.Effect<string, StoreError> => {
          calls.putIfMatch++
          if (!rateOk(key, now)) return Effect.fail(new RateLimited({ key }))
          const cur = objects.get(key)
          if (cur === undefined || cur.etag !== etag) {
            return Effect.fail(new PreconditionFailed({ key }))
          }
          return Effect.succeed(write(key, body, now))
        })
      ),
    get: (key) =>
      Effect.sync(() => {
        calls.get++
        return Option.fromUndefinedOr(objects.get(key))
      })
  }
}
