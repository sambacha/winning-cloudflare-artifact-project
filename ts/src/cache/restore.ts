/**
 * Restore a cache entry (decision D-7: any failure is a miss).
 *
 * 1. Fetch the manifest from the job's read scopes, in order (trusted scopes
 *    first; untrusted jobs then try their own). The manifest must name the
 *    requested lookup digest. This phase has its own short deadline, since
 *    the restore deadline depends on the manifest's `buildMs` (D-11).
 * 2. Stream every blob from the manifest's scope into a staging session,
 *    hashing while streaming; the digest and size must equal the manifest's.
 *    The stream is cut off as soon as it exceeds the expected size.
 * 3. Swap the staging area into place. On any failure, timeout or
 *    interruption the staging area is discarded and the result is a miss.
 *
 * The client verifies against the digest in a manifest from a *read* scope;
 * this is what stops poisoning (`content_address_check_sound`, assuming a
 * collision-free hash). A Worker checking a digest supplied by the same writer
 * would only stop corruption (`self_attested_accepts_any`).
 *
 * `restore` never fails: its error channel is `never`.
 */
import { Clock, Data, Duration, Effect, Option, Result, Stream } from "../fx/index.js"
import type { BlobStore } from "./blobStore.js"
import { type Digest, StreamingDigest, digestEquals, formatDigest } from "./digest.js"
import { blobKey, manifestKey } from "./lookupKey.js"
import { type CacheManifest, blobDigestOf, decodeManifest } from "./manifest.js"
import { type Job, type Scope, type TrustPolicy, readScopes } from "./scope.js"
import type { Staging } from "./staging.js"
import { type DeadlinePolicy, DEFAULT_DEADLINE_POLICY, restoreDeadline } from "./deadline.js"

export type MissReason =
  | "not_found"
  | "manifest_invalid"
  | "manifest_mismatch"
  | "blob_missing"
  | "digest_mismatch"
  | "size_mismatch"
  | "store_error"
  | "lookup_deadline"
  | "restore_deadline"
  | "staging_error"
  | "internal_error"

export type RestoreResult =
  | {
      readonly outcome: "hit"
      readonly scope: Scope
      readonly manifest: CacheManifest
      readonly bytes: number
      /** The deadline that applied to the blob phase. */
      readonly deadline: Duration.Duration
    }
  | { readonly outcome: "miss"; readonly reason: MissReason; readonly scope?: Scope }

class Miss extends Data.TaggedError("Miss")<{ readonly reason: MissReason; readonly scope?: Scope }> {}

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface RestoreArgs {
  readonly store: BlobStore
  readonly policy: TrustPolicy
  readonly job: Job
  readonly lookup: Digest
  readonly staging: Staging
  readonly deadline?: DeadlinePolicy
  /**
   * Rebuild-time estimate for this runner class, if known. Defaults to the
   * manifest's `buildMs` (the producing build's duration).
   */
  readonly rebuildEstimateMs?: number
}

const missOf = (reason: MissReason, scope?: Scope) =>
  new Miss(scope === undefined ? { reason } : { reason, scope })

const readSmall = (store: BlobStore, key: string) =>
  Effect.gen(function* () {
    const s = yield* store.getStream(key)
    if (Option.isNone(s)) return Option.none<Uint8Array>()
    let total = 0
    const parts = yield* Stream.runCollect(
      s.value.pipe(
        Stream.tap((c) => {
          total += c.length
          return total > MAX_MANIFEST_BYTES ? Effect.fail(missOf("manifest_invalid")) : Effect.void
        })
      )
    )
    const out = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return Option.some(out)
  })

const findManifest = (args: RestoreArgs) =>
  Effect.gen(function* () {
    for (const scope of readScopes(args.policy, args.job)) {
      const body = yield* readSmall(args.store, manifestKey(scope, args.lookup)).pipe(
        Effect.mapError((e) => (e._tag === "Miss" ? e : missOf("store_error", scope)))
      )
      if (Option.isNone(body)) continue
      const m = decodeManifest(body.value)
      if (Result.isFailure(m)) return yield* missOf("manifest_invalid", scope)
      if (m.success.lookup !== formatDigest(args.lookup)) return yield* missOf("manifest_mismatch", scope)
      return { scope, manifest: m.success }
    }
    return yield* missOf("not_found")
  })

export const restore = (args: RestoreArgs): Effect.Effect<RestoreResult> => {
  const policy = args.deadline ?? DEFAULT_DEADLINE_POLICY

  const blobPhase = (scope: Scope, manifest: CacheManifest, deadline: Duration.Duration) =>
    Effect.gen(function* () {
      const deadlineAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(deadline)
      const session = yield* args.staging.begin.pipe(Effect.mapError(() => missOf("staging_error", scope)))
      const body = Effect.gen(function* () {
        let bytes = 0
        for (const f of manifest.files) {
          const expected = blobDigestOf(f)
          const s = yield* args.store
            .getStream(blobKey(scope, expected))
            .pipe(Effect.mapError(() => missOf("store_error", scope)))
          if (Option.isNone(s)) return yield* missOf("blob_missing", scope)
          const h = new StreamingDigest()
          // Create the file even if the blob is empty (an empty stream writes no chunk).
          yield* session.write(f.path, new Uint8Array(0)).pipe(Effect.mapError(() => missOf("staging_error", scope)))
          yield* Stream.runForEach(s.value, (chunk) =>
            Effect.suspend(() => {
              h.update(chunk)
              if (h.size > f.size) return Effect.fail(missOf("size_mismatch", scope))
              return session.write(f.path, chunk).pipe(Effect.mapError(() => missOf("staging_error", scope)))
            })
          ).pipe(Effect.mapError((e) => (e._tag === "Miss" ? e : missOf("store_error", scope))))
          if (h.size !== f.size) return yield* missOf("size_mismatch", scope)
          if (!digestEquals(h.finish(), expected)) return yield* missOf("digest_mismatch", scope)
          bytes += h.size
        }
        // Decide by the clock, not by which fiber wins the race with the timer:
        // a restore whose data is complete at or before the deadline is a hit.
        if ((yield* Clock.currentTimeMillis) > deadlineAt) return yield* missOf("restore_deadline", scope)
        yield* session.commit.pipe(Effect.mapError(() => missOf("staging_error", scope)))
        return bytes
      })
      // Discard the staging area on failure *and* on interruption (deadline).
      return yield* body.pipe(Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : session.abort)))
    })

  const run = Effect.gen(function* () {
    const { scope, manifest } = yield* findManifest(args).pipe(
      Effect.timeoutOrElse({ duration: policy.lookup, orElse: () => Effect.fail(missOf("lookup_deadline")) })
    )
    const deadline = restoreDeadline(args.rebuildEstimateMs ?? manifest.buildMs, policy)
    // The model (`costTimeout T d R = if d ≤ T then d else T + R`) counts a
    // restore that finishes exactly at the deadline as a hit. When the body and
    // the timer become ready at the same instant, which one Effect's
    // `timeoutOrElse` reports depends on fiber scheduling. So the hit/miss
    // decision is the clock check before the commit in `blobPhase`, and the
    // timer, armed one millisecond (the resolution of every deadline) later,
    // only interrupts a restore that is still running after the deadline.
    const bytes = yield* blobPhase(scope, manifest, deadline).pipe(
      Effect.timeoutOrElse({
        duration: Duration.sum(deadline, Duration.millis(1)),
        orElse: () => Effect.fail(missOf("restore_deadline", scope))
      })
    )
    return { outcome: "hit", scope, manifest, bytes, deadline } as RestoreResult
  })

  return run.pipe(
    Effect.catch((m) => Effect.succeed<RestoreResult>(m.scope === undefined ? { outcome: "miss", reason: m.reason } : { outcome: "miss", reason: m.reason, scope: m.scope })),
    Effect.catchDefect(() => Effect.succeed<RestoreResult>({ outcome: "miss", reason: "internal_error" }))
  )
}
