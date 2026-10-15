/**
 * Publish a cache entry: blobs first (create-only), then one create-only
 * manifest (decision D-3).
 *
 * R2 cannot commit several keys atomically (`step_changes_at_most_one_key`),
 * so the manifest write is the commit point. Writing every blob before the
 * manifest means that after a crash at *any* point, a present manifest names
 * only present blobs (`blobs_then_manifest_safe`; the opposite order fails
 * after one step, `manifest_first_unsafe`). This is property-tested over
 * every crash prefix in `test/cache/publishRestore.test.ts`.
 *
 * A job writes only into its own scope (D-1): the scope is taken from the
 * job, not from an argument. (Server-side enforcement of that rule is the
 * authorisation layer, D-8, which is outside this client.)
 *
 * Blob uploads run concurrently (`uploadConcurrency`); the manifest waits for
 * all of them. A crashed publish leaves unreferenced blobs, which the
 * per-scope age-based lifecycle rule reclaims.
 */
import { Data, Effect, Schedule } from "../fx/index.js"
import { type StoreError } from "../store.js"
import type { BlobStore } from "./blobStore.js"
import { type Digest, digestBytes } from "./digest.js"
import { blobKey, manifestKey } from "./lookupKey.js"
import { encodeManifest, isSafeRelativePath, isTreeShaped, makeManifest } from "./manifest.js"
import type { Job } from "./scope.js"

export interface OutputFile {
  readonly path: string
  readonly bytes: Uint8Array
}

export class InvalidOutput extends Data.TaggedError("InvalidOutput")<{ readonly reason: string }> {}

export type PublishResult = "published" | "exists"

export interface PublishArgs {
  readonly store: BlobStore
  readonly job: Job
  readonly lookup: Digest
  readonly files: ReadonlyArray<OutputFile>
  readonly buildMs: number
  readonly now: number
  readonly uploadConcurrency?: number
}

/** Retry `429` only (never `412`), once per second, a bounded number of times. */
const retryRateLimited = <A, E extends { readonly _tag: string }, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.retry(eff, {
    schedule: Schedule.spaced("1 second"),
    times: 5,
    while: (e) => e._tag === "RateLimited"
  })

/** Create-only write where "already exists" is success (the content is addressed by its digest). */
const putBlob = (store: BlobStore, key: string, bytes: Uint8Array) =>
  retryRateLimited(store.putIfNoneMatch(key, bytes)).pipe(
    Effect.catchTag("PreconditionFailed", () => Effect.void)
  )

export const publish = (args: PublishArgs): Effect.Effect<PublishResult, InvalidOutput | StoreError> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    for (const f of args.files) {
      if (!isSafeRelativePath(f.path)) return yield* new InvalidOutput({ reason: `unsafe path ${f.path}` })
      if (seen.has(f.path)) return yield* new InvalidOutput({ reason: `duplicate path ${f.path}` })
      seen.add(f.path)
    }
    if (!isTreeShaped([...seen])) return yield* new InvalidOutput({ reason: "a path is both a file and a directory" })
    const scope = args.job.scope
    const entries = args.files.map((f) => ({ path: f.path, bytes: f.bytes, blob: digestBytes(f.bytes) }))

    // 1. Every distinct blob, create-only.
    const distinct = new Map(entries.map((e) => [blobKey(scope, e.blob), e.bytes] as const))
    yield* Effect.forEach([...distinct], ([key, bytes]) => putBlob(args.store, key, bytes), {
      concurrency: args.uploadConcurrency ?? 8,
      discard: true
    })

    // 2. The commit point: one create-only manifest.
    const manifest = makeManifest({
      lookup: args.lookup,
      buildMs: args.buildMs,
      createdAt: args.now,
      files: entries.map((e) => ({ path: e.path, blob: e.blob, size: e.bytes.length }))
    })
    return yield* retryRateLimited(args.store.putIfNoneMatch(manifestKey(scope, args.lookup), encodeManifest(manifest))).pipe(
      Effect.as("published" as PublishResult),
      Effect.catchTag("PreconditionFailed", () => Effect.succeed("exists" as PublishResult))
    )
  })
