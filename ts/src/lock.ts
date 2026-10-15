/**
 * R2-backed cobuild lock (Approach 2: the lock object doubles as the result
 * pointer). The protocol is the one verified in `RequestProject/Cobuilds`:
 *
 * - acquire: `PutObject(If-None-Match: *)` with a fresh manifest;
 * - take over a stealable manifest (expired `building` lease, or a `failed`
 *   marker past its shelf life): `PutObject(If-Match: <etag read>)`;
 * - renew / publish / abandon: `PutObject(If-Match: <etag of our last write>)`.
 *
 * Fixes relative to the reviewed sketch (see `ts/README.md`):
 * - every successful write returns a new `HeldLock` carrying the ETag R2
 *   returned, and callers must use it for the next write (review item 2);
 * - failure markers record `failedAt`, and the shelf life is measured from it
 *   (item 4);
 * - only `RateLimited` (and transient failures that provably did not take
 *   effect) are retried, never `PreconditionFailed` (item 6);
 * - there is no `DeleteObject`. Giving up a lock is a CAS write that marks it
 *   expired, so it is fenced like every other write and needs no clock-skew
 *   margin (item 5). Publishing ends the lease, and there is no release after
 *   publish (item 1);
 * - every manifest carries a fresh nonce, so two versions never have the same
 *   content even if the ETag is a content hash (`content_etag_aba_breaks_mutex`).
 */
import { randomUUID } from "node:crypto"
import { Clock, Data, Duration, Effect, Option, Schedule } from "./fx/index.js"
import { decodeManifest, encodeManifest, type Manifest } from "./lockManifest.js"
import type { CacheKey, JobId } from "./ids.js"
import { countOccurrence, lockAcquireOutcomes } from "./metrics.js"
import { encodeKey } from "./cache/keyEncoding.js"
import { isValidScope } from "./cache/scope.js"
import {
  type ObjectStore,
  PreconditionFailed,
  RateLimited,
  type StoreError,
  StoreFailure
} from "./store.js"

// ---------------------------------------------------------------------------
// Manifest (in `lockManifest.ts`, so that read-only consumers such as the
// Worker can decode lock objects without the rest of the lock)

export { Manifest, Outcome } from "./lockManifest.js"

// ---------------------------------------------------------------------------
// Configuration

export interface CobuildConfig {
  /**
   * Writer trust scope (`trusted`, `fork-pr`, …), decision D-1 of
   * `docs/cache-proxy-plan.md`. It is the first component of every lock key,
   * so jobs of different trust levels never share a lock or a result pointer:
   * an untrusted job cannot hand "succeeded, get the build at X" to a trusted
   * one.
   */
  readonly scope: string
  /** `RUSH_COBUILD_CONTEXT`, e.g. the CI build id. */
  readonly context: string
  /** Unique per job / VM. */
  readonly jobId: JobId
  /** Lease length of a `building` manifest (default 30 s). */
  readonly lease?: Duration.Duration
  /** Heartbeat period while building (default 10 s). */
  readonly renewInterval?: Duration.Duration
  /** R2's per-key write window (default 1 s). */
  readonly rateLimit?: Duration.Duration
  /** Shelf life of a `failed` marker, from its `failedAt` (default 30 min). */
  readonly failureShelf?: Duration.Duration
  /** Worst-case latency of one R2 request (measure it; default 2 s). */
  readonly maxLatency?: Duration.Duration
  /** Worst-case clock difference between two jobs (default 1 s). */
  readonly maxSkew?: Duration.Duration
  readonly prefix?: string
  /**
   * Source of manifest nonces (default: `crypto.randomUUID`). Randomness is a
   * parameter so that the deterministic logic can be tested and replayed
   * with a deterministic source (rule 5 of the testing guidelines). Every
   * call must return a value never returned before.
   */
  readonly nonce?: () => string
}

/**
 * The configuration as the protocol uses it: every timing in whole
 * milliseconds, matching the `Nat` millisecond fields of the verified Lean
 * model (`RequestProject/Cobuilds`) and the epoch-millisecond timestamps in
 * lock manifests. {@link resolveConfig} converts the `Duration` inputs of
 * {@link CobuildConfig} at this boundary.
 */
export interface ResolvedConfig {
  readonly scope: string
  readonly context: string
  readonly jobId: JobId
  readonly leaseMs: number
  readonly renewIntervalMs: number
  readonly rateLimitMs: number
  readonly failureShelfMs: number
  readonly maxLatencyMs: number
  readonly maxSkewMs: number
  readonly prefix: string
}

/**
 * The checked configuration predicate (decision D-10). Returns the violated
 * conditions; empty means valid.
 *
 * - `rateLimitMs ≤ renewIntervalMs`: renewals respect R2's per-key write
 *   limit. (The earlier check without this bound admits a 1 ms heartbeat,
 *   i.e. 1000 writes/s on one key: `valid_allows_rate_violation`.)
 * - `renewIntervalMs + maxLatencyMs + maxSkewMs < leaseMs`: a renewal sent on
 *   schedule lands before any other job (whose clock may differ by
 *   `maxSkewMs`) considers the lease expired. The previous check here was
 *   only `renewIntervalMs < leaseMs`, which accepted a 29 999 ms heartbeat
 *   for a 30 000 ms lease: 1 ms for the request and any clock skew.
 *
 * Safety (mutual exclusion of R2 state) does not depend on these values
 * (`mutual_exclusion` is proved for every policy, and every write is fenced
 * by an ETag); they protect liveness and avoid duplicate builds.
 */
export const checkCobuildConfig = (r: ResolvedConfig): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const numeric: ReadonlyArray<readonly [string, number]> = [
    ["leaseMs", r.leaseMs],
    ["renewIntervalMs", r.renewIntervalMs],
    ["rateLimitMs", r.rateLimitMs],
    ["failureShelfMs", r.failureShelfMs],
    ["maxLatencyMs", r.maxLatencyMs],
    ["maxSkewMs", r.maxSkewMs]
  ]
  for (const [name, v] of numeric) {
    if (!Number.isSafeInteger(v) || v < 0) problems.push(`${name} must be a non-negative integer, got ${v}`)
  }
  if (r.leaseMs <= 0) problems.push(`leaseMs must be positive, got ${r.leaseMs}`)
  if (!(r.rateLimitMs <= r.renewIntervalMs)) {
    problems.push(`need rateLimitMs <= renewIntervalMs, got ${r.rateLimitMs} > ${r.renewIntervalMs}`)
  }
  if (!(r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs < r.leaseMs)) {
    problems.push(
      `need renewIntervalMs + maxLatencyMs + maxSkewMs < leaseMs, got ${r.renewIntervalMs} + ${r.maxLatencyMs} + ${r.maxSkewMs} >= ${r.leaseMs}`
    )
  }
  if (!isValidScope(r.scope)) problems.push(`scope must match [a-z0-9][a-z0-9-]{0,62}, got ${JSON.stringify(r.scope)}`)
  return problems
}

/** `d` (or `fallback`) in milliseconds; `Duration.infinity` gives `Infinity`, which {@link checkCobuildConfig} rejects. */
const millisOr = (d: Duration.Duration | undefined, fallback: Duration.Duration): number => Duration.toMillis(d ?? fallback)

/**
 * Applies the defaults, converts the `Duration` inputs to milliseconds and
 * checks the result.
 *
 * @param c - The configuration given by the caller.
 * @returns The resolved configuration.
 * @throws `Error` listing every violated condition of {@link checkCobuildConfig}.
 */
export const resolveConfig = (c: CobuildConfig): ResolvedConfig => {
  const r: ResolvedConfig = {
    scope: c.scope,
    context: c.context,
    jobId: c.jobId,
    leaseMs: millisOr(c.lease, Duration.seconds(30)),
    renewIntervalMs: millisOr(c.renewInterval, Duration.seconds(10)),
    rateLimitMs: millisOr(c.rateLimit, Duration.seconds(1)),
    failureShelfMs: millisOr(c.failureShelf, Duration.minutes(30)),
    maxLatencyMs: millisOr(c.maxLatency, Duration.seconds(2)),
    maxSkewMs: millisOr(c.maxSkew, Duration.seconds(1)),
    prefix: c.prefix ?? "cobuild"
  }
  const problems = checkCobuildConfig(r)
  if (problems.length > 0) throw new Error(`cobuild config: ${problems.join("; ")}`)
  return r
}

// ---------------------------------------------------------------------------
// Public types

/** A lock this job holds: the manifest it last wrote and the ETag R2 returned for that write. */
export interface HeldLock {
  readonly cacheKey: CacheKey
  readonly objectKey: string
  readonly manifest: Manifest
  readonly etag: string
}

export type LockState =
  | { readonly state: "obtained"; readonly lock: HeldLock }
  /** Someone else holds a live lease (or the attempt was rate limited). Try again later. */
  | { readonly state: "pending"; readonly owner: string | null; readonly expiresAt: number | null }
  | { readonly state: "completed"; readonly buildCacheKey: string }
  /** A failure marker still within its shelf life. */
  | { readonly state: "failed"; readonly failedAt: number; readonly logKey: string | null }

/** Our lock object was overwritten by someone else (our lease had expired). Our write did not happen. */
export class LockLost extends Data.TaggedError("LockLost")<{ readonly cacheKey: CacheKey }> {}

export type PublishOutcome =
  | { readonly status: "succeeded"; readonly buildCacheKey: string }
  | { readonly status: "failed"; readonly logKey: string | null }

export interface CobuildLock {
  readonly config: ResolvedConfig
  readonly objectKey: (cacheKey: CacheKey) => string
  /** Pure: may another job take over this manifest at time `now`? */
  readonly isStealable: (m: Manifest, now: number) => boolean
  readonly acquire: (cacheKey: CacheKey) => Effect.Effect<LockState, StoreFailure>
  /** One renewal attempt. On success, use the returned lock from now on. */
  readonly renewOnce: (
    held: HeldLock
  ) => Effect.Effect<HeldLock, LockLost | RateLimited | StoreFailure>
  /**
   * Publish the result and end the lease. `held` must be the latest lock
   * (after all renewals). Retries `429`. The lock must not be used afterwards.
   */
  readonly markCompleted: (
    held: HeldLock,
    outcome: PublishOutcome
  ) => Effect.Effect<void, LockLost | StoreFailure>
  /**
   * Give up a lock without a result (e.g. upload failed, build interrupted):
   * a CAS write that makes the manifest immediately stealable. Never call it
   * after `markCompleted`.
   */
  readonly abandon: (held: HeldLock) => Effect.Effect<void, LockLost | StoreFailure>
  /**
   * Read-only look at a lock (one `GetObject`, no write): `pending` while
   * another job holds a live lease, `completed` / `failed` for a published
   * result, `free` when there is no lock object or it may be taken over.
   * Waiting jobs poll with this instead of `acquire`, so they do not spend a
   * write (an R2 Class A operation) per poll or compete with the holder's
   * renewals for the key's 1 write / s.
   */
  readonly inspect: (cacheKey: CacheKey) => Effect.Effect<LockState | { readonly state: "free" }, StoreFailure>
}

// ---------------------------------------------------------------------------
// Implementation

export const makeCobuildLock = (store: ObjectStore, config: CobuildConfig): CobuildLock => {
  const cfg = resolveConfig(config)
  const nextNonce = config.nonce ?? randomUUID

  // `v1/<scope>/<prefix>/<context>/<cacheKey>/lock/`: escaped, terminated, versioned (D-4), scope first (D-1).
  const objectKey = (cacheKey: CacheKey) => encodeKey([cfg.scope, cfg.prefix, cfg.context, cacheKey, "lock"])

  const isStealable = (m: Manifest, now: number): boolean => {
    switch (m.outcome.status) {
      case "building":
        return m.expiresAt < now
      case "succeeded":
        return false
      case "failed":
        return m.outcome.failedAt + cfg.failureShelfMs < now
    }
  }

  const freshManifest = (now: number): Manifest => ({
    owner: cfg.jobId,
    nonce: nextNonce(),
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: now + cfg.leaseMs,
    outcome: { status: "building" }
  })

  const read = (key: string) =>
    store.get(key).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<{ manifest: Manifest; etag: string }>()),
          onSome: ({ body, etag }) =>
            decodeManifest(body).pipe(
              Effect.map((manifest) => Option.some({ manifest, etag })),
              Effect.mapError(
                (e) =>
                  new StoreFailure({ key, cause: e.message })
              )
            )
        })
      ),
      Effect.catchTag(["PreconditionFailed", "RateLimited"], (e) =>
        Effect.fail(new StoreFailure({ key, cause: e }))
      )
    )

  /**
   * Did a write of `manifest` to `key` take effect even though the request
   * reported an error? Re-read: the write happened iff our nonce is there.
   * A failed read yields `None` ("unknown"), and the caller keeps the
   * original error.
   *
   * This covers three ways the response and the effect can disagree:
   * - a network error after R2 applied the write (`StoreFailure`);
   * - a client-side retry of a write that had already been applied (the AWS
   *   SDK retries 5xx / timeouts by default): the retry then sees our own
   *   object and gets `412` (or `429`, being less than 1 s after the first
   *   attempt), although the first attempt succeeded.
   * `makeR2S3Client` turns SDK retries off for the lock client, and this check
   * makes the lock correct even with a client that retries.
   */
  /** Same writer (job id) and same version (nonce): nonces only need to be unique per job. */
  const isOurs = (stored: Manifest, written: Manifest): boolean =>
    stored.owner === written.owner && stored.nonce === written.nonce

  const ownWrite = (key: string, manifest: Manifest) =>
    read(key).pipe(
      Effect.map(Option.flatMap((cur) => (isOurs(cur.manifest, manifest) ? Option.some(cur.etag) : Option.none()))),
      Effect.catch(() => Effect.succeed(Option.none<string>()))
    )

  /**
   * Compare-and-swap write. If the request fails, re-read: if our nonce is
   * there, the write happened and we adopt its ETag; after an ambiguous
   * failure (network error), if the old ETag is still there, it did not
   * happen (`StoreFailure`, safe to retry); otherwise someone else wrote
   * (`PreconditionFailed`).
   */
  const casWrite = (
    key: string,
    expected: string,
    manifest: Manifest
  ): Effect.Effect<string, StoreError> =>
    store.putIfMatch(key, expected, encodeManifest(manifest)).pipe(
      Effect.catch((err): Effect.Effect<string, StoreError> => {
        if (err._tag !== "StoreFailure") {
          // 412 / 429: normally final, unless an earlier attempt of this very write was applied.
          return Effect.flatMap(ownWrite(key, manifest), Option.match({ onNone: () => Effect.fail(err), onSome: Effect.succeed }))
        }
        return read(key).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail<StoreError>(new PreconditionFailed({ key })),
              onSome: (cur): Effect.Effect<string, StoreError> =>
                isOurs(cur.manifest, manifest)
                  ? Effect.succeed(cur.etag)
                  : cur.etag === expected
                    ? Effect.fail(err)
                    : Effect.fail(new PreconditionFailed({ key }))
            })
          )
        )
      })
    )

  /** Same reconciliation for the initial create. */
  const createWrite = (key: string, manifest: Manifest): Effect.Effect<string, StoreError> =>
    store.putIfNoneMatch(key, encodeManifest(manifest)).pipe(
      Effect.catch((err): Effect.Effect<string, StoreError> => {
        if (err._tag !== "StoreFailure") {
          return Effect.flatMap(ownWrite(key, manifest), Option.match({ onNone: () => Effect.fail(err), onSome: Effect.succeed }))
        }
        return read(key).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail<StoreError>(err),
              onSome: (cur): Effect.Effect<string, StoreError> =>
                isOurs(cur.manifest, manifest)
                  ? Effect.succeed(cur.etag)
                  : Effect.fail(new PreconditionFailed({ key }))
            })
          )
        )
      })
    )

  const lost = (held: HeldLock) => new LockLost({ cacheKey: held.cacheKey })

  const toLost = <A>(held: HeldLock, eff: Effect.Effect<A, StoreError>) =>
    eff.pipe(Effect.catchTag("PreconditionFailed", () => Effect.fail(lost(held))))

  const pending = (m: Manifest | null): LockState => ({
    state: "pending",
    owner: m?.owner ?? null,
    expiresAt: m?.expiresAt ?? null
  })

  const acquireOnce = (cacheKey: CacheKey): Effect.Effect<LockState, StoreFailure> =>
    Effect.gen(function* () {
      const key = objectKey(cacheKey)
      const now = yield* Clock.currentTimeMillis
      const manifest = freshManifest(now)
      const created = yield* Effect.result(createWrite(key, manifest))
      if (created._tag === "Success") {
        return { state: "obtained", lock: { cacheKey, objectKey: key, manifest, etag: created.success } }
      }
      switch (created.failure._tag) {
        case "RateLimited":
          return pending(null)
        case "StoreFailure":
          return yield* Effect.fail(created.failure)
        case "PreconditionFailed":
          break
      }
      // The object exists: read it (strongly consistent).
      const current = yield* read(key)
      if (Option.isNone(current)) return pending(null) // deleted in between; try again later
      const { manifest: existing, etag } = current.value
      const readAt = yield* Clock.currentTimeMillis
      if (isStealable(existing, readAt)) {
        // Take over with If-Match on the ETag we read, and keep the ETag R2 returns.
        const takeover = freshManifest(readAt)
        const stolen = yield* Effect.result(casWrite(key, etag, takeover))
        if (stolen._tag === "Success") {
          return {
            state: "obtained",
            lock: { cacheKey, objectKey: key, manifest: takeover, etag: stolen.success }
          }
        }
        if (stolen.failure._tag === "StoreFailure") return yield* Effect.fail(stolen.failure)
        return pending(null) // someone else took it first, or rate limited
      }
      switch (existing.outcome.status) {
        case "succeeded":
          return { state: "completed", buildCacheKey: existing.outcome.buildCacheKey }
        case "failed":
          return {
            state: "failed",
            failedAt: existing.outcome.failedAt,
            logKey: existing.outcome.logKey
          }
        case "building":
          return pending(existing)
      }
    })

  /** {@link acquireOnce}, with its outcome counted in `cobuild_lock_acquire_outcomes`. */
  const acquire = (cacheKey: CacheKey): Effect.Effect<LockState, StoreFailure> =>
    acquireOnce(cacheKey).pipe(Effect.tap((state) => countOccurrence(lockAcquireOutcomes, state.state)))

  const renewOnce = (held: HeldLock) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const manifest: Manifest = {
        ...held.manifest,
        nonce: nextNonce(),
        heartbeatAt: now,
        expiresAt: now + cfg.leaseMs
      }
      const etag = yield* toLost(held, casWrite(held.objectKey, held.etag, manifest))
      return { ...held, manifest, etag }
    })

  const retryRateLimit = <A, E extends { readonly _tag: string }>(eff: Effect.Effect<A, E>) =>
    Effect.retry(eff, {
      schedule: Schedule.spaced(cfg.rateLimitMs),
      times: 10,
      // Only 429 and transient failures that did not take effect; never 412 / LockLost.
      while: (e: E) => e._tag === "RateLimited" || e._tag === "StoreFailure"
    })

  const markCompleted = (held: HeldLock, outcome: PublishOutcome) =>
    retryRateLimit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const manifest: Manifest = {
          ...held.manifest,
          nonce: nextNonce(),
          heartbeatAt: now,
          outcome:
            outcome.status === "succeeded"
              ? { status: "succeeded", buildCacheKey: outcome.buildCacheKey }
              : { status: "failed", failedAt: now, logKey: outcome.logKey }
        }
        yield* toLost(held, casWrite(held.objectKey, held.etag, manifest))
      })
    ).pipe(
      Effect.catchTag("RateLimited", (e) =>
        Effect.fail(new StoreFailure({ key: held.objectKey, cause: e }))
      )
    )

  const abandon = (held: HeldLock) =>
    retryRateLimit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const manifest: Manifest = {
          ...held.manifest,
          nonce: nextNonce(),
          heartbeatAt: now,
          expiresAt: now - 1 // stealable by anyone from now on
        }
        yield* toLost(held, casWrite(held.objectKey, held.etag, manifest))
      })
    ).pipe(
      Effect.catchTag("RateLimited", (e) =>
        Effect.fail(new StoreFailure({ key: held.objectKey, cause: e }))
      )
    )

  const inspect = (cacheKey: CacheKey) =>
    Effect.gen(function* () {
      const current = yield* read(objectKey(cacheKey))
      if (Option.isNone(current)) return { state: "free" } as const
      const m = current.value.manifest
      const now = yield* Clock.currentTimeMillis
      if (isStealable(m, now)) return { state: "free" } as const
      switch (m.outcome.status) {
        case "succeeded":
          return { state: "completed", buildCacheKey: m.outcome.buildCacheKey } as const
        case "failed":
          return { state: "failed", failedAt: m.outcome.failedAt, logKey: m.outcome.logKey } as const
        case "building":
          return pending(m)
      }
    })

  return { config: cfg, objectKey, isStealable, acquire, renewOnce, markCompleted, abandon, inspect }
}
