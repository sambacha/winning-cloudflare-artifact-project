/**
 * The Cloudflare Artifacts surface used by Bayesian bisection, written down
 * from the Artifacts documentation shipped with this repository
 * (`cloudflare-artifacts.md`, pages "Workers binding", "REST API", "Errors",
 * "Limits").
 *
 * What the documentation fixes, and what this module relies on:
 *
 * - Namespace binding `env.ARTIFACTS` with `get(name)`, which returns a
 *   **disposable** repository capability (`ArtifactsRepo implements
 *   Disposable`; "Declare the handle with `using` so it is released before
 *   the request ends"). `get()` throws if the repo does not exist or is not
 *   ready yet. `withRepo` below always disposes the handle, also on errors.
 * - Repository methods `info()`, `log(opts?)`, `readCommit(hash)`,
 *   `readTree(hash)`, `createToken(scope?, ttl?)`.
 * - `log({ ref = "HEAD", limit = 50 (max 1000), offset = 0 })` follows the
 *   **first-parent** chain, returns commits **newest first**, and returns an
 *   **empty array** when the ref cannot be resolved.
 * - `readCommit(hash)` returns `null` for a missing commit.
 * - `createToken(scope = "write", ttl)` returns `{ plaintext, expiresAt }`.
 *   The REST route accepts TTLs from 60 to 31,536,000 seconds
 *   (`INVALID_TTL`, 10103).
 * - Repo and namespace names start with a letter or digit; the remaining
 *   characters may be letters, digits, `.`, `_`, `-`. Namespace names are 2–63
 *   characters.
 *
 * What the documentation does **not** fix: the field names of
 * `ArtifactsCommitMetadata` and `ArtifactsTreeEntry` (the docs only name the
 * types; `wrangler types` generates them). The only commit record whose
 * fields the docs show is the `pushed` event (`id`, `message`, `timestamp`,
 * `author`, `committer`, `parents`). `normalizeCommit` therefore accepts the
 * commit id under any of `oid`, `id`, `hash`, `sha` and rejects records with
 * none of them, instead of silently guessing. Replace it with the generated
 * type once `wrangler types` has been run against a real namespace (see the
 * "blocked" list in `docs/bisect-report.md`).
 */

import { Data, Duration, Effect } from "../fx/index.js"

/** Documented maximum page size of `log()`. */
export const LOG_PAGE_LIMIT = 1000
/** Documented default page size of `log()`. */
export const LOG_DEFAULT_LIMIT = 50
/** Documented TTL range of repo tokens, in seconds. */
export const TOKEN_TTL_MIN_S = 60
export const TOKEN_TTL_MAX_S = 31_536_000

export type TokenScope = "read" | "write"

export interface LogOptions {
  readonly ref?: string
  readonly limit?: number
  readonly offset?: number
}

/** A commit as bisection uses it. `oid` is the Git commit hash. */
export interface CommitInfo {
  readonly oid: string
  readonly message?: string
  readonly parents?: ReadonlyArray<string>
  readonly timestamp?: string
}

export interface ArtifactsRepoInfoLike {
  readonly name: string
  readonly remote: string
  readonly defaultBranch?: string
}

export interface ArtifactsTokenLike {
  /** The Git token string (`art_v1_…?expires=…`). Secret: never log it. */
  readonly plaintext: string
  readonly expiresAt: string
}

/**
 * The repository capability returned by `env.ARTIFACTS.get(name)`, reduced to
 * the methods bisection calls. Results are `unknown`-typed where the
 * documentation does not give field names; they go through the normalisers
 * below.
 */
export interface ArtifactsRepoLike {
  readonly log: (opts?: LogOptions) => Promise<ReadonlyArray<unknown>>
  readonly readCommit?: (hash: string) => Promise<unknown | null>
  readonly info?: () => Promise<unknown>
  readonly createToken?: (scope?: TokenScope, ttl?: number) => Promise<unknown>
}

/** `env.ARTIFACTS`, reduced to `get`. A real binding satisfies it structurally. */
export interface ArtifactsNamespaceLike {
  readonly get: (name: string) => Promise<ArtifactsRepoLike>
}

/** An Artifacts response did not have the documented shape. */
export class ArtifactsShapeError extends Data.TaggedError("ArtifactsShapeError")<{ readonly message: string }> {
  override readonly name = "ArtifactsShapeError"
  /** @param message - What was wrong with the response. */
  constructor(message: string) {
    super({ message })
  }
}

/** A repo or namespace name breaks the documented naming rule. */
export class InvalidArtifactsName extends Data.TaggedError("InvalidArtifactsName")<{ readonly message: string }> {
  override readonly name = "InvalidArtifactsName"
  /** @param message - The offending name, quoted. */
  constructor(message: string) {
    super({ message })
  }
}

/**
 * A call to an external system (the Artifacts binding or REST API, Git, the
 * bisect Worker) failed. `cause` is the original error, unchanged, so
 * callers can classify it (for example `ArtifactsApiError.status`);
 * `message` is the cause's message.
 */
export class UpstreamError extends Data.TaggedError("UpstreamError")<{
  readonly operation: string
  readonly cause: unknown
  readonly message: string
}> {
  override readonly name = "UpstreamError"
}

/**
 * Lifts one Promise-returning call to an external system into an effect.
 * Interrupting the effect does not cancel the underlying call (the binding
 * has no cancellation); its result is then ignored.
 *
 * @param operation - Name of the call, for diagnostics.
 * @param f - The call.
 * @returns An effect failing with {@link UpstreamError} when the call rejects.
 */
export const callUpstream = <A>(operation: string, f: () => Promise<A>): Effect.Effect<A, UpstreamError> =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new UpstreamError({ operation, cause, message: cause instanceof Error ? cause.message : String(cause) })
  })

/**
 * Runs a synchronous validator inside an effect: its thrown error becomes
 * the typed failure `E` (validators throw only their documented error).
 *
 * @param f - The validator.
 * @returns An effect succeeding with its result.
 */
export const validate = <A, E>(f: () => A): Effect.Effect<A, E> =>
  Effect.try({ try: f, catch: (e) => e as E })

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Documented repo-name rule. Throws `InvalidArtifactsName` otherwise. */
export const checkRepoName = (name: string): string => {
  if (!NAME_RE.test(name)) throw new InvalidArtifactsName(`invalid Artifacts repo name ${JSON.stringify(name)}`)
  return name
}

/** Documented namespace-name rule (2–63 characters, same alphabet). */
export const checkNamespaceName = (name: string): string => {
  if (!NAME_RE.test(name) || name.length < 2 || name.length > 63) {
    throw new InvalidArtifactsName(`invalid Artifacts namespace name ${JSON.stringify(name)}`)
  }
  return name
}

/** Documented token TTL range. */
export const checkTokenTtl = (ttl: number): number => {
  if (!Number.isSafeInteger(ttl) || ttl < TOKEN_TTL_MIN_S || ttl > TOKEN_TTL_MAX_S) {
    throw new RangeError(`token ttl must be an integer in [${TOKEN_TTL_MIN_S}, ${TOKEN_TTL_MAX_S}] seconds, got ${ttl}`)
  }
  return ttl
}

/** `limit` as `log()` accepts it: a positive integer ≤ 1000. */
export const checkLogLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOG_PAGE_LIMIT) {
    throw new RangeError(`log limit must be an integer in [1, ${LOG_PAGE_LIMIT}], got ${limit}`)
  }
  return limit
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

const firstString = (r: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const k of keys) {
    const v = r[k]
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

/** Field names under which a commit id may arrive (see the module comment). */
export const COMMIT_ID_FIELDS = ["oid", "id", "hash", "sha"] as const

/** Convert one `ArtifactsCommitMetadata` record into a `CommitInfo`. */
export const normalizeCommit = (raw: unknown): CommitInfo => {
  if (!isRecord(raw)) throw new ArtifactsShapeError(`commit record is not an object: ${JSON.stringify(raw)}`)
  const oid = firstString(raw, COMMIT_ID_FIELDS)
  if (oid === undefined) {
    throw new ArtifactsShapeError(
      `commit record has none of the fields ${COMMIT_ID_FIELDS.join(", ")}: keys ${JSON.stringify(Object.keys(raw))}`
    )
  }
  const message = firstString(raw, ["message", "subject"])
  const timestamp = firstString(raw, ["timestamp", "date"])
  const parents = Array.isArray(raw["parents"]) && raw["parents"].every((p) => typeof p === "string") ? (raw["parents"] as string[]) : undefined
  return {
    oid,
    ...(message !== undefined ? { message } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(parents !== undefined ? { parents } : {})
  }
}

/** Convert `info()` output (Workers: camelCase; REST: snake_case). */
export const normalizeRepoInfo = (raw: unknown): ArtifactsRepoInfoLike => {
  if (!isRecord(raw)) throw new ArtifactsShapeError("repo info is not an object")
  const name = firstString(raw, ["name"])
  const remote = firstString(raw, ["remote"])
  if (name === undefined || remote === undefined) throw new ArtifactsShapeError("repo info lacks name or remote")
  const defaultBranch = firstString(raw, ["defaultBranch", "default_branch"])
  return { name, remote, ...(defaultBranch !== undefined ? { defaultBranch } : {}) }
}

/** Convert `createToken()` output (Workers: `expiresAt`; REST: `expires_at`). */
export const normalizeToken = (raw: unknown): ArtifactsTokenLike => {
  if (!isRecord(raw)) throw new ArtifactsShapeError("token result is not an object")
  const plaintext = firstString(raw, ["plaintext"])
  const expiresAt = firstString(raw, ["expiresAt", "expires_at"])
  if (plaintext === undefined || expiresAt === undefined) throw new ArtifactsShapeError("token result lacks plaintext or expiry")
  return { plaintext, expiresAt }
}

const disposeSymbol: symbol | undefined = (Symbol as unknown as { dispose?: symbol }).dispose

/** Release a repository capability (`Disposable`), if it is one. */
export const disposeRepo = (repo: unknown): void => {
  if (disposeSymbol === undefined || (!isRecord(repo) && typeof repo !== "function")) return
  const f = (repo as Record<symbol, unknown>)[disposeSymbol]
  if (typeof f === "function") f.call(repo)
}

/**
 * `using repo = await artifacts.get(name)` as an effect: open the handle,
 * run `use` on it, and dispose it afterwards whether `use` succeeds, fails
 * or is interrupted (`Effect.acquireUseRelease`).
 *
 * @param artifacts - The namespace (Workers binding or REST client).
 * @param name - Repository name (checked against the naming rule first).
 * @param use - The work to do with the handle.
 * @returns The result of `use`.
 */
export const withRepo = <A, E, R>(
  artifacts: ArtifactsNamespaceLike,
  name: string,
  use: (repo: ArtifactsRepoLike) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | InvalidArtifactsName | UpstreamError, R> =>
  Effect.acquireUseRelease(
    Effect.andThen(validate<string, InvalidArtifactsName>(() => checkRepoName(name)), (checked) =>
      callUpstream("artifacts.get", () => artifacts.get(checked))
    ),
    use,
    (repo) =>
      Effect.sync(() => {
        disposeRepo(repo)
      })
  )

const HASH_RE = /^[0-9a-f]{40}$/i

/** Does `ref` look like a full SHA-1 commit hash? */
export const isFullHash = (ref: string): boolean => HASH_RE.test(ref)

/**
 * A short-lived token and the remote a runner needs to check out commits of
 * the repo with a standard Git client:
 *
 *     git -c http.extraHeader="Authorization: Bearer $TOKEN" clone $REMOTE
 *
 * (the documented header form, which keeps the token out of the remote URL).
 *
 * @param repo - The repository handle.
 * @param scope - Token scope.
 * @param ttl - Token lifetime; sent as whole seconds (the documented range is
 * checked by `checkTokenTtl`, so a fractional number of seconds is a `RangeError`).
 * @returns Remote, repo info and the minted token.
 */
export const checkoutCredentials = (
  repo: ArtifactsRepoLike,
  scope: TokenScope,
  ttl: Duration.Duration
): Effect.Effect<
  { readonly remote: string; readonly info: ArtifactsRepoInfoLike; readonly token: ArtifactsTokenLike },
  ArtifactsShapeError | RangeError | UpstreamError
> =>
  Effect.gen(function* () {
    const { info: readInfo, createToken } = repo
    if (readInfo === undefined || createToken === undefined) {
      return yield* Effect.fail(new ArtifactsShapeError("repository handle lacks info() or createToken()"))
    }
    const ttlSeconds = yield* validate<number, RangeError>(() => checkTokenTtl(Duration.toSeconds(ttl)))
    const rawInfo = yield* callUpstream("repo.info", () => readInfo.call(repo))
    const info = yield* validate<ArtifactsRepoInfoLike, ArtifactsShapeError>(() => normalizeRepoInfo(rawInfo))
    const rawToken = yield* callUpstream("repo.createToken", () => createToken.call(repo, scope, ttlSeconds))
    const token = yield* validate<ArtifactsTokenLike, ArtifactsShapeError>(() => normalizeToken(rawToken))
    return { remote: info.remote, info, token }
  })
