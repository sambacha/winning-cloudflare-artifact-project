/**
 * The bisect demo, offline: the demo monorepo (`demoRepo.ts`), a directory
 * standing in for R2 (`../fsBucket.ts`), local sandboxes
 * (`../bisect/localSandbox.ts`) and the local durable step runner
 * (`../workflows/localSteps.ts`, journal in a file). It runs exactly the
 * driver the Cloudflare Workflow runs (`../workflows/bisectDriver.ts`):
 * session in "R2", one fresh sandbox per step, checkout by commit id from a
 * `file://` remote, `node_modules` restored from the cache, `npm test` as
 * the predicate.
 *
 * Because the journal and the bucket are files, the process can be killed at
 * any point and started again with the same `--state` directory: the run
 * resumes from the session in the bucket and the journal.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { type BisectSession, type SessionStore, startSession } from "../bisect/session.js"
import { localGitLog } from "../bisect/localGit.js"
import { makeLocalSandbox } from "../bisect/localSandbox.js"
import { makeFsBucket, type FsBucket } from "../fsBucket.js"
import { Effect } from "../fx/index.js"
import { SessionId } from "../ids.js"
import { makeR2SessionStore, type R2PutOptionsLike, type R2WritableBucketLike } from "../worker/bisectStore.js"
import { makeR2ResultStore } from "../worker/resultStore.js"
import { type BisectDriverOutcome, type BisectDriverDeps, runBisectDriver, type StepLike } from "../workflows/bisectDriver.js"
import { fileJournal, makeLocalSteps } from "../workflows/localSteps.js"
import { DEMO, makeDemoRepo } from "./demoRepo.js"

/**
 * The Workers R2 `get` / conditional `put` shape over a filesystem bucket.
 * A put refused by its condition resolves to `null`, like the binding; a put
 * without a condition is refused (every bisect write is conditional).
 *
 * @param b - The filesystem bucket.
 */
export const fsWritableBucket = (b: FsBucket): R2WritableBucketLike => ({
  get: async (key) => {
    const o = await b.getBytes(key)
    return o === null ? null : { etag: o.etag, text: async () => new TextDecoder().decode(o.body) }
  },
  put: async (key: string, value: string, options?: R2PutOptionsLike) => {
    const body = new TextEncoder().encode(value)
    const c = options?.onlyIf
    const refused = (e: unknown) => {
      if (typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "Rejected" && (e as { kind?: string }).kind === "precondition") return null
      throw e
    }
    if (c instanceof Headers && c.get("If-None-Match") === "*") return b.putIfNoneMatchBytes(key, body).then((etag) => ({ etag }), refused)
    if (c !== undefined && !(c instanceof Headers) && c.etagMatches !== undefined) return b.putIfMatchBytes(key, c.etagMatches, body).then((etag) => ({ etag }), refused)
    throw new Error(`unconditional write to ${key} refused: every bisect write must be conditional`)
  }
})

/** Options of {@link runLocalBisectDemo}. */
export interface LocalBisectDemoOptions {
  /** State directory: demo repo, bucket, journal, sandboxes. Reused across restarts. */
  readonly state: string
  /** Seed prefix: step `k` runs the predicate with `DEMO_SEED=<seed>-<k>`. */
  readonly seed: string
  /** Predicate time budget (the hanging commit costs this much). */
  readonly timeoutSec?: number
  /** Restore `node_modules` through the R2 cache (default true). */
  readonly nodeModulesCache?: boolean
  /** Session / instance id (default `demo`). */
  readonly sessionId?: string
  /** Use known rates (new 0.8, old 0) instead of the default Beta priors (default true). */
  readonly knownRates?: boolean
  /** Wrap the durable `step` (e.g. to log or to stop the process). */
  readonly wrapStep?: (s: StepLike) => StepLike
  /** Extra environment for every sandbox command (e.g. Git config to force the fetch fallback). */
  readonly sandboxEnv?: Record<string, string>
}

/** Paths and stores of a demo state directory. */
export const demoState = (state: string) => {
  const repo = path.join(state, "repo")
  const bucket = makeFsBucket(path.join(state, "bucket"), { rateLimitMs: 0 })
  return { repo, bucket, r2: fsWritableBucket(bucket), journal: (sessionId: string) => path.join(state, `journal-${sessionId}.json`), sandboxes: path.join(state, "sandboxes") }
}

/** Create the demo repository (once) and the session (once). */
export const prepareDemo = async (o: LocalBisectDemoOptions): Promise<{ readonly sessions: SessionStore; readonly session: BisectSession }> => {
  const st = demoState(o.state)
  if (!existsSync(path.join(st.repo, ".git"))) makeDemoRepo(st.repo)
  const sessions = makeR2SessionStore(st.r2, "demo")
  const id = SessionId(o.sessionId ?? "demo")
  const existing = await Effect.runPromise(sessions.load(id))
  if (existing !== null) return { sessions, session: existing.session }
  const root = execFileSync("git", ["rev-list", "--max-parents=0", "main"], { cwd: st.repo }).toString().trim()
  const known = o.knownRates ?? true
  // The same range resolution as the Worker: `commitRange` pins `main` to a commit, then pages first-parent history.
  const session = await Effect.runPromise(
    startSession(localGitLog(st.repo), {
      repo: "demo",
      goodRef: root,
      badRef: "main",
      ...(known ? { newRate: { kind: "known" as const, p: DEMO.flakeRate }, oldRate: { kind: "known" as const, p: 0 } } : {}),
      now: 0
    })
  )
  await Effect.runPromise(sessions.create(id, session))
  return { sessions, session }
}

/**
 * Run (or resume) the demo bisection to the end.
 *
 * @param o - State directory, seed and options.
 * @returns The driver outcome (result manifest and the observations of this process).
 */
export const runLocalBisectDemo = async (o: LocalBisectDemoOptions): Promise<BisectDriverOutcome & { readonly ran: ReadonlyArray<string>; readonly replayed: ReadonlyArray<string> }> => {
  const st = demoState(o.state)
  const { sessions } = await prepareDemo(o)
  mkdirSync(st.sandboxes, { recursive: true })
  let n = 0
  const workdir = path.join(st.sandboxes, "current", "repo")
  const deps: BisectDriverDeps = {
    sessions,
    results: makeR2ResultStore(st.r2),
    credentials: () => Effect.succeed({ remote: `file://${path.resolve(st.repo)}`, token: "local-read-token" }),
    sandbox: () => makeLocalSandbox({ scratch: path.join(st.sandboxes, "current"), ...(o.sandboxEnv ? { baseEnv: { ...baseEnv(), ...o.sandboxEnv } } : {}) }),
    ...(o.nodeModulesCache === false ? {} : { nodeModules: st.bucket.blobStore }),
    predicate: { command: "npm test", timeoutSec: o.timeoutSec ?? 10, envFor: (k) => ({ DEMO_SEED: `${o.seed}-${k}` }), workdir },
    freshId: () => `${process.pid}-${++n}`
  }
  const steps = makeLocalSteps({ journal: fileJournal(st.journal(o.sessionId ?? "demo")) })
  const out = await runBisectDriver({ sessionId: SessionId(o.sessionId ?? "demo"), instanceId: o.sessionId ?? "demo" }, o.wrapStep ? o.wrapStep(steps) : steps, deps)
  return { ...out, ran: steps.ran, replayed: steps.replayed }
}

const baseEnv = (): Record<string, string> =>
  Object.fromEntries((["PATH", "HOME", "LANG", "TMPDIR", "npm_config_cache"] as const).flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : [])))
