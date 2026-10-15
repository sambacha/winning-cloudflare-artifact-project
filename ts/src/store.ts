/**
 * The subset of the R2 object API used by the cobuild lock.
 *
 * Every method is a single R2 request. The lock never uses an unconditional
 * write or `DeleteObject`, so every state change it makes is fenced by an
 * ETag. That is the property behind `Skew.stale_cas_rejected` in the Lean
 * development.
 */
import { Data, Effect, Option } from "./fx/index.js"

/** `412 Precondition Failed`: the `If-None-Match` / `If-Match` condition did not hold. */
export class PreconditionFailed extends Data.TaggedError("PreconditionFailed")<{
  readonly key: string
}> {}

/** `429 Too Many Requests`: a write to this key less than 1 s after the previous one. It has no effect. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly key: string
}> {}

/** Any other failure (network, 5xx, malformed response). The request may or may not have taken effect. */
export class StoreFailure extends Data.TaggedError("StoreFailure")<{
  readonly key: string
  readonly cause: unknown
}> {}

export type StoreError = PreconditionFailed | RateLimited | StoreFailure

export const isRateLimited = (e: { readonly _tag: string }): e is RateLimited =>
  e._tag === "RateLimited"

export interface StoredObject {
  readonly body: string
  readonly etag: string
}

export interface ObjectStore {
  /** `PutObject` with `If-None-Match: *`. Returns the ETag of the new object. */
  readonly putIfNoneMatch: (key: string, body: string) => Effect.Effect<string, StoreError>
  /** `PutObject` with `If-Match: <etag>` (compare-and-swap). Returns the ETag of the new version. */
  readonly putIfMatch: (
    key: string,
    etag: string,
    body: string
  ) => Effect.Effect<string, StoreError>
  /** Strongly consistent `GetObject`. */
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredObject>, StoreError>
}
