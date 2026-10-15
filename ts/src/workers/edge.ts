/**
 * The deployed Worker module (`wrangler.toml` `main`): the existing state /
 * bisect API (`../worker/index.ts`) plus the bindings only a deployment has.
 *
 * Exports:
 * - `default.fetch`: the API, with the review gate (`result`, `approve`,
 *   `reject`) and `drive` (start the BisectWorkflow for a session) enabled;
 * - `default.queue`: `cf.artifacts.repo.pushed` events delivered to a queue
 *   (**the delivery mechanism and payload are unverified**): one CiWorkflow
 *   instance per pushed branch commit;
 * - `BisectWorkflow`, `CiWorkflow`: the Workflow classes; their bodies are
 *   `../workflows/bisectDriver.ts` and `../workflows/ciDriver.ts` (tested
 *   locally with the same `step.do` replay semantics);
 * - `Sandbox`: the Sandbox SDK Durable Object class (container in
 *   `wrangler.toml`), where every predicate run and note push happens.
 *
 * No Effect program runs at module load: every effect is built and run
 * inside a handler (`runPromiseOrThrow` in the shared code), after the
 * bindings of that invocation are in hand.
 *
 * Excluded from the main `tsconfig.json` (it imports `cloudflare:workers`);
 * type-checked with `tsconfig.edge.json`.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { getSandbox, Sandbox } from "@cloudflare/sandbox"
import { checkoutCredentials, withRepo } from "../bisect/artifactsApi.js"
import { writeNote } from "../bisect/notes.js"
import type { SandboxFactory, SandboxLike } from "../bisect/sandbox.js"
import { Duration, Effect } from "../fx/index.js"
import { SessionId } from "../ids.js"
import { makeR2SessionStore } from "../worker/bisectStore.js"
import type { BisectDeps } from "../worker/bisectRoutes.js"
import { type Env, fetchHandler, workerConfig, writableBucket } from "../worker/index.js"
import { makeR2BindingBlobStore, type R2BinaryBucketLike } from "../worker/r2BindingBlobStore.js"
import { makeR2ResultStore } from "../worker/resultStore.js"
import { type BisectDriverDeps, runBisectDriver } from "../workflows/bisectDriver.js"
import { type CiDriverDeps, parsePushEvent, runCiDriver, startOrLoadSession } from "../workflows/ciDriver.js"

export { Sandbox }

/** A Workflow binding (`env.<WORKFLOW>`). */
interface WorkflowBinding {
  create(options: { readonly id?: string; readonly params?: unknown }): Promise<{ readonly id: string }>
}

/** The deployment's bindings. */
export interface EdgeEnv extends Env {
  readonly Sandbox: unknown
  readonly BISECT_WORKFLOW: WorkflowBinding
  readonly CI_WORKFLOW: WorkflowBinding
  /** Predicate (default `npm test`) and its time budget in seconds (default 600). */
  readonly BISECT_PREDICATE?: string
  readonly BISECT_PREDICATE_TIMEOUT_S?: string
}

const scopeOf = (env: EdgeEnv): string => {
  const cfg = workerConfig(env)
  if (typeof cfg === "string") throw new Error(`worker misconfigured: ${cfg}`)
  return cfg.scope
}

const sandboxes =
  (env: EdgeEnv): SandboxFactory =>
  (id: string): SandboxLike =>
    getSandbox(env.Sandbox, id)

const readCredentials = (env: EdgeEnv) => (repo: string) => {
  const artifacts = env.ARTIFACTS
  if (artifacts === undefined) return Effect.fail(new Error("no ARTIFACTS binding"))
  return Effect.map(withRepo(artifacts, repo, (h) => checkoutCredentials(h, "read", Duration.hours(1))), (c) => ({ remote: c.remote, token: c.token.plaintext }))
}

const randomSuffix = (): string => {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

const predicate = (env: EdgeEnv) => ({ command: env.BISECT_PREDICATE ?? "npm test", timeoutSec: Number(env.BISECT_PREDICATE_TIMEOUT_S ?? "600") })

/** Create a Workflow instance; an instance that already exists (a retried request) is not an error. */
const createInstance = (binding: WorkflowBinding, id: string, params: unknown): Effect.Effect<string, unknown> =>
  Effect.tryPromise({ try: () => binding.create({ id, params }), catch: (e) => e }).pipe(
    Effect.map((i) => i.id),
    Effect.catch((e) => (/already exists|duplicate/i.test(String(e)) ? Effect.succeed(id) : Effect.fail(e)))
  )

const bisectExtra = (env: EdgeEnv): Partial<BisectDeps> => ({
  results: makeR2ResultStore(writableBucket(env)),
  notes: (input) => writeNote(getSandbox(env.Sandbox, `notes-${input.sessionId}-${randomSuffix()}`), input),
  drive: (p) => createInstance(env.BISECT_WORKFLOW, `bisect-${p.sessionId}`, p)
})

/** Parameters of a BisectWorkflow instance. */
interface BisectParams {
  readonly sessionId: string
  readonly fallbackBranch?: string
}

/** The durable bisection (body: `runBisectDriver`). */
export class BisectWorkflow extends WorkflowEntrypoint<EdgeEnv, BisectParams> {
  async run(event: Readonly<WorkflowEvent<BisectParams>>, step: WorkflowStep): Promise<unknown> {
    const env = this.env
    const bucket = writableBucket(env)
    const deps: BisectDriverDeps = {
      sessions: makeR2SessionStore(bucket, scopeOf(env)),
      results: makeR2ResultStore(bucket),
      credentials: readCredentials(env),
      sandbox: sandboxes(env),
      nodeModules: makeR2BindingBlobStore(env.CACHE_BUCKET as unknown as R2BinaryBucketLike),
      predicate: predicate(env),
      freshId: randomSuffix
    }
    const out = await runBisectDriver(
      { sessionId: SessionId(event.payload.sessionId), instanceId: event.instanceId, ...(event.payload.fallbackBranch ? { fallbackBranch: event.payload.fallbackBranch } : {}) },
      step,
      deps
    )
    return { result: out.result, iterations: out.iterations }
  }
}

/** CI on push (body: `runCiDriver`). */
export class CiWorkflow extends WorkflowEntrypoint<EdgeEnv, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    const env = this.env
    const artifacts = env.ARTIFACTS
    if (artifacts === undefined) throw new Error("no ARTIFACTS binding")
    const bucket = writableBucket(env)
    const deps: CiDriverDeps = {
      bucket,
      credentials: readCredentials(env),
      sandbox: sandboxes(env),
      predicate: predicate(env),
      startBisect: startOrLoadSession(artifacts, makeR2SessionStore(bucket, scopeOf(env))),
      launchBisect: (p) => createInstance(env.BISECT_WORKFLOW, `bisect-${p.sessionId}`, p),
      freshId: randomSuffix
    }
    return runCiDriver(event.payload, step, deps)
  }
}

/** A queue message batch (the part used). */
interface MessageBatchLike {
  readonly messages: ReadonlyArray<{ readonly body: unknown; ack(): void; retry(): void }>
}

export default {
  fetch: (request: Request, env: EdgeEnv): Promise<Response> => fetchHandler(request, env, env.ARTIFACTS !== undefined ? bisectExtra(env) : {}),
  queue: async (batch: MessageBatchLike, env: EdgeEnv): Promise<void> => {
    for (const m of batch.messages) {
      try {
        const ev = parsePushEvent(m.body)
        if (ev !== null) {
          const id = `ci-${ev.repo}-${ev.commit}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100)
          await Effect.runPromise(createInstance(env.CI_WORKFLOW, id, m.body))
        }
        m.ack()
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "push event not handled", error: e instanceof Error ? e.name : "unknown" }))
        m.retry()
      }
    }
  }
}
