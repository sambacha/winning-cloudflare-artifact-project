/**
 * Driving a session to the end: ask for the next commit, run the test there,
 * record the outcome, repeat until the session is done.
 *
 * - {@link driveSession} advances an in-process session (local CLI).
 * - {@link makeBisectApiClient} + {@link driveRemoteSession} advance a
 *   session held by the Worker (`/api/bisect`), so several machines can
 *   share one search.
 *
 * All three are effects. The test runner passed in is an effect too, so
 * interrupting a drive interrupts the running test. The client's HTTP
 * retries are a `Schedule` ({@link bisectRetryPolicy}) applied with
 * `Effect.retry`, so tests drive them with the `TestClock`.
 *
 * @packageDocumentation
 */
import type { CommitInfo } from "./artifactsApi.js"
import type { RunOutcome } from "./engine.js"
import { type BisectSession, recordResult, recordSkip, SessionError, type SessionStatus, sessionStatus } from "./session.js"
import { validate } from "./artifactsApi.js"
import { Data, Duration, Effect, Redacted, Schedule } from "../fx/index.js"

/** One completed step of a drive. */
export interface StepReport {
  readonly commit: CommitInfo
  readonly outcome: RunOutcome
  readonly status: SessionStatus
}

/** Options of {@link driveSession}. */
export interface DriveOptions<E2, R2> {
  /** Wall clock for event timestamps (milliseconds). */
  readonly now: () => number
  /** Called after each recorded step. */
  readonly onStep?: (r: StepReport) => void
  /** Persists the session after each step. */
  readonly save?: (s: BisectSession) => Effect.Effect<void, E2, R2>
}

/**
 * Run the test at the session's next commit, record the result, and repeat
 * until the session is done.
 *
 * @param start - The session to advance.
 * @param run - Runs the test at a commit.
 * @param opts - Clock, progress callback, persistence.
 * @returns The final session and its status.
 */
export const driveSession = <E, R, E2 = never, R2 = never>(
  start: BisectSession,
  run: (commit: CommitInfo) => Effect.Effect<RunOutcome, E, R>,
  opts: DriveOptions<E2, R2>
): Effect.Effect<{ readonly session: BisectSession; readonly status: SessionStatus }, E | E2 | SessionError, R | R2> =>
  Effect.gen(function* () {
    let s = start
    for (;;) {
      const st = yield* validate<SessionStatus, SessionError>(() => sessionStatus(s))
      if (st.done || st.next === null) return { session: s, status: st }
      const commit = st.next
      const outcome = yield* run(commit)
      const cur = s
      s = yield* validate<BisectSession, SessionError>(() =>
        outcome === "skip" ? recordSkip(cur, commit.oid, opts.now()) : recordResult(cur, commit.oid, outcome, opts.now())
      )
      if (opts.save) yield* opts.save(s)
      opts.onStep?.({ commit, outcome, status: sessionStatus(s) })
    }
  })

// ---------------------------------------------------------------------------
// Worker API client

/** A session status as the Worker returns it. */
export interface RemoteStatus {
  readonly id: string
  readonly repo: string
  readonly status: SessionStatus
}

/** Checkout credentials as the Worker returns them. */
export interface RemoteCredentials {
  readonly remote: string
  readonly token: string
  readonly expiresAt: string
  readonly commit: string | null
}

/** The Worker answered with a non-success status (after retries), or could not be reached (`status` 0). */
export class BisectApiError extends Data.TaggedError("BisectApiError")<{
  readonly status: number
  readonly message: string
  /** The Worker's `Retry-After`, when it sent one. */
  readonly retryAfter: Duration.Duration | undefined
}> {
  override readonly name = "BisectApiError"
  /**
   * @param status - HTTP status, or `0` when the request itself failed.
   * @param message - Method, path and the Worker's error text.
   * @param retryAfter - Parsed `Retry-After` header, if any.
   */
  constructor(status: number, message: string, retryAfter?: Duration.Duration) {
    super({ status, message, retryAfter })
  }
  /** Retry this call? (409 concurrent update, 503 R2 per-key write limit.) */
  get retriable(): boolean {
    return this.status === 409 || this.status === 503
  }
}

/** Typed client of the Worker's `/api/bisect` routes. */
export interface BisectApiClient {
  readonly start: (body: Record<string, unknown>) => Effect.Effect<RemoteStatus, BisectApiError>
  readonly status: (id: string) => Effect.Effect<RemoteStatus, BisectApiError>
  readonly result: (id: string, commit: string, result: "fail" | "pass" | "skip") => Effect.Effect<RemoteStatus, BisectApiError>
  readonly undo: (id: string) => Effect.Effect<RemoteStatus, BisectApiError>
  readonly credentials: (id: string) => Effect.Effect<RemoteCredentials, BisectApiError>
}

/** Configuration of {@link makeBisectApiClient}. */
export interface BisectApiClientConfig {
  readonly baseUrl: string
  /** Bearer token of the Worker. Secret: kept `Redacted`. */
  readonly token: string | Redacted.Redacted<string>
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Maximum attempts per call, including the first (default 6). */
  readonly maxAttempts?: number
  /** Wait between retries when the Worker sends no `Retry-After` (default 1 s). */
  readonly retrySpacing?: Duration.Input
}

/**
 * The `Retry-After` header as a delay (non-negative seconds), or `undefined`.
 *
 * @param header - The raw header value.
 * @returns The delay, if the header gives one.
 */
const retryAfterHeader = (header: string | null): Duration.Duration | undefined => {
  const s = header === null ? NaN : Number(header)
  return Number.isFinite(s) && s >= 0 ? Duration.seconds(s) : undefined
}

/**
 * The client's retry policy: fixed spacing (`Schedule.spaced`), never shorter
 * than the Worker's `Retry-After` (`Schedule.modifyDelay` with `Duration.max`), only for retriable
 * statuses (`Schedule.while`), at most `maxAttempts - 1` retries
 * (`Schedule.upTo`, which allows `maxAttempts` executions in all).
 *
 * @param maxAttempts - Attempts including the first.
 * @param spacing - Default wait between attempts.
 * @returns The schedule for `Effect.retry`.
 */
export const bisectRetryPolicy = (maxAttempts: number, spacing: Duration.Input) =>
  Schedule.spaced(spacing).pipe(
    Schedule.setInputType<BisectApiError>(),
    Schedule.while(({ input }) => input.retriable),
    Schedule.modifyDelay(({ duration, input }) => Effect.succeed(input.retryAfter === undefined ? duration : Duration.max(duration, input.retryAfter))),
    Schedule.upTo({ times: Math.max(0, maxAttempts - 1) })
  )

/**
 * Build a client of the Worker API. Responses 409 (concurrent update) and
 * 503 (R2 per-key write limit) are retried with {@link bisectRetryPolicy},
 * waiting `Retry-After` seconds (default 1 s), up to `maxAttempts` attempts.
 *
 * @param cfg - Base URL, bearer token, and test seams.
 * @returns The client.
 */
export const makeBisectApiClient = (cfg: BisectApiClientConfig): BisectApiClient => {
  const f = cfg.fetch ?? ((u, i) => fetch(u, i))
  const token = Redacted.isRedacted(cfg.token) ? cfg.token : Redacted.make(cfg.token)
  const policy = bisectRetryPolicy(cfg.maxAttempts ?? 6, cfg.retrySpacing ?? Duration.seconds(1))
  const base = cfg.baseUrl.replace(/\/+$/, "")
  const once = (method: string, path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const res = await f(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${Redacted.value(token)}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        })
        const text = await res.text()
        const parsed: unknown = text.length > 0 ? JSON.parse(text) : null
        return { res, text, parsed }
      },
      catch: (e) => new BisectApiError(0, `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`)
    })
  /** One attempt: the parsed body, or the typed failure. */
  const attempt = (method: string, path: string, body?: unknown): Effect.Effect<unknown, BisectApiError> =>
    Effect.gen(function* () {
      const { res, text, parsed } = yield* once(method, path, body)
      if (res.ok) return parsed
      const msg = typeof parsed === "object" && parsed !== null && "error" in parsed ? String((parsed as { error: unknown }).error) : text
      return yield* Effect.fail(
        new BisectApiError(res.status, `${method} ${path}: HTTP ${res.status}: ${msg}`, retryAfterHeader(res.headers.get("retry-after")))
      )
    })
  const call = (method: string, path: string, body?: unknown): Effect.Effect<unknown, BisectApiError> =>
    attempt(method, path, body).pipe(Effect.retry(policy))
  const sid = (id: string) => `/api/bisect/${encodeURIComponent(id)}`
  const asStatus = (e: Effect.Effect<unknown, BisectApiError>) => Effect.map(e, (x) => x as RemoteStatus)
  return {
    start: (body) => asStatus(call("POST", "/api/bisect", body)),
    status: (id) => asStatus(call("GET", sid(id))),
    result: (id, commit, result) => asStatus(call("POST", `${sid(id)}/results`, { commit, result })),
    undo: (id) => asStatus(call("POST", `${sid(id)}/undo`)),
    credentials: (id) => Effect.map(call("POST", `${sid(id)}/credentials`), (x) => x as RemoteCredentials)
  }
}

/**
 * Run the test for the session's next commit until the Worker reports
 * `done`.
 *
 * @param client - Worker API client.
 * @param id - Session id.
 * @param run - Runs the test at a commit.
 * @param onStep - Called after each recorded step.
 * @returns The final remote status.
 */
export const driveRemoteSession = <E, R>(
  client: BisectApiClient,
  id: string,
  run: (commit: CommitInfo) => Effect.Effect<RunOutcome, E, R>,
  onStep?: (r: StepReport) => void
): Effect.Effect<RemoteStatus, E | BisectApiError, R> =>
  Effect.gen(function* () {
    for (;;) {
      const cur = yield* client.status(id)
      if (cur.status.done || cur.status.next === null) return cur
      const commit = cur.status.next
      const outcome = yield* run(commit)
      const after = yield* client.result(id, commit.oid, outcome === "skip" ? "skip" : outcome ? "fail" : "pass")
      onStep?.({ commit, outcome, status: after.status })
    }
  })
