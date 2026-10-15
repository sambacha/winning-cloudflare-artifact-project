/**
 * Cooperative-build job runner: what one CI job ("primary", "extra1", …)
 * does in the Rush cobuild design, driving the real lock (`runCobuild`) and
 * the real build cache (`publish` / `restore`).
 *
 * Per job, repeatedly:
 *  1. take the operations whose dependencies are all done *locally* (built
 *     or restored by this job), non-pending ones first;
 *  2. for each, `runCobuild`: build it if we get the lock (the heartbeat runs
 *     meanwhile), restore it if another job completed it, record a failure if
 *     another job failed it, or put it on the pending list if another job
 *     holds a live lease;
 *  3. if a whole pass made no progress, wait `pollInterval` and retry.
 * Operations depending on a failed operation are skipped.
 *
 * Fixes relative to the proposal's `runJob` (`docs/demo-dependency-plan.md`
 * C4–C8):
 * - the lock key is the operation's Merkle lookup digest over its inputs and
 *   its dependencies' digests (`computeLookupDigests`), not its name, so a
 *   run with changed inputs in the same context never restores stale output;
 * - operations are scheduled from the dependency graph, so a shuffled order
 *   cannot start `test-suite` before `build-core`;
 * - `runCobuild` is used, so the lease is renewed while building;
 * - the `failed` lock state is handled (failure recorded, dependents skipped);
 * - "completed elsewhere" is a real cache restore, verified by digest, not
 *   just a log line.
 */
import { Cause, Clock, Data, Duration, Effect } from "../fx/index.js"
import { CacheKey, type JobId } from "../ids.js"
import type { BlobStore } from "../cache/blobStore.js"
import { type Digest, digestBytes, formatDigest } from "../cache/digest.js"
import { computeLookupDigests, type KeyEnvironment, type PackageInputs } from "../cache/lookupKey.js"
import { type OutputFile, publish } from "../cache/publish.js"
import { restore } from "../cache/restore.js"
import { makeScope, type TrustPolicy } from "../cache/scope.js"
import { makeMemoryStaging, type Staging } from "../cache/staging.js"
import { runCobuild } from "../cobuild.js"
import { type CobuildConfig, makeCobuildLock } from "../lock.js"
import type { ObjectStore } from "../store.js"

export interface DemoOperation {
  readonly name: string
  readonly deps: ReadonlyArray<string>
  /** Simulated build time (Effect clock milliseconds). */
  readonly buildMs: number
  /** Content of the operation's own inputs (changing it changes the lookup digest). */
  readonly inputs: string
  /** The build fails (e.g. broken tests). */
  readonly fails?: boolean
}

export type RunnerEvent =
  | { readonly kind: "build-start"; readonly job: string; readonly op: string; readonly at: number; readonly lockKey: string }
  | { readonly kind: "built"; readonly job: string; readonly op: string; readonly at: number; readonly buildCacheKey: string }
  | { readonly kind: "build-failed"; readonly job: string; readonly op: string; readonly at: number }
  | { readonly kind: "restored"; readonly job: string; readonly op: string; readonly at: number; readonly bytes: number }
  | { readonly kind: "cache-hit"; readonly job: string; readonly op: string; readonly at: number; readonly bytes: number }
  | { readonly kind: "failed-elsewhere"; readonly job: string; readonly op: string; readonly at: number; readonly logKey: string | null }
  | { readonly kind: "pending"; readonly job: string; readonly op: string; readonly at: number; readonly owner: string | null }
  | { readonly kind: "skipped"; readonly job: string; readonly op: string; readonly at: number; readonly failedDep: string }
  | { readonly kind: "lock-lost"; readonly job: string; readonly op: string; readonly at: number }

export interface JobConfig {
  readonly jobId: JobId
  /** Operation names in this job's preferred order (any permutation). */
  readonly order: ReadonlyArray<string>
}

export interface RunnerConfig {
  readonly ops: ReadonlyArray<DemoOperation>
  readonly lockStore: ObjectStore
  readonly blobStore: BlobStore
  /** Cobuild settings shared by every job (context, scope, lease, …), without `jobId`. */
  readonly cobuild: Omit<CobuildConfig, "jobId">
  readonly keyEnv: KeyEnvironment
  /** Wait between passes that made no progress. */
  readonly pollInterval: Duration.Duration
  readonly onEvent?: (e: RunnerEvent) => void
  /**
   * How operations are keyed, built and restored. The default (`demoHooks`)
   * simulates builds with `Effect.sleep` and restores into memory; the
   * `cobuild` CLI plugs in real commands, file hashing and on-disk restores
   * (`src/cli/workspace.ts`).
   */
  readonly hooks?: RunnerHooks
  /**
   * Before taking the lock, try the build cache (step 3 of the proposal:
   * "check if it can be pulled from cache"). This gives hits across cobuild
   * contexts (e.g. a previous CI run): the lock objects are per context, the
   * cache entries are not. Costs one `GetObject` (usually a 404) per
   * operation. Default `false`.
   */
  readonly cacheFirst?: boolean
}

/** A failed build, with an optional log that is uploaded and referenced from the failure marker. */
export class BuildFailure {
  readonly _tag = "BuildFailure"
  constructor(readonly log: string = "") {}
}

export interface RunnerHooks {
  /** Lookup digest of every operation (dependency order is the hooks' business; throw `InvalidPlan` on bad graphs). */
  readonly digests: (ops: ReadonlyArray<DemoOperation>, env: KeyEnvironment) => Map<string, Digest>
  /** Build one operation and return its output files. */
  readonly build: (op: DemoOperation, lookup: Digest) => Effect.Effect<ReadonlyArray<OutputFile>, BuildFailure>
  /** Where a restored cache entry of `op` is staged and installed. */
  readonly staging: (op: DemoOperation) => Staging
  /** Store a failure log and return its key (default: no log). */
  readonly uploadFailureLog?: (op: DemoOperation, lookup: Digest, log: string) => Effect.Effect<string | null>
}

export type OpOutcome = "built" | "restored" | "build-failed" | "failed-elsewhere" | "skipped"

export interface JobSummary {
  readonly jobId: JobId
  readonly outcomes: ReadonlyMap<string, OpOutcome>
}

export class InvalidPlan extends Data.TaggedError("InvalidPlan")<{ readonly message: string }> {
  override readonly name = "InvalidPlan"
  /** @param message - Human-readable description. */
  constructor(message: string) {
    super({ message })
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** Lookup digest of every operation (throws `InvalidPlan` on duplicates, unknown dependencies or cycles). */
export const operationDigests = (ops: ReadonlyArray<DemoOperation>, env: KeyEnvironment): Map<string, Digest> => {
  const graph = new Map<string, PackageInputs>()
  for (const op of ops) {
    if (graph.has(op.name)) throw new InvalidPlan(`duplicate operation ${op.name}`)
    graph.set(op.name, { inputs: [{ path: `${op.name}/inputs`, digest: digestBytes(utf8(op.inputs)) }], deps: op.deps })
  }
  try {
    return computeLookupDigests(env, graph)
  } catch (e) {
    throw new InvalidPlan(`invalid dependency graph: ${String((e as { _tag?: string })._tag ?? e)}`)
  }
}

/** Deterministic build output of an operation (what a real build would upload). */
export const buildOutput = (op: DemoOperation, lookup: Digest) => [
  { path: `${op.name}/out.txt`, bytes: utf8(`output of ${op.name} for ${formatDigest(lookup)}`) }
]

/** Simulated builds (Effect clock) with deterministic outputs, restored into memory. */
export const demoHooks: RunnerHooks = {
  digests: operationDigests,
  build: (op, lookup) =>
    Effect.gen(function* () {
      yield* Effect.sleep(op.buildMs)
      if (op.fails === true) return yield* Effect.fail(new BuildFailure(`${op.name}: simulated failure`))
      return buildOutput(op, lookup)
    }),
  staging: () => makeMemoryStaging()
}

/** One CI job. Store errors on an operation leave it for a later pass; the job ends when every operation has an outcome. */
export const runJob = (cfg: RunnerConfig, job: JobConfig): Effect.Effect<JobSummary> =>
  Effect.gen(function* () {
    const hooks = cfg.hooks ?? demoHooks
    const digests = hooks.digests(cfg.ops, cfg.keyEnv)
    const byName = new Map(cfg.ops.map((o) => [o.name, o]))
    if (
      job.order.length !== cfg.ops.length ||
      !job.order.every((n) => byName.has(n)) ||
      new Set(job.order).size !== job.order.length
    ) {
      throw new InvalidPlan(`job ${job.jobId}: order must be a permutation of the operations`)
    }
    const scope = makeScope(cfg.cobuild.scope)
    const cacheJob = { scope }
    const policy: TrustPolicy = { trusted: [scope] }
    const lock = makeCobuildLock(cfg.lockStore, { ...cfg.cobuild, jobId: job.jobId })
    const outcomes = new Map<string, OpOutcome>()
    const pending = new Set<string>()
    const emit = (e: RunnerEvent) => cfg.onEvent?.(e)
    const isDone = (n: string) => outcomes.get(n) === "built" || outcomes.get(n) === "restored"
    const isBad = (n: string) => outcomes.has(n) && !isDone(n)

    for (;;) {
      const passStart = yield* Clock.currentTimeMillis
      // Skip everything that depends on a failed or skipped operation (to a fixed point).
      let changed = true
      while (changed) {
        changed = false
        for (const name of job.order) {
          if (outcomes.has(name)) continue
          const bad = byName.get(name)!.deps.find(isBad)
          if (bad !== undefined) {
            outcomes.set(name, "skipped")
            pending.delete(name)
            emit({ kind: "skipped", job: job.jobId, op: name, at: passStart, failedDep: bad })
            changed = true
          }
        }
      }
      if (outcomes.size === cfg.ops.length) return { jobId: job.jobId, outcomes }

      const ready = job.order.filter((n) => !outcomes.has(n) && byName.get(n)!.deps.every(isDone))
      const candidates = [...ready.filter((n) => !pending.has(n)), ...ready.filter((n) => pending.has(n))]
      let progressed = false

      for (const name of candidates) {
        const op = byName.get(name)!
        const lookup = digests.get(name)!
        const lockKey = CacheKey(formatDigest(lookup))
        if (cfg.cacheFirst === true && !pending.has(name)) {
          const cached = yield* restore({ store: cfg.blobStore, policy, job: cacheJob, lookup, staging: hooks.staging(op) })
          if (cached.outcome === "hit") {
            outcomes.set(name, "restored")
            emit({ kind: "cache-hit", job: job.jobId, op: name, at: yield* Clock.currentTimeMillis, bytes: cached.bytes })
            progressed = true
            break
          }
        }
        // Waiting on another job's live lease: look (one read) before trying to write.
        if (pending.has(name)) {
          const seen = yield* Effect.result(lock.inspect(lockKey))
          if (seen._tag === "Success" && seen.success.state === "pending") continue
        }
        const result = yield* Effect.result(
          runCobuild(lock, {
            cacheKey: lockKey,
            build: Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              emit({ kind: "build-start", job: job.jobId, op: name, at: startedAt, lockKey })
              const files = yield* hooks.build(op, lookup)
              return { files, buildMs: (yield* Clock.currentTimeMillis) - startedAt }
            }),
            upload: ({ files, buildMs }) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                yield* publish({ store: cfg.blobStore, job: cacheJob, lookup, files, buildMs, now })
                return lockKey
              }),
            ...(hooks.uploadFailureLog !== undefined
              ? {
                  uploadFailureLog: (cause: Cause.Cause<BuildFailure>) => {
                    const failure = cause.reasons.find((r): r is Cause.Fail<BuildFailure> => Cause.isFailReason(r))
                    const log = failure !== undefined ? failure.error.log : Cause.pretty(cause)
                    return hooks.uploadFailureLog!(op, lookup, log)
                  }
                }
              : {})
          })
        )
        const at = yield* Clock.currentTimeMillis
        if (result._tag === "Failure") continue // store error: retry on a later pass
        const r = result.success
        switch (r._tag) {
          case "Built":
            outcomes.set(name, "built")
            emit({ kind: "built", job: job.jobId, op: name, at, buildCacheKey: r.buildCacheKey })
            break
          case "BuildFailed":
            outcomes.set(name, "build-failed")
            emit({ kind: "build-failed", job: job.jobId, op: name, at })
            break
          case "FailedElsewhere":
            outcomes.set(name, "failed-elsewhere")
            emit({ kind: "failed-elsewhere", job: job.jobId, op: name, at, logKey: r.logKey })
            break
          case "CompletedElsewhere": {
            const restored = yield* restore({ store: cfg.blobStore, policy, job: cacheJob, lookup, staging: hooks.staging(op) })
            // A miss after "completed" means the cache entry is unusable: leave the operation for a later pass.
            if (restored.outcome !== "hit") continue
            outcomes.set(name, "restored")
            emit({ kind: "restored", job: job.jobId, op: name, at, bytes: restored.bytes })
            break
          }
          case "Pending":
            if (!pending.has(name)) emit({ kind: "pending", job: job.jobId, op: name, at, owner: r.owner })
            pending.add(name)
            continue
          case "LockLost":
            emit({ kind: "lock-lost", job: job.jobId, op: name, at })
            continue
        }
        pending.delete(name)
        progressed = true
        break // re-evaluate readiness: this outcome may unblock operations earlier in the order
      }
      if (!progressed) yield* Effect.sleep(cfg.pollInterval)
    }
  })

/** Run several jobs concurrently on the same stores. */
export const runJobs = (cfg: RunnerConfig, jobs: ReadonlyArray<JobConfig>): Effect.Effect<ReadonlyArray<JobSummary>> =>
  Effect.forEach(jobs, (j) => runJob(cfg, j), { concurrency: "unbounded" })
