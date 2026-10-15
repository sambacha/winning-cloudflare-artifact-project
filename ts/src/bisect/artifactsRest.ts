/**
 * Cloudflare Artifacts REST client, for running bisection outside a Worker
 * (a CI job, a laptop). It implements the same `ArtifactsNamespaceLike`
 * interface as the Workers binding, so `withRepo`, `commitRange` and the
 * session code do not care which one they get.
 *
 * Routes and envelope, from the REST API reference in
 * `cloudflare-artifacts.md`:
 *
 *   base   https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces/$NAMESPACE
 *   auth   Authorization: Bearer $CLOUDFLARE_API_TOKEN
 *   GET    /repos/:name                          RepoWithRemote
 *   GET    /repos/:name/log?ref=&limit=&offset=  commit history
 *   GET    /repos/:name/commit/:hash             one commit
 *   POST   /tokens  { repo, scope, ttl }         { id, plaintext, scope, expires_at }
 *
 * JSON responses use the v4 envelope `{ result, success, errors, messages }`;
 * errors carry the documented codes (`NOT_FOUND` 10200, `FORK_IN_PROGRESS`
 * 10303, …). The docs say a repo that is still importing or forking "can
 * return `409 Conflict` with a retriable error message"; those, `429`, `5xx`
 * and `UPSTREAM_UNAVAILABLE` are retried with exponential backoff (honouring
 * `Retry-After`). Everything else fails at once.
 *
 * Not documented, and therefore handled defensively: the JSON shape of the
 * `log` result (an array is expected; `{ commits: [...] }` is also accepted)
 * and of a commit record (see `normalizeCommit`).
 *
 * Effect structure: {@link RestClient.request} and
 * {@link RestClient.createRepo} are effects; retries are driven by
 * {@link restRetryPolicy} under `Effect.retry`, whose waits go through
 * `Clock` (so `TestClock` controls them in tests, and `onRetry` observes each
 * planned retry before its wait). The repository handles
 * returned by `get` keep the Promise shape of the Workers binding
 * (`ArtifactsRepoLike`), so that the same code accepts either; they run the
 * request effect with `runPromiseOrThrow`, which rejects with the
 * `ArtifactsApiError` itself.
 *
 * @packageDocumentation
 */
import {
  type ArtifactsNamespaceLike,
  type ArtifactsRepoLike,
  checkLogLimit,
  checkNamespaceName,
  checkRepoName,
  checkTokenTtl,
  InvalidArtifactsName,
  type LogOptions,
  type TokenScope,
  validate
} from "./artifactsApi.js"
import { Data, Duration, Effect, Redacted, runPromiseOrThrow, Schedule } from "../fx/index.js"

/** Documented Artifacts error codes. */
export const ARTIFACTS_ERROR_CODES = {
  ALREADY_EXISTS: 10201,
  NOT_FOUND: 10200,
  IMPORT_IN_PROGRESS: 10302,
  FORK_IN_PROGRESS: 10303,
  INVALID_INPUT: 10100,
  INVALID_REPO_NAME: 10101,
  INVALID_TTL: 10103,
  INVALID_URL: 10104,
  REMOTE_AUTH_REQUIRED: 10106,
  UPSTREAM_UNAVAILABLE: 10401,
  MEMORY_LIMIT: 10402,
  INTERNAL_ERROR: 10400
} as const

const RETRIABLE_CODES: ReadonlySet<number> = new Set([
  ARTIFACTS_ERROR_CODES.IMPORT_IN_PROGRESS,
  ARTIFACTS_ERROR_CODES.FORK_IN_PROGRESS,
  ARTIFACTS_ERROR_CODES.UPSTREAM_UNAVAILABLE
])

/** One entry of the v4 envelope's `errors` array. */
export interface ApiErrorEntry {
  readonly code: number
  readonly message: string
}

/** A REST call failed (HTTP status and the envelope's error entries). */
export class ArtifactsApiError extends Data.TaggedError("ArtifactsApiError")<{
  readonly status: number
  readonly errors: ReadonlyArray<ApiErrorEntry>
  readonly method: string
  readonly path: string
  readonly message: string
  /** The server's `Retry-After`, when it sent one. */
  readonly retryAfter: Duration.Duration | undefined
}> {
  override readonly name = "ArtifactsApiError"
  /**
   * @param status - HTTP status.
   * @param errors - Envelope error entries.
   * @param method - HTTP method.
   * @param path - Request path below the namespace base URL.
   * @param retryAfter - Parsed `Retry-After` header, if any.
   */
  constructor(status: number, errors: ReadonlyArray<ApiErrorEntry>, method: string, path: string, retryAfter?: Duration.Duration) {
    super({
      status,
      errors,
      method,
      path,
      retryAfter,
      message: `${method} ${path} failed with HTTP ${status}: ${
        errors.length === 0 ? "(no error details)" : errors.map((e) => `${e.code} ${e.message}`).join("; ")
      }`
    })
  }
  /** Does the envelope carry error `code`? */
  hasCode(code: number): boolean {
    return this.errors.some((e) => e.code === code)
  }
  /**
   * Retry this request? (409 other than `ALREADY_EXISTS`, 429, 5xx, or a
   * retriable code.) `INTERNAL_ERROR` (10400) is never retried, whatever its
   * HTTP status: it is deliberately absent from `RETRIABLE_CODES`, and the
   * 5xx rule must not bring it back.
   */
  get retriable(): boolean {
    if (this.hasCode(ARTIFACTS_ERROR_CODES.INTERNAL_ERROR)) return false
    return (this.status === 409 && !this.hasCode(ARTIFACTS_ERROR_CODES.ALREADY_EXISTS)) || this.status === 429 || this.status >= 500 || this.errors.some((e) => RETRIABLE_CODES.has(e.code))
  }
}

/** The request transport itself failed (DNS, TLS, connection reset). */
export class ArtifactsTransportError extends Data.TaggedError("ArtifactsTransportError")<{ readonly message: string; readonly cause: unknown }> {
  override readonly name = "ArtifactsTransportError"
}

/** Failures of {@link RestClient.request}. */
export type RestError = ArtifactsApiError | ArtifactsTransportError

/** The subset of `fetch` the client uses. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>

/** Configuration of {@link makeArtifactsRestClient}. */
export interface RestClientConfig {
  readonly accountId: string
  readonly namespace: string
  /** Cloudflare API token with Artifacts Read (and Edit for tokens). Secret: kept `Redacted`. */
  readonly apiToken: string | Redacted.Redacted<string>
  readonly fetch?: FetchLike
  /** Override of `https://api.cloudflare.com/client/v4`. */
  readonly apiBase?: string
  /** Attempts per request, including the first (default 5). */
  readonly maxAttempts?: number
  /** First backoff delay, doubled per retry (default 500 ms). */
  readonly baseDelay?: Duration.Input
  /** Observes each planned retry, before its wait (metrics, logs, tests). */
  readonly onRetry?: (retry: RetryEvent) => void
}

/** One planned retry of a REST request. */
export interface RetryEvent {
  /** 1 for the first retry. */
  readonly attempt: number
  /** How long the client waits before it. */
  readonly delay: Duration.Duration
  /** The failure being retried. */
  readonly error: ArtifactsApiError
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

/** The JSON envelope of a response body, or `null` when it is not JSON. */
const parseEnvelope = (text: string): unknown => {
  try {
    return text.length > 0 ? (JSON.parse(text) as unknown) : null
  } catch {
    return null
  }
}

const parseErrors = (raw: unknown): ApiErrorEntry[] =>
  Array.isArray(raw)
    ? raw.filter(isRecord).map((e) => ({ code: typeof e["code"] === "number" ? e["code"] : 0, message: String(e["message"] ?? "") }))
    : []

/**
 * The `Retry-After` header as a delay: a non-negative number of seconds, or
 * `undefined` when absent or not a number (HTTP-date values are not used by
 * the Artifacts API).
 *
 * @param header - The raw header value.
 * @returns The delay, if the header gives one.
 */
export const parseRetryAfter = (header: string | null): Duration.Duration | undefined => {
  const s = header === null ? NaN : Number(header)
  if (Number.isFinite(s) && s >= 0) return Duration.seconds(s)
  return undefined
}

/**
 * The documented retry policy as a schedule: exponential backoff from
 * `baseDelay`, never shorter than the server's `Retry-After` when present
 * (`Schedule.modifyDelay` with `Duration.max`), only for retriable failures (`Schedule.while`),
 * at most `maxAttempts - 1` retries (`Schedule.upTo`), each observed by
 * `onRetry` before its wait (`Schedule.tap`, after the limit).
 *
 * @remarks
 * The retriability check is the **first** step of the schedule, not a
 * `while` option of `Effect.retry`. `Effect.retry({ schedule, while })`
 * runs one step of `schedule` (including its `modifyDelay` and `tap`
 * callbacks) *before* it evaluates `while`: with the installed
 * `effect@3.22.2`, a transport error would reach `onRetry` and the
 * `Retry-After` merge before the retry was abandoned
 * (`test/fx/schedule.test.ts`, "Effect.retry while runs after the
 * schedule step", pins this). Gating inside the schedule means a
 * transport error or a non-retriable API error fails at once and is never
 * observed as a planned retry.
 *
 * @param maxAttempts - Attempts including the first.
 * @param baseDelay - First backoff delay.
 * @param onRetry - Observer of planned retries.
 * @returns The schedule for `Effect.retry`.
 */
export const restRetryPolicy = (maxAttempts: number, baseDelay: Duration.Input, onRetry?: (retry: RetryEvent) => void) =>
  Schedule.exponential(baseDelay).pipe(
    Schedule.setInputType<RestError>(),
    Schedule.while(({ input }) => input._tag === "ArtifactsApiError" && input.retriable),
    Schedule.modifyDelay(({ duration, input }) =>
      Effect.succeed(input._tag === "ArtifactsApiError" && input.retryAfter !== undefined ? Duration.max(duration, input.retryAfter) : duration)
    ),
    Schedule.upTo({ times: Math.max(0, maxAttempts - 1) }),
    Schedule.tap(({ attempt, duration, input }) =>
      Effect.sync(() => {
        if (input._tag === "ArtifactsApiError") onRetry?.({ attempt, delay: duration, error: input })
      })
    )
  )

/** `POST /repos` result (`CreateRepoResult` in the REST reference). The token is a secret. */
export interface CreatedRepo {
  readonly name: string
  readonly remote: string
  readonly defaultBranch: string
  readonly token: string
}

/** The REST client: a namespace (`get`) plus repo creation and raw requests. */
export interface RestClient extends ArtifactsNamespaceLike {
  readonly baseUrl: string
  /**
   * `POST /repos { name, description?, default_branch?, read_only: false }`.
   * Succeeds with `null` when the repo already exists (`ALREADY_EXISTS`, 10201).
   */
  readonly createRepo: (
    name: string,
    opts?: { readonly description?: string; readonly defaultBranch?: string }
  ) => Effect.Effect<CreatedRepo | null, RestError | InvalidArtifactsName>
  /** Low-level request succeeding with the envelope's `result`, retried as described above. */
  readonly request: (
    method: string,
    path: string,
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown }
  ) => Effect.Effect<unknown, RestError>
}

/**
 * Build a REST client for one namespace.
 *
 * @param cfg - Account, namespace, API token, and test seams.
 * @returns The client.
 * @throws `Error` for an empty token or a non-alphanumeric account id;
 * `InvalidArtifactsName` for an invalid namespace.
 */
export const makeArtifactsRestClient = (cfg: RestClientConfig): RestClient => {
  if ((Redacted.isRedacted(cfg.apiToken) ? Redacted.value(cfg.apiToken) : cfg.apiToken).length === 0) {
    throw new Error("empty Cloudflare API token")
  }
  if (!/^[A-Za-z0-9]+$/.test(cfg.accountId)) throw new Error("account id must be alphanumeric")
  const namespace = checkNamespaceName(cfg.namespace)
  const fetchFn: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, init))
  const apiToken = Redacted.isRedacted(cfg.apiToken) ? cfg.apiToken : Redacted.make(cfg.apiToken)
  const maxAttempts = cfg.maxAttempts ?? 5
  const baseDelay = cfg.baseDelay ?? Duration.millis(500)
  const baseUrl = `${cfg.apiBase ?? "https://api.cloudflare.com/client/v4"}/accounts/${cfg.accountId}/artifacts/namespaces/${encodeURIComponent(namespace)}`

  const policy = restRetryPolicy(maxAttempts, baseDelay, cfg.onRetry)

  /** One attempt: the response's `result`, or the typed failure. */
  const attempt = (method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown }) =>
    Effect.gen(function* () {
      const qs = Object.entries(opts.query ?? {})
        .filter((e): e is [string, string | number] => e[1] !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
      const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`
      const headers: Record<string, string> = { authorization: `Bearer ${Redacted.value(apiToken)}`, accept: "application/json" }
      if (opts.body !== undefined) headers["content-type"] = "application/json"
      const { res, text } = yield* Effect.tryPromise({
        try: async () => {
          const res = await fetchFn(url, {
            method,
            headers,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
          })
          return { res, text: await res.text() }
        },
        catch: (cause) =>
          new ArtifactsTransportError({ message: `${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
      })
      const env = parseEnvelope(text)
      if (res.ok && isRecord(env) && env["success"] === true) return env["result"]
      return yield* Effect.fail(
        new ArtifactsApiError(res.status, isRecord(env) ? parseErrors(env["errors"]) : [], method, path, parseRetryAfter(res.headers.get("retry-after")))
      )
    })

  const request: RestClient["request"] = (method, path, opts = {}) => attempt(method, path, opts).pipe(Effect.retry(policy))

  const repoHandle = (name: string): ArtifactsRepoLike => {
    const base = `/repos/${encodeURIComponent(name)}`
    return {
      info: () => runPromiseOrThrow(request("GET", base)),
      log: (opts: LogOptions = {}) =>
        runPromiseOrThrow(
          Effect.gen(function* () {
            const limit = opts.limit === undefined ? undefined : yield* validate<number, RangeError>(() => checkLogLimit(opts.limit!))
            const result = yield* request("GET", `${base}/log`, { query: { ref: opts.ref, limit, offset: opts.offset } })
            if (Array.isArray(result)) return result as ReadonlyArray<unknown>
            if (isRecord(result) && Array.isArray(result["commits"])) return result["commits"] as ReadonlyArray<unknown>
            return yield* Effect.fail(
              new ArtifactsApiError(200, [{ code: 0, message: "log result is neither an array nor { commits: [] }" }], "GET", `${base}/log`)
            )
          })
        ),
      readCommit: (hash: string) =>
        runPromiseOrThrow(
          Effect.catchIf(
            request("GET", `${base}/commit/${encodeURIComponent(hash)}`),
            (e): e is ArtifactsApiError => e instanceof ArtifactsApiError && (e.status === 404 || e.hasCode(ARTIFACTS_ERROR_CODES.NOT_FOUND)),
            () => Effect.succeed(null)
          )
        ),
      createToken: (scope: TokenScope = "write", ttl?: number) =>
        runPromiseOrThrow(
          Effect.flatMap(
            validate<number | undefined, RangeError>(() => (ttl === undefined ? undefined : checkTokenTtl(ttl))),
            (checked) => request("POST", "/tokens", { body: { repo: name, scope, ...(checked !== undefined ? { ttl: checked } : {}) } })
          )
        )
    }
  }

  const createRepo: RestClient["createRepo"] = (name, opts = {}) =>
    Effect.gen(function* () {
      yield* validate<string, InvalidArtifactsName>(() => checkRepoName(name))
      const r = yield* Effect.catchIf(
        request("POST", "/repos", {
          body: {
            name,
            ...(opts.description !== undefined ? { description: opts.description } : {}),
            ...(opts.defaultBranch !== undefined ? { default_branch: opts.defaultBranch } : {}),
            read_only: false
          }
        }),
        (e): e is ArtifactsApiError => e instanceof ArtifactsApiError && e.hasCode(ARTIFACTS_ERROR_CODES.ALREADY_EXISTS),
        () => Effect.succeed(ALREADY_EXISTS)
      )
      if (r === ALREADY_EXISTS) return null
      if (!isRecord(r) || typeof r["remote"] !== "string" || typeof r["token"] !== "string") {
        return yield* Effect.fail(new ArtifactsApiError(200, [{ code: 0, message: "create repo result lacks remote or token" }], "POST", "/repos"))
      }
      return {
        name: typeof r["name"] === "string" ? r["name"] : name,
        remote: r["remote"],
        defaultBranch: typeof r["default_branch"] === "string" ? r["default_branch"] : (opts.defaultBranch ?? "main"),
        token: r["token"]
      }
    })

  return {
    baseUrl,
    request,
    createRepo,
    // Like the binding's `get()`: fails if the repo does not exist (NOT_FOUND) or is not ready.
    get: (name: string) =>
      runPromiseOrThrow(
        Effect.as(
          Effect.andThen(validate<string, InvalidArtifactsName>(() => checkRepoName(name)), request("GET", `/repos/${encodeURIComponent(name)}`)),
          repoHandle(name)
        )
      )
  }
}

/** Sentinel for "the repo already exists" inside {@link makeArtifactsRestClient}. */
const ALREADY_EXISTS: unique symbol = Symbol("ALREADY_EXISTS")
