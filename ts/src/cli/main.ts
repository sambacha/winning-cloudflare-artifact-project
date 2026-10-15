/**
 * `cobuild`: cooperative builds over Cloudflare R2 (or a local directory).
 *
 *   cobuild run --plan cobuild.json [--job ID] [--context CTX] [store] [lock] [--events FILE]
 *               [--metrics-json FILE] [--artifacts-repo NAME] [--workdir DIR] [--quiet]
 *   cobuild status --context CTX [store] [--cache]
 *   cobuild serve [--port 8787] [store]        the Worker's state API, locally (for `tui --live`)
 *   cobuild cache save    --name NAME --path P[,P…] [--hash-files F[,F…]] [store]
 *   cobuild cache restore --name NAME --path P[,P…] [--hash-files F[,F…]] [store] [--fail-on-miss]
 *   cobuild artifacts publish --repo NAME --file FILE [--dest PATH] [--message MSG]
 *
 * store:   --store r2 | fs:<dir> | memory    (default: COBUILD_STORE, else r2 when R2_* is set)
 *          r2 uses R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT or R2_ACCOUNT_ID
 *          --scope SCOPE or COBUILD_SCOPE: required, there is no default (a
 *          missing scope must not silently write into the trusted cache)
 *          COBUILD_FS_RATE_LIMIT_MS: non-negative integer (default 1000)
 * lock:    --lease-ms N (30000) --renew-ms N (10000) --poll-ms N (2000) --max-latency-ms N (2000;
 *          also the hard per-request time limit on lock requests, 0 = no limit)
 *          --max-skew-ms N (1000) --failure-shelf-ms N (1800000)
 * builds:  --op-timeout-ms N: kill a command (its process group) after N ms and
 *          fail the operation (default: none; a plan operation's `timeoutMs`
 *          overrides it). Commands never see R2_*, CLOUDFLARE_*, AWS_* or the
 *          API token variables (extra names: COBUILD_STRIP_ENV=A,B).
 *
 * Environment names from the Rush proposal are honoured: RUSH_COBUILD_CONTEXT
 * (else GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT), RUSH_COBUILD_ENABLED (opt-in, as
 * in the proposal: `1`/`true`/`yes` joins the cooperative lock; unset or
 * `0`/`false`/`no` builds everything locally, no lock, still using the cache;
 * anything else is a usage error), COBUILD_JOB_ID (else GITHUB_JOB plus
 * RUNNER_NAME, else host-pid).
 *
 * `deps.signal` (SIGINT/SIGTERM in `bin.ts`) interrupts a run: running
 * commands are killed and held locks are abandoned, so other jobs take over
 * at once instead of waiting out the lease; the exit status is then 130.
 *
 * Exit status: 0 success (for `cache restore`: hit or miss), 1 an operation
 * failed / was skipped / the cache missed with --fail-on-miss, 2 usage or
 * configuration error.
 *
 * Every dependency is injected, so `main` is tested in-process; `bin.ts` is
 * the process entry point.
 */
import { createServer } from "node:http"
import { hostname } from "node:os"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { Data, Duration, Effect } from "../fx/index.js"
import { JobId } from "../ids.js"
import { makeArtifactsRestClient } from "../bisect/artifactsRest.js"
import type { Exec } from "../bisect/localGit.js"
import { type BlobStore, makeMemoryBlobStore } from "../cache/blobStore.js"
import { formatDigest } from "../cache/digest.js"
import { computeLookupDigests } from "../cache/lookupKey.js"
import { publish } from "../cache/publish.js"
import { makeR2BlobStore } from "../cache/r2BlobStore.js"
import { restore } from "../cache/restore.js"
import { isValidScope, makeScope } from "../cache/scope.js"
import { InvalidPlan, type JobSummary, type RunnerEvent, runJob } from "../demo/runner.js"
import { makeFsBucket } from "../fsBucket.js"
import { makeMemoryStore } from "../memoryStore.js"
import { snapshotMetrics, withStoreMetrics } from "../metrics.js"
import { makeR2S3Client, makeS3BucketView, r2ConfigFromEnv } from "../r2Client.js"
import { makeR2Store } from "../r2Store.js"
import { secret, secretFromConfig } from "../secrets.js"
import { withRequestTimeout } from "../storeTimeout.js"
import type { ObjectStore } from "../store.js"
import { handle } from "../worker/handler.js"
import type { R2BucketLike } from "../worker/r2Bucket.js"
import { publishToArtifacts } from "./artifactsPublish.js"
import { collectOutputs, hashInputs, makeWorkspaceStaging, parsePlan, planDigests, readFailureLog, toRunnerOps, workspaceHooks } from "./workspace.js"

export interface CobuildCliDeps {
  readonly env: Record<string, string | undefined>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly cwd: string
  readonly fetch?: typeof fetch
  readonly exec?: Exec
  /** Raw command output of builds (default: `err`). */
  readonly echo?: (chunk: string) => void
  /** Aborting it interrupts `run` (locks are abandoned, commands killed). */
  readonly signal?: AbortSignal
}

export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {
  override readonly name = "UsageError"
  /** @param message - Human-readable description. */
  constructor(message: string) {
    super({ message })
  }
}

/** The run was interrupted through `deps.signal` (exit status 130). */
export class Interrupted extends Data.TaggedError("Interrupted")<{ readonly message: string }> {
  override readonly name = "Interrupted"
  constructor() {
    super({ message: "interrupted: running commands killed, held locks abandoned" })
  }
}

interface Args {
  readonly positional: ReadonlyArray<string>
  readonly flags: ReadonlyMap<string, string>
  readonly switches: ReadonlySet<string>
}

const SWITCHES = new Set(["--cache", "--fail-on-miss", "--quiet", "--help"])

export const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const positional: Array<string> = []
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      if (SWITCHES.has(a)) {
        switches.add(a)
        continue
      }
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`)
      flags.set(a, v)
      i++
    } else positional.push(a)
  }
  return { positional, flags, switches }
}

const numFlag = (a: Args, name: string, dflt: number): number => {
  const v = a.flags.get(name)
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`${name} expects a non-negative integer, got ${v}`)
  return n
}

/** A `--*-ms` flag as a `Duration` (non-negative whole milliseconds; `dflt` when absent). */
const msFlag = (a: Args, name: string, dflt: Duration.Duration): Duration.Duration => Duration.millis(numFlag(a, name, Duration.toMillis(dflt)))

/** A non-negative integer environment variable (`dflt` when unset or empty). */
export const envNonNegInt = (env: Record<string, string | undefined>, name: string, dflt: number): number => {
  const v = env[name]
  if (v === undefined || v.trim() === "") return dflt
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`${name} expects a non-negative integer, got ${JSON.stringify(v)}`)
  return n
}

/** RUSH_COBUILD_ENABLED: opt-in; unset means disabled. */
export const cobuildsEnabled = (env: Record<string, string | undefined>): boolean => {
  const v = (env["RUSH_COBUILD_ENABLED"] ?? "").trim().toLowerCase()
  if (["", "0", "false", "no", "off"].includes(v)) return false
  if (["1", "true", "yes", "on"].includes(v)) return true
  throw new UsageError(`RUSH_COBUILD_ENABLED expects 1/true/yes or 0/false/no, got ${JSON.stringify(env["RUSH_COBUILD_ENABLED"])}`)
}

const nonEmpty = (v: string | undefined) => (v !== undefined && v !== "" ? v : undefined)

export interface Stores {
  readonly lockStore: ObjectStore
  readonly blobStore: BlobStore
  /** Listing view for `status` (absent for `memory`). */
  readonly view: R2BucketLike | null
  readonly describe: string
}

/** Pick the backend: `--store`, else `COBUILD_STORE`, else R2 when configured. */
export const selectStores = (spec: string | undefined, env: Record<string, string | undefined>, cwd: string): Stores => {
  const s = spec ?? nonEmpty(env["COBUILD_STORE"])
  if (s === "memory") {
    return { lockStore: makeMemoryStore(), blobStore: makeMemoryBlobStore(), view: null, describe: "memory (this process only)" }
  }
  if (s !== undefined && s.startsWith("fs:")) {
    const dir = path.resolve(cwd, s.slice(3))
    const rate = envNonNegInt(env, "COBUILD_FS_RATE_LIMIT_MS", 1000)
    const b = makeFsBucket(dir, { rateLimitMs: rate })
    return { lockStore: b.objectStore, blobStore: b.blobStore, view: b, describe: `fs:${dir}` }
  }
  if (s !== undefined && s !== "r2") throw new UsageError(`--store expects r2, fs:<dir> or memory, got ${s}`)
  const cfg = r2ConfigFromEnv(env)
  if (cfg === null) {
    throw new UsageError("no store configured: set R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID (or R2_ENDPOINT), or pass --store fs:<dir>")
  }
  const blobClient = makeR2S3Client(cfg, "blob")
  return {
    lockStore: makeR2Store(makeR2S3Client(cfg, "lock"), cfg.bucket),
    blobStore: makeR2BlobStore(blobClient, cfg.bucket),
    view: makeS3BucketView(blobClient, cfg.bucket),
    describe: `r2:${cfg.bucket}`
  }
}

const scopeOf = (a: Args, env: Record<string, string | undefined>) => {
  const scope = a.flags.get("--scope") ?? nonEmpty(env["COBUILD_SCOPE"])
  if (scope === undefined) {
    throw new UsageError('no cache scope: pass --scope or set COBUILD_SCOPE (e.g. "trusted" for protected-branch builds, "pr" for pull requests)')
  }
  if (!isValidScope(scope)) throw new UsageError(`invalid scope ${JSON.stringify(scope)} (expected [a-z0-9][a-z0-9-]{0,62})`)
  return scope
}

const contextOf = (a: Args, env: Record<string, string | undefined>) => {
  const c =
    a.flags.get("--context") ??
    nonEmpty(env["RUSH_COBUILD_CONTEXT"]) ??
    (nonEmpty(env["GITHUB_RUN_ID"]) !== undefined ? `${env["GITHUB_RUN_ID"]}-${nonEmpty(env["GITHUB_RUN_ATTEMPT"]) ?? "1"}` : undefined)
  if (c === undefined) throw new UsageError("no cobuild context: pass --context or set RUSH_COBUILD_CONTEXT (e.g. the CI build id)")
  return c
}

/** The job id: `--job`, `COBUILD_JOB_ID`, `GITHUB_JOB@RUNNER_NAME`, or `host-pid` (branded here, where it enters). */
const jobOf = (a: Args, env: Record<string, string | undefined>): JobId => {
  const github = nonEmpty(env["GITHUB_JOB"]) !== undefined ? `${env["GITHUB_JOB"]}${nonEmpty(env["RUNNER_NAME"]) !== undefined ? `@${env["RUNNER_NAME"]}` : ""}` : undefined
  return JobId(a.flags.get("--job") ?? nonEmpty(env["COBUILD_JOB_ID"]) ?? github ?? `${hostname()}-${process.pid}`)
}

const describeEvent = (e: RunnerEvent): string => {
  switch (e.kind) {
    case "build-start":
      return `BUILD     ${e.op}  (lock ${e.lockKey.slice(0, 19)}…)`
    case "built":
      return `PUBLISHED ${e.op}`
    case "build-failed":
      return `FAILED    ${e.op}  (failure marker published)`
    case "restored":
      return `RESTORED  ${e.op}  (built by another job, ${e.bytes} bytes verified)`
    case "cache-hit":
      return `CACHE HIT ${e.op}  (${e.bytes} bytes verified)`
    case "failed-elsewhere":
      return `FAILED    ${e.op}  (failed in another job${e.logKey !== null ? "; log follows" : ""})`
    case "pending":
      return `WAITING   ${e.op}  (held by ${e.owner ?? "another job"})`
    case "skipped":
      return `SKIPPED   ${e.op}  (dependency ${e.failedDep} failed)`
    case "lock-lost":
      return `LOCK LOST ${e.op}  (lease taken over; will retry)`
  }
}

const runCmd = async (a: Args, deps: CobuildCliDeps): Promise<number> => {
  const planFile = a.flags.get("--plan") ?? "cobuild.json"
  const workdir = path.resolve(deps.cwd, a.flags.get("--workdir") ?? ".")
  const plan = parsePlan(JSON.parse(await readFile(path.resolve(deps.cwd, planFile), "utf8")))
  const enabled = cobuildsEnabled(deps.env)
  const scope = scopeOf(a, deps.env)
  const context = contextOf(a, deps.env)
  const jobId = jobOf(a, deps.env)
  const stores = selectStores(a.flags.get("--store"), deps.env, deps.cwd)
  const maxLatency = msFlag(a, "--max-latency-ms", Duration.seconds(2))
  // Cobuilds disabled: a private in-memory lock, so every operation is built (or restored from cache) here.
  // Enabled: every lock request is cut off after maxLatency (audit B-3), which makes the configuration
  // predicate's latency assumption true; a cut-off request is an ambiguous StoreFailure that the lock reconciles.
  // Metrics wrap the time limit, so timed-out requests are counted (`cobuild_store_requests`, outcome `timeout`).
  const lockStore = enabled
    ? withStoreMetrics(Duration.toMillis(maxLatency) > 0 ? withRequestTimeout(stores.lockStore, maxLatency) : stores.lockStore)
    : makeMemoryStore()
  const keyEnv = { flushSalt: plan.flushSalt, toolchain: `${plan.toolchain}|${process.platform}-${process.arch}` }
  const digests = await planDigests(workdir, plan, keyEnv)
  const opTimeout = msFlag(a, "--op-timeout-ms", Duration.zero)
  const eventsFile = a.flags.get("--events")
  const quiet = a.switches.has("--quiet")
  const logs: Array<Promise<void>> = []
  const startedAt = Date.now()
  const echo = deps.echo ?? ((c: string) => deps.err(c.replace(/\n$/, "")))
  deps.err(`[cobuild] job ${jobId}, context ${context}, scope ${scope}, store ${stores.describe}${enabled ? "" : " (cobuilds disabled)"}`)
  const onEvent = (e: RunnerEvent) => {
    deps.err(`[${e.job}] ${describeEvent(e)}`)
    if (eventsFile !== undefined) logs.push(appendFile(path.resolve(deps.cwd, eventsFile), `${JSON.stringify({ ...e, context, wallMs: Date.now() })}\n`))
    if (e.kind === "failed-elsewhere" && e.logKey !== null) {
      logs.push(
        Effect.runPromise(readFailureLog(stores.blobStore, e.logKey)).then((log) => {
          if (log !== null) deps.err(log)
        })
      )
    }
  }
  const summary: JobSummary = await Effect.runPromise(
    runJob(
      {
        ops: toRunnerOps(plan),
        lockStore,
        blobStore: stores.blobStore,
        cobuild: {
          scope,
          context,
          lease: msFlag(a, "--lease-ms", Duration.seconds(30)),
          renewInterval: msFlag(a, "--renew-ms", Duration.seconds(10)),
          maxLatency,
          maxSkew: msFlag(a, "--max-skew-ms", Duration.seconds(1)),
          failureShelf: msFlag(a, "--failure-shelf-ms", Duration.minutes(30))
        },
        keyEnv,
        pollInterval: msFlag(a, "--poll-ms", Duration.seconds(2)),
        onEvent,
        cacheFirst: true,
        hooks: workspaceHooks({
          workdir,
          plan,
          digests,
          blobStore: stores.blobStore,
          scope,
          baseEnv: deps.env,
          ...(Duration.toMillis(opTimeout) > 0 ? { opTimeout } : {}),
          ...(quiet ? {} : { echo: (_op, c) => echo(c) })
        })
      },
      { jobId, order: plan.operations.map((o) => o.name) }
    ),
    deps.signal !== undefined ? { signal: deps.signal } : undefined
  ).catch((e: unknown) => {
    if (deps.signal?.aborted === true) throw new Interrupted()
    throw e
  })
  await Promise.all(logs)
  const operations = plan.operations.map((o) => ({ name: o.name, lookup: formatDigest(digests.get(o.name)!), outcome: summary.outcomes.get(o.name)! }))
  const report = { context, job: jobId, scope, store: stores.describe, startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, operations }
  deps.out(JSON.stringify(report, null, 2))
  const metricsFile = a.flags.get("--metrics-json")
  if (metricsFile !== undefined) {
    const metrics = await Effect.runPromise(snapshotMetrics)
    await writeFile(path.resolve(deps.cwd, metricsFile), `${JSON.stringify({ context, job: jobId, ...metrics }, null, 2)}\n`)
  }
  const ok = operations.every((o) => o.outcome === "built" || o.outcome === "restored")
  const repo = a.flags.get("--artifacts-repo")
  if (repo !== undefined) {
    const r = await publishToArtifacts({
      client: artifactsClient(deps),
      repo,
      path: `runs/${context}/${jobId}.json`.replace(/[^A-Za-z0-9._/-]/g, "_"),
      content: `${JSON.stringify(report, null, 2)}\n`,
      message: `cobuild ${context}: ${jobId} (${operations.length} operations, ${ok ? "ok" : "failed"})`,
      ...(deps.exec !== undefined ? { exec: deps.exec } : {})
    })
    deps.err(`[cobuild] Artifacts: ${r.repo} @ ${r.branch} ${r.commit} ${r.verified ? "(verified in log)" : "(NOT found in log)"}`)
    if (!r.verified) return 1
  }
  return ok ? 0 : 1
}

const artifactsClient = (deps: CobuildCliDeps) => {
  const accountId = nonEmpty(deps.env["CLOUDFLARE_ACCOUNT_ID"])
  const apiToken = secretFromConfig(deps.env["CLOUDFLARE_API_TOKEN"])
  if (accountId === undefined || apiToken === undefined) {
    throw new UsageError("Artifacts needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (and ARTIFACTS_NAMESPACE, default \"default\")")
  }
  const apiBase = nonEmpty(deps.env["ARTIFACTS_API_BASE"])
  return makeArtifactsRestClient({
    accountId,
    apiToken,
    namespace: nonEmpty(deps.env["ARTIFACTS_NAMESPACE"]) ?? "default",
    ...(deps.fetch !== undefined ? { fetch: (url, init) => deps.fetch!(url, init) } : {}),
    ...(apiBase !== undefined ? { apiBase } : {})
  })
}

const statusCmd = async (a: Args, deps: CobuildCliDeps): Promise<number> => {
  const scope = scopeOf(a, deps.env)
  const stores = selectStores(a.flags.get("--store"), deps.env, deps.cwd)
  if (stores.view === null) throw new UsageError("status needs a shared store (r2 or fs:<dir>)")
  const route = a.switches.has("--cache") ? "/api/cache" : `/api/locks?context=${encodeURIComponent(contextOf(a, deps.env))}`
  // The Worker's own handler, run locally over the store's listing view: same JSON as the deployed Worker.
  const res = await handle(new Request(`http://cobuild.local${route}`, { headers: { authorization: "Bearer local" } }), stores.view, {
    scope,
    token: secret("local"),
    now: () => Date.now()
  })
  deps.out(await res.text())
  return res.ok ? 0 : 1
}

/**
 * Serve the Worker's state API (`GET /api/locks`, `GET /api/cache`) from this
 * machine over the selected store, so the dashboard's `--live` mode works
 * before (or without) deploying the Worker. Requires the same bearer token
 * (`COBUILDS_API_TOKEN`). Resolves when the server closes.
 */
const serveCmd = async (a: Args, deps: CobuildCliDeps): Promise<number> => {
  const scope = scopeOf(a, deps.env)
  const token = secretFromConfig(deps.env["COBUILDS_API_TOKEN"])
  if (token === undefined) throw new UsageError("serve needs COBUILDS_API_TOKEN (the dashboard sends it as a bearer token)")
  const stores = selectStores(a.flags.get("--store"), deps.env, deps.cwd)
  const view = stores.view
  if (view === null) throw new UsageError("serve needs a shared store (r2 or fs:<dir>)")
  const port = numFlag(a, "--port", 8787)
  const server = createServer((req, res) => {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
    const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method ?? "GET", headers })
    handle(request, view, { scope, token, now: () => Date.now() })
      .then(async (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()))
        res.end(await r.text())
      })
      .catch((e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" })
        deps.err(`[cobuild] serve: ${req.method ?? "GET"} ${req.url ?? "/"} failed: ${String(e)}`)
        res.end(JSON.stringify({ error: "internal error" }))
      })
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  deps.err(`[cobuild] state API for ${stores.describe} on http://127.0.0.1:${port} (GET /api/locks?context=…, /api/cache)`)
  const closed = new Promise<void>((resolve) => server.on("close", resolve))
  const stop = () => {
    server.close()
    server.closeAllConnections()
  }
  if (deps.signal?.aborted === true) stop()
  deps.signal?.addEventListener("abort", stop, { once: true })
  await closed
  return 0
}

/** Lookup digest of a named cache entry over the content of `hashFiles`. */
const cacheLookup = async (workdir: string, name: string, hashFiles: ReadonlyArray<string>, paths: ReadonlyArray<string>) => {
  const op = { name, deps: [], command: `cache:${name}`, inputs: hashFiles, outputs: paths }
  const inputs = await hashInputs(workdir, op)
  return { op, lookup: computeLookupDigests({ flushSalt: "cache-v1", toolchain: `${process.platform}-${process.arch}` }, new Map([[name, { inputs, deps: [] }]])).get(name)! }
}

const listOf = (v: string | undefined) => (v === undefined ? [] : v.split(",").map((s) => s.trim()).filter((s) => s.length > 0))

const cacheCmd = async (sub: string | undefined, a: Args, deps: CobuildCliDeps): Promise<number> => {
  const name = a.flags.get("--name")
  const paths = listOf(a.flags.get("--path"))
  if (name === undefined || paths.length === 0) throw new UsageError("cache save|restore needs --name and --path")
  const workdir = path.resolve(deps.cwd, a.flags.get("--workdir") ?? ".")
  const scope = makeScope(scopeOf(a, deps.env))
  const stores = selectStores(a.flags.get("--store"), deps.env, deps.cwd)
  const plan = parsePlan({ operations: [{ name, command: `cache:${name}`, inputs: listOf(a.flags.get("--hash-files")), outputs: paths }] })
  const { op, lookup } = await cacheLookup(workdir, name, plan.operations[0]!.inputs, paths)
  const output = async (k: string, v: string) => {
    const f = nonEmpty(deps.env["GITHUB_OUTPUT"])
    if (f !== undefined) await appendFile(f, `${k}=${v}\n`)
  }
  if (sub === "save") {
    const files = await collectOutputs(workdir, op)
    const r = await Effect.runPromise(publish({ store: stores.blobStore, job: { scope }, lookup, files, buildMs: 0, now: Date.now() }))
    deps.out(JSON.stringify({ name, key: formatDigest(lookup), files: files.length, bytes: files.reduce((n, f) => n + f.bytes.length, 0), result: r }))
    await output("cache-key", formatDigest(lookup))
    return 0
  }
  if (sub === "restore") {
    const r = await Effect.runPromise(
      restore({ store: stores.blobStore, policy: { trusted: [makeScope("trusted")] }, job: { scope }, lookup, staging: makeWorkspaceStaging(workdir, paths) })
    )
    const hit = r.outcome === "hit"
    deps.out(JSON.stringify({ name, key: formatDigest(lookup), hit, ...(r.outcome === "hit" ? { bytes: r.bytes } : { reason: r.reason }) }))
    await output("cache-hit", String(hit))
    return hit || !a.switches.has("--fail-on-miss") ? 0 : 1
  }
  throw new UsageError("cache needs save or restore")
}

const artifactsCmd = async (sub: string | undefined, a: Args, deps: CobuildCliDeps): Promise<number> => {
  if (sub !== "publish") throw new UsageError("artifacts needs publish")
  const repo = a.flags.get("--repo")
  const file = a.flags.get("--file")
  if (repo === undefined || file === undefined) throw new UsageError("artifacts publish needs --repo and --file")
  const content = await readFile(path.resolve(deps.cwd, file), "utf8")
  const r = await publishToArtifacts({
    client: artifactsClient(deps),
    repo,
    path: a.flags.get("--dest") ?? path.basename(file),
    content,
    message: a.flags.get("--message") ?? `cobuild: ${path.basename(file)}`,
    ...(deps.exec !== undefined ? { exec: deps.exec } : {})
  })
  deps.out(JSON.stringify(r))
  return r.verified ? 0 : 1
}

const HELP = `usage:
  cobuild run --plan cobuild.json --scope SCOPE [--job ID] [--context CTX] [--store r2|fs:<dir>|memory] [--events FILE]
              [--op-timeout-ms N] [--metrics-json FILE] [--artifacts-repo NAME]   (cooperation needs RUSH_COBUILD_ENABLED=1)
  cobuild status --context CTX [--store …] [--cache]
  cobuild serve [--port 8787] [--store …]
  cobuild cache save|restore --name NAME --path P[,P…] [--hash-files F[,F…]] [--store …] [--fail-on-miss]
  cobuild artifacts publish --repo NAME --file FILE [--dest PATH] [--message MSG]`

export const main = async (argv: ReadonlyArray<string>, deps: CobuildCliDeps): Promise<number> => {
  try {
    const a = parseArgs(argv)
    const [cmd, sub] = a.positional
    if (cmd === undefined || a.switches.has("--help")) {
      deps.out(HELP)
      return cmd === undefined && !a.switches.has("--help") ? 2 : 0
    }
    switch (cmd) {
      case "run":
        return await runCmd(a, deps)
      case "status":
        return await statusCmd(a, deps)
      case "serve":
        return await serveCmd(a, deps)
      case "cache":
        return await cacheCmd(sub, a, deps)
      case "artifacts":
        return await artifactsCmd(sub, a, deps)
      default:
        throw new UsageError(`unknown command ${cmd}`)
    }
  } catch (e) {
    if (e instanceof Interrupted) {
      deps.err(`cobuild: ${e.message}`)
      return 130
    }
    if (e instanceof UsageError || e instanceof InvalidPlan || (e instanceof Error && e.name === "R2ConfigError")) {
      deps.err(`cobuild: ${e.message}`)
      return 2
    }
    deps.err(`cobuild: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return 1
  }
}
