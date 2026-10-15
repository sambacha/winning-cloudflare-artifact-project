/**
 * Planted mutants of the in-memory R2 (rule E1 of `docs/testing-guidelines.md`).
 *
 * `makeMutantStore(mutation)` behaves exactly like `makeMemoryStore` except for
 * the one planted fault. `mutation = "none"` is the control: it must pass every
 * property the real store passes.
 *
 * | Mutation          | Fault                                              | Expected |
 * |-------------------|----------------------------------------------------|----------|
 * | `ignoreIfNoneMatch` | `PutObject(If-None-Match: *)` overwrites existing objects | detected (`unconditional_put_breaks_mutex`) |
 * | `ignoreIfMatch`   | `PutObject(If-Match)` ignores the ETag              | detected (`stale_cas_rejected` fails) |
 * | `noRateLimit`     | the 1 write/key/s limit is not enforced             | detected (`rate_limit_compliance`) |
 * | `staleReads`      | `GetObject` returns the previous version of a key   | **neutral**: reads only steer which conditional write is tried, and every write is fenced by an ETag (`stale_cas_rejected`; "the protocol does not rely on reads being fresh" in `StaleReplica.lean`) |
 */
import { Clock, Effect, Option } from "../src/fx/index.js"
import {
  type MemoryStore,
  PreconditionFailed,
  RateLimited,
  type StoreError,
  type StoredObject
} from "../src/index.js"

export type Mutation = "none" | "ignoreIfNoneMatch" | "ignoreIfMatch" | "noRateLimit" | "staleReads"

export const makeMutantStore = (mutation: Mutation, rateLimitMs = 1000, now?: () => number): MemoryStore => {
  const objects = new Map<string, StoredObject>()
  const previous = new Map<string, StoredObject | undefined>()
  const lastWrite = new Map<string, number>()
  const writeLog = new Map<string, Array<number>>()
  const calls = { putIfNoneMatch: 0, putIfMatch: 0, get: 0 }
  let nextETag = 0
  const storeNow: Effect.Effect<number> = now ? Effect.sync(now) : Clock.currentTimeMillis

  const rateOk = (key: string, t: number): boolean => {
    if (mutation === "noRateLimit") return true
    const last = lastWrite.get(key)
    return last === undefined || last + rateLimitMs <= t
  }

  const write = (key: string, body: string, t: number): string => {
    const etag = `"e${nextETag++}"`
    previous.set(key, objects.get(key))
    objects.set(key, { body, etag })
    lastWrite.set(key, t)
    const log = writeLog.get(key) ?? []
    log.push(t)
    writeLog.set(key, log)
    return etag
  }

  return {
    writeLog,
    calls,
    peek: (key) => objects.get(key),
    keys: () => [...objects.keys()],
    putIfNoneMatch: (key, body) =>
      Effect.flatMap(storeNow, (t) =>
        Effect.suspend((): Effect.Effect<string, StoreError> => {
          calls.putIfNoneMatch++
          if (!rateOk(key, t)) return Effect.fail(new RateLimited({ key }))
          if (objects.has(key) && mutation !== "ignoreIfNoneMatch") {
            return Effect.fail(new PreconditionFailed({ key }))
          }
          return Effect.succeed(write(key, body, t))
        })
      ),
    putIfMatch: (key, etag, body) =>
      Effect.flatMap(storeNow, (t) =>
        Effect.suspend((): Effect.Effect<string, StoreError> => {
          calls.putIfMatch++
          if (!rateOk(key, t)) return Effect.fail(new RateLimited({ key }))
          const cur = objects.get(key)
          if (cur === undefined || (cur.etag !== etag && mutation !== "ignoreIfMatch")) {
            return Effect.fail(new PreconditionFailed({ key }))
          }
          return Effect.succeed(write(key, body, t))
        })
      ),
    get: (key) =>
      Effect.sync(() => {
        calls.get++
        const cur = mutation === "staleReads" && previous.has(key) ? previous.get(key) : objects.get(key)
        return Option.fromUndefinedOr(cur)
      })
  }
}
