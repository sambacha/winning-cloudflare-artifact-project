/**
 * Local Git access for bisection: a `CommitLog` over `git log
 * --first-parent` (the same semantics as Artifacts' `log()`: first-parent
 * chain, newest first, empty for an unresolved ref), and runners that check
 * out a commit and run a test command, mapping its exit status like
 * `git bisect run`:
 *
 *   0          the bug did not show  (pass)
 *   125        the commit cannot be tested (skip)
 *   1–127      the bug showed (fail), except 125
 *   ≥ 128 or killed by a signal   abort the whole search (`BisectAbort`)
 *
 * Checkouts happen in a separate detached worktree, never in the caller's
 * working tree. For an Artifacts repository the worktree is a clone of the
 * repo's remote, authenticated with a short-lived read token passed as the
 * documented `http.extraHeader` — through `GIT_CONFIG_*` environment
 * variables, so the token is not visible in the process list.
 *
 * Effect structure: `exec` (a child process) is the Promise boundary; the
 * runners are effects, and a runner's worktree or clone is a scoped
 * resource (`Effect.acquireRelease`), removed when the enclosing
 * `Effect.scoped` ends — also on failure or interruption. `localGitLog` is a
 * `CommitLog` adapter and therefore keeps the Promise shape of that
 * interface.
 *
 * @packageDocumentation
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommitInfo, LogOptions } from "./artifactsApi.js"
import { checkLogLimit, LOG_DEFAULT_LIMIT } from "./artifactsApi.js"
import type { CommitLog } from "./artifacts.js"
import type { RunOutcome } from "./engine.js"
import { Data, Duration, Effect, Redacted, type Scope } from "../fx/index.js"

/** Outcome of a finished child process. */
export interface ExecResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Options of {@link exec}. */
export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  /** Kill the child (SIGKILL) after this long. */
  readonly timeout?: Duration.Duration
  /** Inherit stdout/stderr (the user's test command) instead of capturing. */
  readonly inherit?: boolean
}

/** Runs a child process to completion (injectable for tests). */
export type Exec = (cmd: string, args: ReadonlyArray<string>, opts?: ExecOptions) => Promise<ExecResult>

/** {@link Exec} over `node:child_process.spawn`. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
    const timer =
      opts.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, Duration.toMillis(opts.timeout))
    child.on("error", (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })

/** A Git command (or the test command's process) failed. */
export class GitError extends Data.TaggedError("GitError")<{ readonly message: string }> {
  override readonly name = "GitError"
  /** @param message - Which command failed and its (token-redacted) stderr. */
  constructor(message: string) {
    super({ message })
  }
}

/** The test command asks to abort the whole search (`git bisect run` exit status ≥ 128, a signal, or a timeout under policy `abort`). */
export class BisectAbort extends Data.TaggedError("BisectAbort")<{ readonly message: string }> {
  override readonly name = "BisectAbort"
  /** @param message - Why the search stops. */
  constructor(message: string) {
    super({ message })
  }
}

const git = async (run: Exec, dir: string, args: ReadonlyArray<string>, env?: Record<string, string>): Promise<ExecResult> =>
  run("git", ["-C", dir, ...args], env ? { env } : {})

/** Runs a process as an effect; a spawn failure becomes `GitError`. */
const execE = (run: Exec, cmd: string, args: ReadonlyArray<string>, opts: ExecOptions = {}): Effect.Effect<ExecResult, GitError> =>
  Effect.tryPromise({
    try: () => run(cmd, args, opts),
    catch: (e) => new GitError(`${cmd}: ${e instanceof Error ? e.message : String(e)}`)
  })

const gitE = (run: Exec, dir: string, args: ReadonlyArray<string>, env?: Record<string, string>): Effect.Effect<ExecResult, GitError> =>
  execE(run, "git", ["-C", dir, ...args], env ? { env } : {})

const FIELD = "\x1f"
const RECORD = "\x1e"

const parseLog = (out: string): CommitInfo[] =>
  out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [oid, parents, timestamp, ...subject] = r.split(FIELD)
      return {
        oid: oid!,
        parents: parents!.length > 0 ? parents!.split(" ") : [],
        timestamp: timestamp!,
        message: subject.join(FIELD).replace(/\n$/, "")
      }
    })

const FORMAT = `--format=%H${FIELD}%P${FIELD}%cI${FIELD}%s${RECORD}`

/** `CommitLog` over a local repository at `dir`. */
export const localGitLog = (dir: string, run: Exec = exec): CommitLog => ({
  log: async (opts: LogOptions & { ref: string }) => {
    const limit = checkLogLimit(opts.limit ?? LOG_DEFAULT_LIMIT)
    const offset = opts.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`)
    if (opts.ref.startsWith("-")) throw new GitError(`refusing option-like ref ${JSON.stringify(opts.ref)}`)
    const r = await git(run, dir, ["log", "--first-parent", FORMAT, `--max-count=${limit}`, `--skip=${offset}`, opts.ref, "--"])
    // Like Artifacts' log(): an unresolvable ref gives an empty list.
    if (r.code !== 0) return []
    return parseLog(r.stdout)
  },
  readCommit: async (hash: string) => {
    if (hash.startsWith("-")) return null
    const r = await git(run, dir, ["log", "-1", FORMAT, `${hash}^{commit}`, "--"])
    if (r.code !== 0) return null
    return parseLog(r.stdout)[0] ?? null
  }
})

/** What a test-command timeout counts as. */
export type TimeoutPolicy = "fail" | "skip" | "abort"

/** Map a finished test command to an outcome (`git bisect run` convention). */
export const outcomeOf = (r: Pick<ExecResult, "code" | "signal" | "timedOut">, onTimeout: TimeoutPolicy): RunOutcome => {
  if (r.timedOut) {
    if (onTimeout === "abort") throw new BisectAbort("test command timed out")
    return onTimeout === "skip" ? "skip" : true
  }
  if (r.signal !== null || r.code === null) throw new BisectAbort(`test command killed by ${r.signal ?? "unknown signal"}`)
  if (r.code === 0) return false
  if (r.code === 125) return "skip"
  if (r.code < 128) return true
  throw new BisectAbort(`test command exited with ${r.code} (≥ 128 aborts the search, as in git bisect run)`)
}

/** {@link outcomeOf} as an effect: `BisectAbort` in the error channel. */
export const outcomeEffect = (r: Pick<ExecResult, "code" | "signal" | "timedOut">, onTimeout: TimeoutPolicy): Effect.Effect<RunOutcome, BisectAbort> =>
  Effect.try({ try: () => outcomeOf(r, onTimeout), catch: (e) => e as BisectAbort })

/** Options of the command runners. */
export interface CommandRunnerOptions {
  /** The test command and its arguments. */
  readonly command: ReadonlyArray<string>
  /** Time limit of one run of the command. */
  readonly timeout?: Duration.Duration
  readonly onTimeout?: TimeoutPolicy
  /** Remove untracked files (`git clean -fdx`) before each run. */
  readonly clean?: boolean
  readonly exec?: Exec
  /** Show the command's output (default true). */
  readonly inheritOutput?: boolean
}

/** Failures of one test run. */
export type RunError = GitError | BisectAbort

/** Runs the test command at a commit. Obtained from a scoped runner constructor. */
export interface CommitRunner {
  readonly run: (commit: CommitInfo) => Effect.Effect<RunOutcome, RunError>
}

const runInWorktree =
  (worktree: string, o: CommandRunnerOptions, gitEnv?: Record<string, string>) =>
  (commit: CommitInfo): Effect.Effect<RunOutcome, RunError> =>
    Effect.gen(function* () {
      const run = o.exec ?? exec
      const co = yield* gitE(run, worktree, ["checkout", "--detach", "--force", "--quiet", commit.oid], gitEnv)
      if (co.code !== 0) return yield* Effect.fail(new GitError(`checkout of ${commit.oid} failed: ${co.stderr.trim()}`))
      if (o.clean) yield* gitE(run, worktree, ["clean", "-fdxq"])
      const [cmd, ...args] = o.command
      if (cmd === undefined) return yield* Effect.fail(new GitError("empty test command"))
      const r = yield* execE(run, cmd, args, {
        cwd: worktree,
        inherit: o.inheritOutput ?? true,
        ...(o.timeout !== undefined ? { timeout: o.timeout } : {})
      })
      return yield* outcomeEffect(r, o.onTimeout ?? "abort")
    })

const tempDir = (prefix: string): Effect.Effect<string, GitError> =>
  Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), prefix)), catch: (e) => new GitError(`mkdtemp: ${String(e)}`) })

const removeDir = (dir: string): Effect.Effect<void> => Effect.promise(() => rm(dir, { recursive: true, force: true }))

/**
 * Run the command in a detached worktree of the local repository at
 * `repoDir`. The worktree is a scoped resource: it is removed
 * (`git worktree remove`, then the directory) when the scope closes.
 *
 * @param repoDir - The repository.
 * @param o - Test command and policies.
 * @returns The runner, in a scope.
 */
export const localCommandRunner = (repoDir: string, o: CommandRunnerOptions): Effect.Effect<CommitRunner, GitError, Scope.Scope> => {
  const run = o.exec ?? exec
  return Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const dir = yield* tempDir("bayesect-wt-")
        const add = yield* gitE(run, repoDir, ["worktree", "add", "--detach", "--quiet", dir, "HEAD"])
        if (add.code !== 0) {
          yield* removeDir(dir)
          return yield* Effect.fail(new GitError(`git worktree add failed: ${add.stderr.trim()}`))
        }
        return dir
      }),
      (dir) =>
        Effect.andThen(
          Effect.ignore(gitE(run, repoDir, ["worktree", "remove", "--force", dir])),
          removeDir(dir)
        )
    ),
    (dir) => ({ run: runInWorktree(dir, o) })
  )
}

/** `GIT_CONFIG_*` variables equivalent to `-c http.extraHeader="Authorization: Bearer <token>"`. */
export const bearerHeaderEnv = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`
})

/**
 * Remote URL and bearer token for cloning. The token is `Redacted`; it is
 * unwrapped only to build the `GIT_CONFIG_*` header variables and to scrub
 * it from Git's error output.
 */
export interface CloneCredentials {
  readonly remote: string
  readonly token: Redacted.Redacted<string>
}

/**
 * Clone an Artifacts repo (or any HTTPS remote) with a bearer token and run
 * the command in that clone. `getCredentials` runs once per clone and again
 * whenever a needed commit is missing, so expired tokens are replaced. The
 * clone directory is a scoped resource.
 *
 * @param getCredentials - Mints fresh credentials.
 * @param o - Test command and policies.
 * @returns The runner, in a scope.
 */
export const remoteCommandRunner = <E, R>(
  getCredentials: () => Effect.Effect<CloneCredentials, E, R>,
  o: CommandRunnerOptions
): Effect.Effect<{ readonly run: (commit: CommitInfo) => Effect.Effect<RunOutcome, RunError | E, R> }, GitError | E, Scope.Scope | R> => {
  const run = o.exec ?? exec
  return Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(tempDir("bayesect-clone-"), removeDir)
    let creds = yield* getCredentials()
    const first = Redacted.value(creds.token)
    const cl = yield* execE(run, "git", ["clone", "--no-checkout", "--quiet", creds.remote, dir], { env: bearerHeaderEnv(first) })
    if (cl.code !== 0) return yield* Effect.fail(new GitError(`clone failed: ${cl.stderr.replaceAll(first, "<token>").trim()}`))
    return {
      run: (commit: CommitInfo) =>
        Effect.gen(function* () {
          const have = yield* gitE(run, dir, ["cat-file", "-e", `${commit.oid}^{commit}`])
          if (have.code !== 0) {
            creds = yield* getCredentials()
            const token = Redacted.value(creds.token)
            const f = yield* gitE(run, dir, ["fetch", "--quiet", "origin"], bearerHeaderEnv(token))
            if (f.code !== 0) return yield* Effect.fail(new GitError(`fetch failed: ${f.stderr.replaceAll(token, "<token>").trim()}`))
          }
          return yield* runInWorktree(dir, o, bearerHeaderEnv(Redacted.value(creds.token)))(commit)
        })
    }
  })
}
