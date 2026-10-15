/**
 * Store a cobuild run summary in a Cloudflare Artifacts repository and verify
 * it, following `cloudflare-artifacts.md` (REST API, Git protocol):
 *
 * 1. `POST /repos` creates the repo (an existing repo, `ALREADY_EXISTS`, is
 *    fine); `GET /repos/:name` gives its `remote` and default branch.
 * 2. `POST /tokens { repo, scope: "write", ttl }` mints a short-lived write
 *    token (Git routes do not accept the Cloudflare API token).
 * 3. A regular `git` client clones the remote with the token as
 *    `http.extraHeader: Authorization: Bearer <token>` — passed through
 *    `GIT_CONFIG_*` environment variables, so it never appears in a command
 *    line, a remote URL or a log — commits the file, and pushes with Git
 *    protocol v1 (Artifacts does not support v2 receive-pack). A rejected
 *    push (another job pushed first) is retried after `git pull --rebase`.
 * 4. `GET /repos/:name/log?ref=<branch>&limit=50` must contain the commit
 *    just pushed (`verified`).
 *
 * The proposal's version (`env.ARTIFACTS.create` then `log({ limit: 1 })`)
 * would read an empty log: a freshly created repo has no commits, and the
 * Workers binding has no write API, so commits must be pushed over Git.
 *
 * Effect structure: {@link publishToArtifactsEffect} is the program; the
 * temporary clone directory is a scoped resource (`Effect.acquireRelease`)
 * removed on every exit. {@link publishToArtifacts} runs it at the CLI edge.
 *
 * @packageDocumentation
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  ArtifactsShapeError,
  callUpstream,
  checkoutCredentials,
  normalizeCommit,
  validate,
  withRepo
} from "../bisect/artifactsApi.js"
import type { RestClient } from "../bisect/artifactsRest.js"
import { bearerHeaderEnv, type Exec, exec as defaultExec } from "../bisect/localGit.js"
import { isSafeRelativePath } from "../cache/manifest.js"
import { Data, Duration, Effect, runPromiseOrThrow } from "../fx/index.js"

/** Arguments of {@link publishToArtifacts}. */
export interface PublishToArtifactsArgs {
  readonly client: RestClient
  readonly repo: string
  /** Repository-relative path of the file, e.g. `runs/<context>/<job>.json`. */
  readonly path: string
  readonly content: string
  readonly message: string
  readonly description?: string
  /** Lifetime of the push token (default 10 minutes; whole seconds). */
  readonly tokenTtl?: Duration.Duration
  readonly exec?: Exec
  /** Push attempts (default 5). */
  readonly maxPushAttempts?: number
}

/** What was pushed, and whether the repo's log shows it. */
export interface PublishToArtifactsResult {
  readonly repo: string
  readonly remote: string
  readonly branch: string
  readonly commit: string
  readonly created: boolean
  /** The repo's `log` of `branch` (newest 50) contains `commit`. */
  readonly verified: boolean
}

/** A Git step of the publication failed, or the path is unsafe. Messages never contain the token. */
export class ArtifactsPublishError extends Data.TaggedError("ArtifactsPublishError")<{ readonly message: string }> {
  override readonly name = "ArtifactsPublishError"
  /** @param message - The failing step and its redacted stderr. */
  constructor(message: string) {
    super({ message })
  }
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "cobuild",
  GIT_AUTHOR_EMAIL: "cobuild@localhost",
  GIT_COMMITTER_NAME: "cobuild",
  GIT_COMMITTER_EMAIL: "cobuild@localhost"
}

/**
 * Create (if needed) the repo, push `content` at `path` with a short-lived
 * write token, and check the commit in the repo's log.
 *
 * @param a - Client, repo, file and commit message.
 * @returns What was pushed.
 */
export const publishToArtifactsEffect = (a: PublishToArtifactsArgs) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!isSafeRelativePath(a.path)) return yield* Effect.fail(new ArtifactsPublishError(`unsafe repository path ${JSON.stringify(a.path)}`))
      const run = a.exec ?? defaultExec
      const created = yield* a.client.createRepo(a.repo, { ...(a.description !== undefined ? { description: a.description } : {}), defaultBranch: "main" })
      const { info, token } = yield* withRepo(a.client, a.repo, (repo) =>
        Effect.map(checkoutCredentials(repo, "write", a.tokenTtl ?? Duration.minutes(10)), (c) => ({ info: c.info, token: c.token }))
      )
      const branch = info.defaultBranch ?? created?.defaultBranch ?? "main"
      const secret = token.plaintext
      const redact = (s: string) => s.replaceAll(secret, "<token>")
      const env = { ...bearerHeaderEnv(secret), ...GIT_IDENTITY, GIT_TERMINAL_PROMPT: "0" }
      const exec = (args: ReadonlyArray<string>) =>
        Effect.map(
          Effect.tryPromise({
            try: () => run("git", args, { env }),
            catch: (e) => new ArtifactsPublishError(`git: ${redact(e instanceof Error ? e.message : String(e))}`)
          }),
          (r) => ({ ...r, stderr: redact(r.stderr), stdout: redact(r.stdout) })
        )
      const git = (dir: string, args: ReadonlyArray<string>) => exec(["-C", dir, "-c", "protocol.version=1", ...args])
      const fail = (message: string) => Effect.fail(new ArtifactsPublishError(message))
      const dir = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "cobuild-artifacts-")), catch: (e) => new ArtifactsPublishError(`mkdtemp: ${String(e)}`) }),
        (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
      )
      const cl = yield* exec(["clone", "--quiet", info.remote, join(dir, "repo")])
      if (cl.code !== 0) return yield* fail(`git clone failed: ${cl.stderr.trim()}`)
      const work = join(dir, "repo")
      // An empty repo clones without a branch; start the default branch.
      yield* git(work, ["checkout", "-q", "-B", branch])
      const target = join(work, ...a.path.split("/"))
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, a.content)
        },
        catch: (e) => new ArtifactsPublishError(`writing ${a.path}: ${String(e)}`)
      })
      const add = yield* git(work, ["add", "--", a.path])
      if (add.code !== 0) return yield* fail(`git add failed: ${add.stderr.trim()}`)
      const ci = yield* git(work, ["commit", "-q", "--allow-empty", "-m", a.message])
      if (ci.code !== 0) return yield* fail(`git commit failed: ${ci.stderr.trim()}`)
      const attempts = a.maxPushAttempts ?? 5
      for (let i = 1; ; i++) {
        const push = yield* git(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`])
        if (push.code === 0) break
        if (i >= attempts) return yield* fail(`git push failed after ${i} attempts: ${push.stderr.trim()}`)
        // Another job pushed first: replay our commit on top of theirs (distinct files, no conflicts).
        const pull = yield* git(work, ["pull", "--quiet", "--rebase", "origin", branch])
        if (pull.code !== 0) return yield* fail(`git pull --rebase failed: ${pull.stderr.trim()}`)
      }
      const head = (yield* git(work, ["rev-parse", "HEAD"])).stdout.trim()
      // Other jobs may push right after us, so look for our commit among the newest ones.
      const recent = yield* withRepo(a.client, a.repo, (repo) => callUpstream("repo.log", () => repo.log({ ref: branch, limit: 50 })))
      const oids = yield* Effect.forEach(recent, (c) => validate<string, ArtifactsShapeError>(() => normalizeCommit(c).oid))
      const verified = oids.includes(head)
      const result: PublishToArtifactsResult = { repo: a.repo, remote: info.remote, branch, commit: head, created: created !== null, verified }
      return result
    })
  )

/**
 * {@link publishToArtifactsEffect} run as a Promise; rejects with the typed
 * failure (`ArtifactsPublishError`, `ArtifactsApiError`, ...).
 *
 * @param a - Client, repo, file and commit message.
 * @returns What was pushed.
 */
export const publishToArtifacts = (a: PublishToArtifactsArgs): Promise<PublishToArtifactsResult> => runPromiseOrThrow(publishToArtifactsEffect(a))
