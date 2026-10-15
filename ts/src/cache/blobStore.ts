/**
 * The R2 calls the cache client needs, for binary objects:
 *
 * - `putIfNoneMatch`: `PutObject` with `If-None-Match: *` (create-only);
 * - `getStream`: `GetObject`, body as a stream of chunks.
 *
 * The cache never overwrites and never deletes; reclamation is an age-based
 * lifecycle rule per scope prefix (outside the client). Errors reuse the lock's
 * error types (`PreconditionFailed` = 412, `RateLimited` = 429,
 * `StoreFailure` = anything else).
 */
import { Effect, Option, Stream } from "../fx/index.js"
import { PreconditionFailed, type StoreError, StoreFailure } from "../store.js"

export interface BlobStore {
  readonly putIfNoneMatch: (key: string, body: Uint8Array) => Effect.Effect<void, StoreError>
  readonly getStream: (
    key: string
  ) => Effect.Effect<Option.Option<Stream.Stream<Uint8Array, StoreFailure>>, StoreFailure>
}

/** Fault injection for the in-memory store (tests and fault-injection drills). */
export interface Faults {
  /** Return a modified body for a read (corruption / poisoning in transit). */
  readonly tamper?: (key: string, body: Uint8Array) => Uint8Array
  /** Delay before each chunk is delivered (slow R2), in milliseconds of the Effect clock. */
  readonly chunkDelayMs?: (key: string) => number
  /** Fail the read stream after this many chunks (connection reset). */
  readonly failAfterChunks?: (key: string) => number | undefined
  /** Accept at most this many writes, then fail every write (process crash). */
  readonly crashAfterWrites?: number
}

export interface MemoryBlobStore extends BlobStore {
  /** Keys in the order their writes were accepted. */
  readonly writes: ReadonlyArray<string>
  readonly has: (key: string) => boolean
  readonly peek: (key: string) => Uint8Array | undefined
  /** Out-of-band write that bypasses create-only (models an attacker or a buggy writer with credentials). */
  readonly forcePut: (key: string, body: Uint8Array) => void
  readonly faults: Faults
}

export const makeMemoryBlobStore = (
  options: { readonly chunkSize?: number; readonly faults?: Faults } = {}
): MemoryBlobStore => {
  const chunkSize = options.chunkSize ?? 64 * 1024
  const faults: Faults = options.faults ?? {}
  const objects = new Map<string, Uint8Array>()
  const writes: Array<string> = []

  const chunks = (body: Uint8Array): Array<Uint8Array> => {
    const out: Array<Uint8Array> = []
    for (let i = 0; i < body.length; i += chunkSize) out.push(body.slice(i, i + chunkSize))
    return out
  }

  return {
    writes,
    faults,
    has: (key) => objects.has(key),
    peek: (key) => objects.get(key),
    forcePut: (key, body) => {
      objects.set(key, Uint8Array.from(body))
    },
    putIfNoneMatch: (key, body) =>
      Effect.suspend((): Effect.Effect<void, StoreError> => {
        if (faults.crashAfterWrites !== undefined && writes.length >= faults.crashAfterWrites) {
          return Effect.fail(new StoreFailure({ key, cause: "crashed" }))
        }
        if (objects.has(key)) return Effect.fail(new PreconditionFailed({ key }))
        objects.set(key, Uint8Array.from(body))
        writes.push(key)
        return Effect.void
      }),
    getStream: (key) =>
      Effect.sync(() => {
        const stored = objects.get(key)
        if (stored === undefined) return Option.none()
        const body = faults.tamper ? faults.tamper(key, stored) : stored
        const delay = faults.chunkDelayMs?.(key) ?? 0
        const failAfter = faults.failAfterChunks?.(key)
        const parts = chunks(body)
        let s: Stream.Stream<Uint8Array, StoreFailure> = Stream.fromIterable(
          failAfter === undefined ? parts : parts.slice(0, failAfter)
        )
        if (delay > 0) s = Stream.tap(s, () => Effect.sleep(delay))
        if (failAfter !== undefined) {
          s = Stream.concat(s, Stream.fail(new StoreFailure({ key, cause: "connection reset" })))
        }
        return Option.some(s)
      })
  }
}

