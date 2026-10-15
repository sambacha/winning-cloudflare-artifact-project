/**
 * One bisection step in a fresh Sandbox SDK sandbox: check out a commit
 * read-only, restore or install `node_modules`, run the predicate.
 *
 * Why a sandbox and not a `@cloudflare/ci` runner: a CI runner retries a
 * failing command and then puts the Workflow in `Errored`, but for a bisect a
 * failing test is an *observation*. Here a non-zero exit is data:
 *
 * | predicate result | outcome |
 * |---|---|
 * | exit 0 | `pass` |
 * | exit 124 / 137 (killed by `timeout`) | `skip` (reason `timeout`) |
 * | any other exit | `fail` (the bug showed) |
 * | `npm ci` fails at this commit | `skip` (reason `install`) |
 *
 * A timeout is a skip, not a fail: it is a systematic misclassification of
 * the commit, not Bernoulli noise that the model's rates absorb.
 *
 * Checkout (documented in the request; fetch-by-commit-id is **not**
 * documented for Artifacts, so there is a fallback):
 *
 * 1. `git fetch --depth=<range> origin <sha>` then `git checkout --detach <sha>`;
 * 2. if that fetch fails: `git fetch --depth=<range> origin <branch>` (a shallow
 *    clone covering the whole range), check that `<sha>` is present, then
 *    check it out.
 *
 * The read token travels in the `ARTIFACTS_TOKEN` environment variable and
 * reaches Git as an `http.extraHeader`, so it never appears in a command line
 * or in Git's configuration. The sandbox is destroyed afterwards, whatever
 * happened.
 */
import type { BlobStore } from "../cache/blobStore.js"
import { Clock, Data, Effect } from "../fx/index.js"
import { CommandFailed, DEFAULT_INSTALL, type EnsureResult, ensureNodeModules, execOk } from "../nodeModules/ensure.js"
import { makeSandboxWorkspace, type SandboxLike, sandboxCall, shq } from "./sandbox.js"

/** The checkout could not be done (both fetch strategies failed, or the sandbox is unusable). */
export class PredicateInfraError extends Data.TaggedError("PredicateInfraError")<{
  readonly stage: "checkout" | "sandbox"
  readonly detail: string
}> {}

/** What one step needs. */
export interface PredicateStepInput {
  /** The Artifacts remote (from `checkoutCredentials`). */
  readonly remote: string
  /** A **read** token. */
  readonly token: string
  readonly commit: string
  /** Branch whose shallow clone covers the range (fallback). */
  readonly branch: string
  /** Fetch depth: the range length plus one. */
  readonly depth: number
  /** The predicate, run with `sh -c` (default `npm test`). */
  readonly command?: string
  /** Predicate time budget in seconds. */
  readonly timeoutSec: number
  /** Extra environment for the predicate (e.g. a seed for a reproducible demo). */
  readonly env?: Record<string, string>
  /** The `node_modules` cache; without it `npm ci` always runs. */
  readonly nodeModules?: { readonly store: BlobStore; readonly runId: string }
  /** Skip dependency installation entirely (projects without dependencies). */
  readonly noInstall?: boolean
  /** Checkout directory inside the sandbox (default `/workspace/repo`). */
  readonly workdir?: string
}

/** What one step observed. */
export interface PredicateStepResult {
  readonly outcome: "pass" | "fail" | "skip"
  readonly reason: "exit-0" | "exit-nonzero" | "timeout" | "install"
  readonly exitCode: number
  readonly checkout: "commit-fetch" | "branch-fallback"
  readonly durationMs: number
  readonly nodeModules: Pick<EnsureResult, "key" | "outcome" | "durationMs" | "missReason"> | null
  /** Last lines of the predicate's output (for the dashboard and the manifest). */
  readonly logTail: string
}

/** Exit codes of GNU `timeout`: 124 (TERM after the limit), 137 (KILL after `--kill-after`). */
export const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137])

/** Default checkout directory inside the sandbox. */
export const DEFAULT_WORKDIR = "/workspace/repo"

const tail = (s: string, lines = 20): string => s.split("\n").slice(-lines).join("\n")

/**
 * Run one step in `sandbox` and destroy it afterwards.
 *
 * @param sandbox - A fresh sandbox (one per step).
 * @param input - Commit, credentials, predicate.
 * @returns The observation; fails only when the checkout itself is impossible.
 */
export const runPredicateStep = (sandbox: SandboxLike, input: PredicateStepInput): Effect.Effect<PredicateStepResult, PredicateInfraError> =>
  Effect.ensuring(
    Effect.gen(function* () {
      const t0 = yield* Clock.currentTimeMillis
      const ROOT = input.workdir ?? DEFAULT_WORKDIR
      const env = { ARTIFACTS_TOKEN: input.token, ARTIFACTS_REMOTE: input.remote }
      const git = (args: string) => `git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" ${args}`
      const sh = (command: string, cwd = ROOT) =>
        sandboxCall(command, () => sandbox.exec(command, { cwd, env })).pipe(Effect.mapError((e) => new PredicateInfraError({ stage: "sandbox", detail: e.stderrTail })))

      // Idempotent: a sandbox left behind by a crashed attempt starts from an empty checkout too.
      const init = yield* sh(`rm -rf ${shq(ROOT)} && mkdir -p ${shq(ROOT)} && cd ${shq(ROOT)} && git init -q && git remote add origin "$ARTIFACTS_REMOTE"`, "/")
      if (init.exitCode !== 0) return yield* Effect.fail(new PredicateInfraError({ stage: "sandbox", detail: tail(init.stderr) }))

      const depth = Math.max(1, Math.floor(input.depth))
      let checkout: PredicateStepResult["checkout"] = "commit-fetch"
      const bySha = yield* sh(git(`fetch -q --depth=${depth} origin ${shq(input.commit)}`))
      if (bySha.exitCode !== 0) {
        checkout = "branch-fallback"
        const byBranch = yield* sh(git(`fetch -q --depth=${depth} origin ${shq(input.branch)}`))
        if (byBranch.exitCode !== 0) {
          return yield* Effect.fail(new PredicateInfraError({ stage: "checkout", detail: `fetch by commit and by branch failed: ${tail(byBranch.stderr, 5)}` }))
        }
        const present = yield* sh(`git cat-file -e ${shq(`${input.commit}^{commit}`)}`)
        if (present.exitCode !== 0) {
          return yield* Effect.fail(new PredicateInfraError({ stage: "checkout", detail: `${input.commit} is not within depth ${depth} of ${input.branch}` }))
        }
      }
      const co = yield* sh(`git checkout -q --detach ${shq(input.commit)}`)
      if (co.exitCode !== 0) return yield* Effect.fail(new PredicateInfraError({ stage: "checkout", detail: tail(co.stderr, 5) }))

      // Dependencies: restore from R2 or install. A failing install makes this commit untestable (skip).
      const ws = makeSandboxWorkspace(sandbox, ROOT)
      const installed = input.noInstall
        ? Effect.succeed(null)
        : input.nodeModules
          ? Effect.map(ensureNodeModules({ workspace: ws, store: input.nodeModules.store, runId: input.nodeModules.runId }), (r) => ({
              key: r.key,
              outcome: r.outcome,
              durationMs: r.durationMs,
              missReason: r.missReason
            }))
          : Effect.as(execOk(ws, DEFAULT_INSTALL), null)
      const nm = yield* Effect.result(installed)
      if (nm._tag === "Failure") {
        const detail = nm.failure instanceof CommandFailed ? nm.failure.stderrTail : String(nm.failure)
        return {
          outcome: "skip",
          reason: "install",
          exitCode: nm.failure instanceof CommandFailed ? (nm.failure.exitCode ?? -1) : -1,
          checkout,
          durationMs: (yield* Clock.currentTimeMillis) - t0,
          nodeModules: null,
          logTail: tail(detail)
        } satisfies PredicateStepResult
      }

      const command = input.command ?? "npm test"
      const run = yield* sandboxCall(command, () =>
        sandbox.exec(`timeout --kill-after=5 ${Math.max(1, Math.floor(input.timeoutSec))} sh -c ${shq(command)}`, { cwd: ROOT, env: { ...(input.env ?? {}) } })
      ).pipe(Effect.mapError((e) => new PredicateInfraError({ stage: "sandbox", detail: e.stderrTail })))
      const timedOut = TIMEOUT_EXIT_CODES.has(run.exitCode)
      return {
        outcome: timedOut ? "skip" : run.exitCode === 0 ? "pass" : "fail",
        reason: timedOut ? "timeout" : run.exitCode === 0 ? "exit-0" : "exit-nonzero",
        exitCode: run.exitCode,
        checkout,
        durationMs: (yield* Clock.currentTimeMillis) - t0,
        nodeModules: nm.success,
        logTail: tail(`${run.stdout}\n${run.stderr}`)
      } satisfies PredicateStepResult
    }),
    Effect.promise(() => sandbox.destroy().catch(() => undefined))
  )
