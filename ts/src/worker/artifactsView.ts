/**
 * Read-only view of one Cloudflare Artifacts repository, for the dashboard's
 * Artifacts panel (`GET /api/artifacts?repo=<name>[&ref=<ref>][&limit=<n>]`).
 *
 * It uses only documented Workers-binding calls (`cloudflare-artifacts.md`,
 * "Workers binding"):
 *
 * - `env.ARTIFACTS.get(name)` returns a disposable repository capability and
 *   **throws if the repo does not exist or is not ready yet**. That case is
 *   `RepoUnavailable` (HTTP 404); the binding gives no finer reason.
 * - `repo.info()` is a fresh metadata lookup (`name`, `remote`,
 *   `defaultBranch`).
 * - `repo.log({ ref, limit })` follows first parents, newest first, and
 *   returns `[]` when the ref cannot be resolved. An empty history is a
 *   normal answer (`commits: []`), e.g. a repo created but never pushed to.
 * - The handle is disposed on every path (`Effect.acquireUseRelease`), as
 *   the docs require ("so it is released before the request ends").
 *
 * What it deliberately does not do, and why:
 *
 * - It never creates repos and never mints tokens. The proposal's Worker
 *   (`env.ARTIFACTS.create(...)` then `log({ limit: 1 })`) would always read
 *   an empty log: a new repo has no commits and the binding has no write
 *   API. Commits are pushed over Git by `cobuild artifacts publish`
 *   (`src/cli/artifactsPublish.ts`); this route only shows the result.
 * - It never returns secrets. The response is built field by field from the
 *   normalised `info()` and commit records, so a token-bearing field in a
 *   binding result (`create()` results carry `token`) cannot leak through.
 */
import { Data, Effect } from "../fx/index.js"
import {
  type ArtifactsNamespaceLike,
  type ArtifactsRepoLike,
  checkLogLimit,
  checkRepoName,
  disposeRepo,
  normalizeCommit,
  normalizeRepoInfo
} from "../bisect/artifactsApi.js"

/** The repo name or limit is malformed (HTTP 400). */
export class InvalidArtifactsQuery extends Data.TaggedError("InvalidArtifactsQuery")<{ readonly message: string }> {}

/** `get(name)` threw: the repo does not exist or is not ready (HTTP 404). */
export class RepoUnavailable extends Data.TaggedError("RepoUnavailable")<{ readonly repo: string }> {}

/** `info()` / `log()` failed or returned a malformed record (HTTP 502). */
export class ArtifactsReadFailed extends Data.TaggedError("ArtifactsReadFailed")<{ readonly repo: string; readonly cause: unknown }> {}

export type ArtifactsViewError = InvalidArtifactsQuery | RepoUnavailable | ArtifactsReadFailed

export interface ArtifactsCommitView {
  readonly oid: string
  readonly message: string | null
  readonly timestamp: string | null
}

export interface ArtifactsResponse {
  readonly repo: string
  readonly remote: string
  readonly defaultBranch: string | null
  /** The ref whose history is shown (`ref` query, else the default branch, else `HEAD`). */
  readonly ref: string
  /** Newest first, at most `limit`. Empty when the ref has no commits or cannot be resolved. */
  readonly commits: ReadonlyArray<ArtifactsCommitView>
}

/** Default and maximum number of commits shown. */
export const ARTIFACTS_VIEW_DEFAULT_LIMIT = 10

export interface ArtifactsQuery {
  readonly repo: string
  readonly ref: string | null
  readonly limit: number
}

/** Parse `?repo=&ref=&limit=`; the name and limit follow the documented rules. */
export const parseArtifactsQuery = (params: URLSearchParams): Effect.Effect<ArtifactsQuery, InvalidArtifactsQuery> =>
  Effect.try({
    try: () => {
      const repo = params.get("repo")
      if (repo === null) throw new Error("missing ?repo=")
      const rawLimit = params.get("limit")
      const limit = rawLimit === null ? ARTIFACTS_VIEW_DEFAULT_LIMIT : checkLogLimit(Number(rawLimit))
      const ref = params.get("ref")
      if (ref !== null && ref.length === 0) throw new Error("empty ?ref=")
      return { repo: checkRepoName(repo), ref, limit }
    },
    catch: (e) => new InvalidArtifactsQuery({ message: e instanceof Error ? e.message : String(e) })
  })

const toCommitView = (raw: unknown): ArtifactsCommitView => {
  const c = normalizeCommit(raw)
  return { oid: c.oid, message: c.message ?? null, timestamp: c.timestamp ?? null }
}

/** Read `info()` and the newest `limit` commits of `ref`; the handle is always disposed. */
export const viewArtifactsRepo = (
  artifacts: ArtifactsNamespaceLike,
  q: ArtifactsQuery
): Effect.Effect<ArtifactsResponse, RepoUnavailable | ArtifactsReadFailed> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => artifacts.get(q.repo), catch: () => new RepoUnavailable({ repo: q.repo }) }),
    (repo: ArtifactsRepoLike) =>
      Effect.tryPromise({
        try: async (): Promise<ArtifactsResponse> => {
          if (repo.info === undefined) throw new Error("repository handle lacks info()")
          const info = normalizeRepoInfo(await repo.info())
          const ref = q.ref ?? info.defaultBranch ?? "HEAD"
          const commits = (await repo.log({ ref, limit: q.limit })).map(toCommitView)
          return { repo: info.name, remote: info.remote, defaultBranch: info.defaultBranch ?? null, ref, commits }
        },
        catch: (cause) => new ArtifactsReadFailed({ repo: q.repo, cause })
      }),
    (repo) => Effect.sync(() => disposeRepo(repo))
  )

/** HTTP status of each error. */
export const artifactsErrorStatus = (e: ArtifactsViewError): number => {
  switch (e._tag) {
    case "InvalidArtifactsQuery":
      return 400
    case "RepoUnavailable":
      return 404
    case "ArtifactsReadFailed":
      return 502
  }
}

/** Client-facing error body: no causes, no stack traces. */
export const artifactsErrorBody = (e: ArtifactsViewError): { readonly error: string } => {
  switch (e._tag) {
    case "InvalidArtifactsQuery":
      return { error: e.message }
    case "RepoUnavailable":
      return { error: "repo not found or not ready" }
    case "ArtifactsReadFailed":
      return { error: "artifacts read failed" }
  }
}
