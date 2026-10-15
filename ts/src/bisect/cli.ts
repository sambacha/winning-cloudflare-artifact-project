/**
 * `bayesect`: Bayesian `git bisect` for flaky failures, over a local Git
 * repository, a Cloudflare Artifacts repository (REST API), or a session
 * held by the cobuilds Worker.
 *
 *   bayesect run  --good <ref> --bad <ref> [source] [model] [runner] -- <test command…>
 *   bayesect start --good <ref> --bad <ref> [source] [model]     (manual mode, state in --state file)
 *   bayesect status | next
 *   bayesect fail [commit] | pass [commit] | skip [commit] | undo
 *   bayesect worker --url <worker> --session <id> -- <test command…>
 *
 * source:  --repo-dir <dir> (default ".")  |  --artifacts <repo name>
 *          (Artifacts uses CLOUDFLARE_ACCOUNT_ID, ARTIFACTS_NAMESPACE, CLOUDFLARE_API_TOKEN)
 * model:   --old-rate beta:A,B | known:P   (default beta:1,3)
 *          --new-rate beta:A,B | known:P   (default beta:3,1)
 *          --confidence C (default 0.95)  --max-steps N (default 200)
 * runner:  --timeout <seconds> --on-timeout fail|skip|abort (default abort)  --clean
 *
 * The test command's exit status follows `git bisect run`: 0 = pass (bug not
 * seen), 125 = skip, 1–127 = fail (bug seen), ≥ 128 = abort.
 *
 * Every dependency (environment, output, clock, Git, fetch) is injected, so
 * `main` is tested in-process.
 *
 * Effect structure: each command is an effect ({@link program}); `main` runs
 * it with `runPromiseOrThrow` and maps the failure to an exit status
 * (`UsageError` → 2, anything else → 1). Test runners are scoped resources
 * (`Effect.scoped`), so worktrees and clones are removed on every exit.
 *
 * @packageDocumentation
 */
import { readFile, writeFile } from "node:fs/promises"
import type { CommitInfo } from "./artifactsApi.js"
import { callUpstream, checkoutCredentials, validate, withRepo } from "./artifactsApi.js"
import { makeArtifactsRestClient } from "./artifactsRest.js"
import type { CommitLog } from "./artifacts.js"
import { driveRemoteSession, driveSession, makeBisectApiClient } from "./drive.js"
import type { RunOutcome } from "./engine.js"
import { type Exec, exec as realExec, localCommandRunner, localGitLog, remoteCommandRunner, type TimeoutPolicy } from "./localGit.js"
import { checkRate, InvalidModel, type Rate } from "./model.js"
import {
  type BisectSession,
  parseSession,
  recordResult,
  recordSkip,
  type SessionStatus,
  sessionStatus,
  startSession,
  undoLast
} from "./session.js"
import { Data, Duration, Effect, runPromiseOrThrow } from "../fx/index.js"
import { secret, secretFromConfig } from "../secrets.js"

export interface CliDeps {
  readonly env: Record<string, string | undefined>
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly now: () => number
  readonly exec?: Exec
  readonly fetch?: typeof fetch
  readonly cwd?: string
  /** Aborting it interrupts the running command (its scoped resources are released); `main` then returns 130. */
  readonly signal?: AbortSignal
}

/** A malformed invocation (exit status 2). */
export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {
  override readonly name = "UsageError"
  /** @param message - What is wrong with the arguments. */
  constructor(message: string) {
    super({ message })
  }
}

/** Runs a synchronous check (which throws its documented error) inside an effect. */
const check = <A>(f: () => A): Effect.Effect<A, unknown> => validate<A, unknown>(f)

interface Parsed {
  readonly command: string
  readonly flags: Map<string, string | true>
  readonly positional: string[]
  readonly rest: string[]
}

const BOOLEAN_FLAGS = new Set(["clean", "help"])

export const parseArgs = (argv: ReadonlyArray<string>): Parsed => {
  const dd = argv.indexOf("--")
  const head = dd < 0 ? [...argv] : argv.slice(0, dd)
  const rest = dd < 0 ? [] : argv.slice(dd + 1)
  const [command = "help", ...tail] = head
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      if (eq >= 0) flags.set(name, a.slice(eq + 1))
      else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true)
      else {
        const v = tail[++i]
        if (v === undefined) throw new UsageError(`--${name} needs a value`)
        flags.set(name, v)
      }
    } else positional.push(a)
  }
  return { command, flags, positional, rest }
}

/** `beta:A,B` or `known:P`. */
export const parseRate = (s: string): Rate => {
  const known = /^known:([0-9.eE+-]+)$/.exec(s)
  if (known) return { kind: "known", p: Number(known[1]) }
  const beta = /^beta:([0-9.eE+-]+),([0-9.eE+-]+)$/.exec(s)
  if (beta) return { kind: "beta", alpha: Number(beta[1]), beta: Number(beta[2]) }
  throw new UsageError(`rate must be beta:A,B or known:P, got ${JSON.stringify(s)}`)
}

const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name)
  if (v === true) throw new UsageError(`--${name} needs a value`)
  return v
}

const need = (p: Parsed, name: string): string => {
  const v = str(p, name)
  if (v === undefined) throw new UsageError(`missing --${name}`)
  return v
}

const num = (p: Parsed, name: string): number | undefined => {
  const v = str(p, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`)
  return n
}

/**
 * Every usage-level check for the commands that open a repository, run
 * before any I/O: the exit status of a malformed invocation (2) must not
 * depend on whether the repository, the network or the session exists.
 */
const checkModelFlags = (p: Parsed): void => {
  need(p, "good")
  need(p, "bad")
  for (const name of ["old-rate", "new-rate"]) {
    const v = str(p, name)
    if (v === undefined) continue
    try {
      checkRate(`--${name}`, parseRate(v))
    } catch (e) {
      if (e instanceof InvalidModel) throw new UsageError(e.message)
      throw e
    }
  }
  const confidence = num(p, "confidence")
  if (confidence !== undefined && !(confidence > 0 && confidence <= 1)) {
    throw new UsageError(`--confidence must be in (0, 1], got ${confidence}`)
  }
  const maxSteps = num(p, "max-steps")
  if (maxSteps !== undefined && !(Number.isSafeInteger(maxSteps) && maxSteps >= 0)) {
    throw new UsageError(`--max-steps must be a non-negative integer, got ${maxSteps}`)
  }
}

const short = (oid: string) => oid.slice(0, 12)

export const formatStatus = (st: SessionStatus): string[] => {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines = [
    `candidates: ${st.candidates}   observations: ${st.observations}   skipped: ${st.skipped.length}`,
    `most likely culprit: ${short(st.culprit.oid)} ${st.culprit.message ?? ""} (${pct(st.confidence)})`.trimEnd(),
    `posterior failure rate: before culprit ${pct(st.rates.oldMean)}, from culprit on ${pct(st.rates.newMean)}`,
    "ranking:",
    ...st.ranking.map((r) => `  ${pct(r.probability).padStart(6)}  ${short(r.commit.oid)}  ${r.commit.message ?? ""}`.trimEnd())
  ]
  lines.push(st.done ? `done (${st.stopReason})` : `next: test ${st.next!.oid}`)
  return lines
}

interface Source {
  readonly repoName: string
  readonly open: <A, E, R>(f: (log: CommitLog) => Effect.Effect<A, E, R>) => Effect.Effect<A, unknown, R>
  readonly artifacts: ReturnType<typeof makeArtifactsRestClient> | null
}

const sourceOf = (p: Parsed, deps: CliDeps): Source => {
  const artifactsRepo = str(p, "artifacts")
  if (artifactsRepo !== undefined) {
    const accountId = deps.env["CLOUDFLARE_ACCOUNT_ID"]
    const namespace = deps.env["ARTIFACTS_NAMESPACE"]
    const apiToken = secretFromConfig(deps.env["CLOUDFLARE_API_TOKEN"])
    if (!accountId || !namespace || !apiToken) {
      throw new UsageError("--artifacts needs CLOUDFLARE_ACCOUNT_ID, ARTIFACTS_NAMESPACE and CLOUDFLARE_API_TOKEN")
    }
    const client = makeArtifactsRestClient({ accountId, namespace, apiToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    return { repoName: artifactsRepo, artifacts: client, open: (f) => withRepo(client, artifactsRepo, (r) => f(r)) }
  }
  const dir = str(p, "repo-dir") ?? deps.cwd ?? "."
  const log = localGitLog(dir, deps.exec ?? realExec)
  return { repoName: dir, artifacts: null, open: (f) => f(log) }
}

const startFrom = (p: Parsed, deps: CliDeps, src: Source): Effect.Effect<BisectSession, unknown> =>
  Effect.gen(function* () {
    const oldRate = str(p, "old-rate")
    const newRate = str(p, "new-rate")
    const confidence = num(p, "confidence")
    const maxSteps = num(p, "max-steps")
    const params = {
      repo: src.repoName,
      goodRef: need(p, "good"),
      badRef: need(p, "bad"),
      now: deps.now(),
      ...(oldRate ? { oldRate: parseRate(oldRate) } : {}),
      ...(newRate ? { newRate: parseRate(newRate) } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {})
    }
    return yield* src.open((log) => startSession(log, params))
  })

const runnerOptions = (p: Parsed, deps: CliDeps) => {
  if (p.rest.length === 0) throw new UsageError("missing test command after --")
  const onTimeout = (str(p, "on-timeout") ?? "abort") as TimeoutPolicy
  if (!["fail", "skip", "abort"].includes(onTimeout)) throw new UsageError("--on-timeout must be fail, skip or abort")
  const timeout = num(p, "timeout")
  if (timeout !== undefined && !(timeout > 0)) throw new UsageError(`--timeout must be a positive number of seconds, got ${timeout}`)
  return {
    command: p.rest,
    onTimeout,
    clean: p.flags.get("clean") === true,
    ...(timeout !== undefined ? { timeout: Duration.seconds(timeout) } : {}),
    ...(deps.exec ? { exec: deps.exec } : {})
  }
}

const describe = (o: RunOutcome) => (o === "skip" ? "skip" : o ? "fail" : "pass")

const statePath = (p: Parsed, deps: CliDeps) => str(p, "state") ?? `${deps.cwd ?? "."}/.bayesect.json`

const loadState = (path: string): Effect.Effect<BisectSession, unknown> =>
  Effect.flatMap(
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => new UsageError(`no session at ${path}; run "bayesect start" first`) }),
    (text) => check(() => parseSession(JSON.parse(text)))
  )

const saveState = (path: string, s: BisectSession): Effect.Effect<void, unknown> =>
  callUpstream("writeFile", () => writeFile(path, `${JSON.stringify(s, null, 2)}\n`))

export const HELP = `usage:
  bayesect run    --good <ref> --bad <ref> [--repo-dir D | --artifacts NAME] [model] [runner] -- <cmd…>
  bayesect start  --good <ref> --bad <ref> [--repo-dir D | --artifacts NAME] [model] [--state FILE]
  bayesect status | next | undo            [--state FILE]
  bayesect fail|pass|skip [commit]         [--state FILE]   (default commit: the suggested next one)
  bayesect worker --url URL --session ID  -- <cmd…>          (token in BAYESECT_API_TOKEN)
model:  --old-rate beta:A,B|known:P  --new-rate beta:A,B|known:P  --confidence C  --max-steps N
runner: --timeout SECONDS  --on-timeout fail|skip|abort  --clean
exit status of <cmd>: 0 pass, 125 skip, 1-127 fail, >=128 abort (as in git bisect run)`

/**
 * One CLI invocation as an effect.
 *
 * @param argv - Arguments after the program name.
 * @param deps - Injected environment.
 * @returns The exit status of a successful run (0, or 3 when the search
 * stopped without reaching the confidence target).
 */
export const program = (argv: ReadonlyArray<string>, deps: CliDeps): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const p = yield* check(() => parseArgs(argv))
    switch (p.command) {
      case "help":
      case "--help":
        deps.out(HELP)
        return 0
      case "run": {
        yield* check(() => checkModelFlags(p))
        const opts = yield* check(() => runnerOptions(p, deps))
        const src = yield* check(() => sourceOf(p, deps))
        const session = yield* startFrom(p, deps, src)
        const repoDir = str(p, "repo-dir") ?? deps.cwd ?? "."
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const client = src.artifacts
            const runner =
              client !== null
                ? yield* remoteCommandRunner(
                    () =>
                      Effect.map(
                        withRepo(client, src.repoName, (r) => checkoutCredentials(r, "read", Duration.hours(1))),
                        (c) => ({ remote: c.remote, token: secret(c.token.plaintext) })
                      ),
                    opts
                  )
                : yield* localCommandRunner(repoDir, opts)
            deps.out(`bisecting ${session.candidates.length} commits after ${short(session.good.oid)}`)
            const { status } = yield* driveSession(session, (c: CommitInfo) => runner.run(c), {
              now: deps.now,
              onStep: (r) =>
                deps.out(`${short(r.commit.oid)}: ${describe(r.outcome)}  → culprit ${short(r.status.culprit.oid)} at ${(r.status.confidence * 100).toFixed(1)}%`)
            })
            formatStatus(status).forEach(deps.out)
            return status.stopReason === "confidence" ? 0 : 3
          })
        )
      }
      case "start": {
        yield* check(() => checkModelFlags(p))
        const src = yield* check(() => sourceOf(p, deps))
        const s = yield* startFrom(p, deps, src)
        yield* saveState(yield* check(() => statePath(p, deps)), s)
        formatStatus(sessionStatus(s)).forEach(deps.out)
        return 0
      }
      case "status":
      case "next": {
        const s = yield* loadState(yield* check(() => statePath(p, deps)))
        const st = yield* check(() => sessionStatus(s))
        if (p.command === "next") deps.out(st.next?.oid ?? "")
        else formatStatus(st).forEach(deps.out)
        return 0
      }
      case "fail":
      case "pass":
      case "skip": {
        const path = yield* check(() => statePath(p, deps))
        const s = yield* loadState(path)
        const next = yield* check(() => {
          const ref = p.positional[0] ?? sessionStatus(s).next?.oid
          if (ref === undefined) throw new UsageError("the search is done; name a commit explicitly")
          const t = deps.now()
          return p.command === "skip" ? recordSkip(s, ref, t) : recordResult(s, ref, p.command === "fail", t)
        })
        yield* saveState(path, next)
        formatStatus(sessionStatus(next)).forEach(deps.out)
        return 0
      }
      case "undo": {
        const path = yield* check(() => statePath(p, deps))
        const cur = yield* loadState(path)
        const next = yield* check(() => undoLast(cur))
        yield* saveState(path, next)
        formatStatus(sessionStatus(next)).forEach(deps.out)
        return 0
      }
      case "worker": {
        const token = secretFromConfig(deps.env["BAYESECT_API_TOKEN"])
        if (!token) return yield* Effect.fail(new UsageError("worker mode needs BAYESECT_API_TOKEN"))
        const baseUrl = yield* check(() => need(p, "url"))
        const id = yield* check(() => need(p, "session"))
        const opts = yield* check(() => runnerOptions(p, deps))
        const client = makeBisectApiClient({ baseUrl, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const runner = yield* remoteCommandRunner(
              () => Effect.map(client.credentials(id), (c) => ({ remote: c.remote, token: secret(c.token) })),
              opts
            )
            const final = yield* driveRemoteSession(client, id, (c) => runner.run(c), (r) => deps.out(`${short(r.commit.oid)}: ${describe(r.outcome)}`))
            formatStatus(final.status).forEach(deps.out)
            return final.status.stopReason === "confidence" ? 0 : 3
          })
        )
      }
      default:
        return yield* Effect.fail(new UsageError(`unknown command ${JSON.stringify(p.command)}`))
    }
  })

/**
 * Run one invocation and return the process exit status: the status of
 * {@link program}, 2 for a `UsageError` (after printing the help text), 130
 * when `deps.signal` was aborted, 1 for any other failure.
 *
 * @param argv - Arguments after the program name.
 * @param deps - Injected environment.
 * @returns The exit status.
 */
export const main = async (argv: ReadonlyArray<string>, deps: CliDeps): Promise<number> => {
  try {
    return await runPromiseOrThrow(program(argv, deps), deps.signal !== undefined ? { signal: deps.signal } : undefined)
  } catch (e) {
    if (deps.signal?.aborted === true) {
      deps.err("bayesect: interrupted")
      return 130
    }
    deps.err(`bayesect: ${e instanceof Error ? e.message : String(e)}`)
    if (e instanceof UsageError) {
      deps.err(HELP)
      return 2
    }
    return 1
  }
}
