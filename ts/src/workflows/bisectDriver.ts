/**
 * The durable bisect driver: the body of the Cloudflare Workflow
 * (`BisectWorkflow.ts`), written against a minimal `step.do` interface so
 * the same code runs under a local durable runner (`localSteps.ts`) in tests
 * and in the demo.
 *
 * Source of truth: the **R2 session** (`../worker/bisectStore.ts`). Workflow
 * step outputs are a recovery source for R2, not a second state store.
 *
 * Per iteration `k`, two steps (deterministic names, so a restarted instance
 * replays completed steps from their cached outputs instead of re-running
 * them):
 *
 * - `test-k`: load the session from R2; if it already holds the result with
 *   idempotency key `<instance>:k`, return that result (nothing re-runs).
 *   Otherwise pick the next commit (`sessionStatus`), mint a read token, run
 *   the predicate in a fresh sandbox (`runPredicateStep`) and **return** the
 *   observation. Nothing is written here.
 * - `record-k`: record the observation with `recordStep` through the CAS
 *   loop `modifySession` and **return the new session**. Repeating it is a
 *   no-op (the step key is already present).
 *
 * Before each `test-k`, the session returned by `record-(k-1)` is compared
 * with R2: keyed observations the returned session has and R2 lacks (R2 lost
 * a completed write) are written back. No captured variable is mutated
 * across steps; every value that crosses a step boundary is a step's return
 * value.
 *
 * When the session is done (confidence reached, step budget used, or
 * nothing testable left) a final `result` step writes
 * `manifests/<sessionId>/result.json` create-only and returns it.
 */
import type { BlobStore } from "../cache/blobStore.js"
import { type BisectSession, hasStep, modifySession, recordStep, type SessionStore, sessionStatus, type StepOutcome } from "../bisect/session.js"
import { type PredicateInfraError, type PredicateStepInput, type PredicateStepResult, runPredicateStep } from "../bisect/predicateStep.js"
import type { SandboxFactory } from "../bisect/sandbox.js"
import { Clock, Data, Duration, Effect, runPromiseOrThrow, Schedule } from "../fx/index.js"
import type { SessionId } from "../ids.js"
import { type BisectResultManifest, resultFromSession, type ResultStore } from "../worker/resultStore.js"

/** The part of a Workflows `step` the driver uses. */
export interface StepLike {
  readonly do: <T>(name: string, fn: () => Promise<T>) => Promise<T>
}

/** The session the driver was started for does not exist. */
export class NoSuchSession extends Data.TaggedError("NoSuchSession")<{ readonly sessionId: string }> {}

/** How the predicate runs (the same for every step). */
export interface PredicateConfig {
  /** Run with `sh -c` in the checkout (default `npm test`). */
  readonly command: string
  readonly timeoutSec: number
  /** Extra environment for the predicate of step `k` (e.g. a reproducible seed). */
  readonly envFor?: (k: number) => Record<string, string>
  readonly noInstall?: boolean
  readonly workdir?: string
}

/** Everything the driver talks to. */
export interface BisectDriverDeps {
  readonly sessions: SessionStore
  readonly results: ResultStore
  /** Remote and a **read** token for the repository (the existing credentials route's logic). */
  readonly credentials: (repo: string) => Effect.Effect<{ readonly remote: string; readonly token: string }, unknown>
  readonly sandbox: SandboxFactory
  /** The `node_modules` cache (optional). */
  readonly nodeModules?: BlobStore
  readonly predicate: PredicateConfig
  /** Unique suffix for sandbox ids (a fresh sandbox per attempt). */
  readonly freshId: () => string
  /** Attempts per checkout before the commit is skipped as untestable here (default 3). */
  readonly infraAttempts?: number
  /** First retry delay after a failed checkout (default 1 s; doubles each time). */
  readonly infraBackoff?: Duration.Input
}

/** Parameters of one driver run (a Workflow instance's payload). */
export interface BisectDriverParams {
  readonly sessionId: SessionId
  /** The Workflow instance id: part of every step key, so two drivers never collide. */
  readonly instanceId: string
  /** Hard cap on iterations (each is two steps); default 60. */
  readonly maxIterations?: number
  /**
   * Branch for the shallow-fetch fallback when the session's bad ref is a
   * commit id (sessions started by the CI workflow pin the failing commit).
   * Default: the session's bad ref.
   */
  readonly fallbackBranch?: string
}

/** Output of a `test-k` step (small and JSON-serialisable). */
export type TestStepOutput =
  | { readonly k: number; readonly done: true }
  | {
      readonly k: number
      readonly done: false
      readonly commit: string
      readonly outcome: StepOutcome
      readonly reason: PredicateStepResult["reason"] | "infra" | "recorded"
      readonly durationMs: number
      readonly nodeModules: PredicateStepResult["nodeModules"]
      readonly logTail: string
    }

/** A `test-k` output that observed something. */
export type Observed = Extract<TestStepOutput, { readonly done: false }>

/** Idempotency key of iteration `k` of an instance. */
export const stepKey = (instanceId: string, k: number): string => `${instanceId}:${k}`

const loadOrFail = (store: SessionStore, id: SessionId) =>
  Effect.flatMap(store.load(id), (cur) => (cur === null ? Effect.fail(new NoSuchSession({ sessionId: id })) : Effect.succeed(cur)))

/**
 * Write back keyed observations that `returned` has and R2 lacks (R2 lost a
 * completed write). Idempotent.
 */
export const reconcile = (store: SessionStore, id: SessionId, returned: BisectSession | null) =>
  Effect.gen(function* () {
    if (returned === null) return
    const cur = yield* loadOrFail(store, id)
    const missing = returned.events.filter((e) => e.step !== undefined && !hasStep(cur.session, e.step))
    if (missing.length === 0) return
    yield* modifySession(store, id, (s) =>
      missing.reduce((acc, e) => recordStep(acc, e.step!, e.oid, e.kind === "skip" ? "skip" : e.failed ? "fail" : "pass", e.at), s)
    )
  })

/** One `test-k` step body. */
export const testStep = (params: BisectDriverParams, deps: BisectDriverDeps, k: number, returned: BisectSession | null): Effect.Effect<TestStepOutput, unknown> =>
  Effect.gen(function* () {
    yield* reconcile(deps.sessions, params.sessionId, returned)
    const { session } = yield* loadOrFail(deps.sessions, params.sessionId)
    const key = stepKey(params.instanceId, k)
    const prior = session.events.find((e) => e.step === key)
    if (prior !== undefined) {
      return {
        k,
        done: false,
        commit: prior.oid,
        outcome: prior.kind === "skip" ? "skip" : prior.failed ? "fail" : "pass",
        reason: "recorded",
        durationMs: 0,
        nodeModules: null,
        logTail: ""
      } as const
    }
    const status = sessionStatus(session)
    if (status.done || status.next === null) return { k, done: true } as const
    const commit = status.next.oid
    const creds = yield* deps.credentials(session.repo)
    const input: PredicateStepInput = {
      remote: creds.remote,
      token: creds.token,
      commit,
      branch: params.fallbackBranch ?? session.badRef,
      depth: session.candidates.length + 1,
      command: deps.predicate.command,
      timeoutSec: deps.predicate.timeoutSec,
      ...(deps.predicate.envFor ? { env: deps.predicate.envFor(k) } : {}),
      ...(deps.nodeModules ? { nodeModules: { store: deps.nodeModules, runId: `${params.sessionId}-${key.replaceAll(":", "-")}-${deps.freshId()}` } } : {}),
      ...(deps.predicate.noInstall ? { noInstall: true } : {}),
      ...(deps.predicate.workdir ? { workdir: deps.predicate.workdir } : {})
    }
    const attempts = Math.max(1, deps.infraAttempts ?? 3)
    return yield* Effect.suspend(() => runPredicateStep(deps.sandbox(`bisect-${params.sessionId}-${k}-${deps.freshId()}`), input)).pipe(
      Effect.retry({ schedule: Schedule.exponential(deps.infraBackoff ?? Duration.seconds(1)), times: attempts - 1 }),
      Effect.map((r): TestStepOutput => ({ k, done: false, commit, outcome: r.outcome, reason: r.reason, durationMs: r.durationMs, nodeModules: r.nodeModules, logTail: r.logTail })),
      // The checkout kept failing: this commit is untestable *here*; record a skip rather than a guess.
      Effect.catchTag("PredicateInfraError", (e: PredicateInfraError) =>
        Effect.succeed<TestStepOutput>({ k, done: false, commit, outcome: "skip", reason: "infra", durationMs: 0, nodeModules: null, logTail: `${e.stage}: ${e.detail}` })
      )
    )
  })

/** One `record-k` step body: returns the new session. */
export const recordStepBody = (params: BisectDriverParams, deps: BisectDriverDeps, t: Observed): Effect.Effect<BisectSession, unknown> =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    const s = yield* modifySession(deps.sessions, params.sessionId, (s) => recordStep(s, stepKey(params.instanceId, t.k), t.commit, t.outcome, at))
    if (s === null) return yield* Effect.fail(new NoSuchSession({ sessionId: params.sessionId }))
    return s
  })

/** The final `result` step body. */
export const resultStepBody = (params: BisectDriverParams, deps: BisectDriverDeps): Effect.Effect<BisectResultManifest, unknown> =>
  Effect.gen(function* () {
    const { session } = yield* loadOrFail(deps.sessions, params.sessionId)
    const createdAt = yield* Clock.currentTimeMillis
    return yield* deps.results.create(
      resultFromSession(params.sessionId, session, { predicate: deps.predicate.command, driver: `workflow:${params.instanceId}`, createdAt })
    )
  })

/** Summary of a driver run. */
export interface BisectDriverOutcome {
  readonly result: BisectResultManifest
  readonly iterations: number
  readonly tests: ReadonlyArray<Observed>
}

/**
 * Run the bisection to the end, durably.
 *
 * @param params - Session, instance id, iteration cap.
 * @param step - The Workflows `step` (or the local durable runner).
 * @param deps - Stores, credentials, sandboxes, predicate.
 * @returns The result manifest and the per-step observations.
 */
export const runBisectDriver = async (params: BisectDriverParams, step: StepLike, deps: BisectDriverDeps): Promise<BisectDriverOutcome> => {
  const max = params.maxIterations ?? 60
  const tests: Array<Observed> = []
  let returned: BisectSession | null = null
  let k = 0
  for (; k < max; k++) {
    const prev: BisectSession | null = returned
    const t: TestStepOutput = await step.do<TestStepOutput>(`test-${k}`, () => runPromiseOrThrow(testStep(params, deps, k, prev)))
    if (t.done) break
    tests.push(t)
    const observed: Observed = t
    returned = await step.do<BisectSession>(`record-${k}`, () => runPromiseOrThrow(recordStepBody(params, deps, observed)))
  }
  const result = await step.do<BisectResultManifest>("result", () => runPromiseOrThrow(resultStepBody(params, deps)))
  return { result, iterations: k, tests }
}
