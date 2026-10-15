/**
 * `BlobStore` (`../cache/blobStore.ts`) over the **Workers R2 binding**, for
 * the `node_modules` cache when the bisect predicate step runs inside the
 * Worker / Workflow (the CLI uses the S3 API: `../cache/r2BlobStore.ts`).
 *
 * - `putIfNoneMatch`: `bucket.put(key, bytes, { onlyIf: If-None-Match: * })`;
 *   the binding resolves to `null` when the condition fails, which becomes
 *   `PreconditionFailed` (an R2 429 surfaces as an exception whose message
 *   carries the status and becomes `RateLimited`).
 * - `getStream`: `bucket.get(key)`; `null` is `Option.none()`, otherwise the
 *   body stream.
 *
 * Declared structurally (no `@cloudflare/workers-types` here). Type-checked
 * and tested against a fake; **not run against a real binding**.
 */
import { Effect, Option, Stream } from "../fx/index.js"
import type { BlobStore } from "../cache/blobStore.js"
import { PreconditionFailed, RateLimited, type StoreError, StoreFailure } from "../store.js"

/** The part of the R2 binding used for binary objects. */
export interface R2BinaryBucketLike {
  readonly put: (key: string, value: Uint8Array, options?: { readonly onlyIf?: Headers }) => Promise<unknown | null>
  readonly get: (key: string) => Promise<{ readonly body: ReadableStream<Uint8Array> } | null>
}

const failure = (key: string, e: unknown): StoreError =>
  /\b429\b|too many requests|rate limit/i.test(e instanceof Error ? e.message : String(e)) ? new RateLimited({ key }) : new StoreFailure({ key, cause: e })

/**
 * The blob store.
 *
 * @param bucket - The R2 binding.
 */
export const makeR2BindingBlobStore = (bucket: R2BinaryBucketLike): BlobStore => ({
  putIfNoneMatch: (key, body) =>
    Effect.flatMap(
      Effect.tryPromise({ try: () => bucket.put(key, body, { onlyIf: new Headers({ "If-None-Match": "*" }) }), catch: (e) => failure(key, e) }),
      (r) => (r === null ? Effect.fail(new PreconditionFailed({ key })) : Effect.void)
    ),
  getStream: (key) =>
    Effect.map(
      Effect.tryPromise({ try: () => bucket.get(key), catch: (e) => new StoreFailure({ key, cause: e }) }),
      (o) =>
        o === null
          ? Option.none()
          : Option.some(Stream.fromReadableStream({ evaluate: () => o.body, onError: (e) => new StoreFailure({ key, cause: e }) }))
    )
})
