/**
 * The cache client (product shape C: our own action, decision D-0 / P*-1).
 *
 * Wires together the pieces whose behaviour only a client can control:
 * the restore deadline (D-11), the circuit breaker (D-12), client-side
 * verification (D-7, inside `restore`) and outcome reports (D-14).
 */
import { randomUUID } from "node:crypto"
import { Clock, Effect, Ref } from "../fx/index.js"
import type { BlobStore } from "./blobStore.js"
import { type BreakerConfig, type BreakerState, allowsRequest, breakerStep, initialBreaker } from "./breaker.js"
import type { DeadlinePolicy } from "./deadline.js"
import { type Digest, formatDigest } from "./digest.js"
import { publish, type OutputFile } from "./publish.js"
import { type MissReason, type RestoreResult, restore } from "./restore.js"
import type { Job, TrustPolicy } from "./scope.js"
import type { Staging } from "./staging.js"
import type { OutcomeReport } from "./telemetry.js"

/** Miss reasons that say the cache service is unhealthy (they feed the breaker). */
export const UNHEALTHY: ReadonlySet<MissReason> = new Set<MissReason>([
  "store_error",
  "lookup_deadline",
  "restore_deadline"
])

export interface CacheClientConfig {
  readonly store: BlobStore
  readonly policy: TrustPolicy
  readonly job: Job
  readonly breaker: BreakerConfig
  readonly deadline?: DeadlinePolicy
  /** Where outcome reports go (at-least-once is fine; reports carry an event id). */
  readonly report?: (r: OutcomeReport) => Effect.Effect<void>
}

export type ClientRestoreResult = RestoreResult | { readonly outcome: "miss"; readonly reason: "breaker_open" }

export interface CacheClient {
  readonly breakerState: Effect.Effect<BreakerState>
  readonly restore: (lookup: Digest, staging: Staging) => Effect.Effect<ClientRestoreResult>
  readonly publish: (
    lookup: Digest,
    files: ReadonlyArray<OutputFile>,
    buildMs: number
  ) => ReturnType<typeof publish>
}

export const makeCacheClient = (cfg: CacheClientConfig): Effect.Effect<CacheClient> =>
  Effect.gen(function* () {
    const breaker = yield* Ref.make<BreakerState>(initialBreaker)
    const report = cfg.report ?? (() => Effect.void)

    const emit = (lookup: Digest, outcome: OutcomeReport["outcome"]) =>
      report({ eventId: randomUUID(), scope: cfg.job.scope, lookup: formatDigest(lookup), outcome })

    const doRestore = (lookup: Digest, staging: Staging): Effect.Effect<ClientRestoreResult> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(breaker)
        if (!allowsRequest(state)) {
          yield* Ref.set(breaker, breakerStep(cfg.breaker, state, false))
          yield* emit(lookup, { kind: "miss", reason: "breaker_open" })
          return { outcome: "miss", reason: "breaker_open" } as const
        }
        const start = yield* Clock.currentTimeMillis
        const r = yield* restore({
          store: cfg.store,
          policy: cfg.policy,
          job: cfg.job,
          lookup,
          staging,
          ...(cfg.deadline ? { deadline: cfg.deadline } : {})
        })
        const end = yield* Clock.currentTimeMillis
        const bad = r.outcome === "miss" && UNHEALTHY.has(r.reason)
        yield* Ref.update(breaker, (s) => breakerStep(cfg.breaker, s, bad))
        yield* emit(lookup, r.outcome === "hit" ? { kind: "hit", restoreMs: end - start } : { kind: "miss", reason: r.reason })
        return r
      })

    return {
      breakerState: Ref.get(breaker),
      restore: doRestore,
      publish: (lookup, files, buildMs) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          publish({ store: cfg.store, job: cfg.job, lookup, files, buildMs, now })
        )
    }
  })
