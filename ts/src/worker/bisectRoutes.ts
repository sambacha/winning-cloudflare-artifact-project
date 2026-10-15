/**
 * Bayesian bisection API on a Cloudflare Worker with an Artifacts binding.
 *
 *   POST /api/bisect                      start: { repo, good, bad, newRate?, oldRate?, confidence?, maxSteps?, priors? }
 *   GET  /api/bisect/:id                  status (next commit to test, ranking, confidence)
 *   POST /api/bisect/:id/results          { commit, result: "fail" | "pass" | "skip" }
 *   POST /api/bisect/:id/undo             drop the most recent result
 *   POST /api/bisect/:id/credentials      read-only Git token + remote for checking out commits
 *   GET  /api/bisect/:id/result           the result manifest (manifests/<id>/result.json), 404 until written
 *   POST /api/bisect/:id/approve          { principal, comment? }: write the context note on the culprit, record the approval
 *   POST /api/bisect/:id/reject           { principal, comment }: record the rejection (no note)
 *   POST /api/bisect/:id/drive            { fallbackBranch? }: start the durable BisectWorkflow for the session
 *                                         (the explicit trigger; a CI failure is the other one)
 *
 * A runner loops: GET status → check out `next` → run the build/test →
 * POST the result, until `done`. Several runners can work on one session;
 * results are stored with compare-and-swap (`modifySession`).
 *
 * Artifacts calls (via `withRepo`, which disposes every handle):
 * - start: `repo.log()` / `repo.readCommit()` to resolve the range;
 * - credentials: `repo.info()` for the remote and `repo.createToken("read", ttl)`.
 *   Only read tokens are minted (the docs' least-privilege advice): a bisect
 *   runner never pushes. The token is returned to the authenticated caller
 *   and never logged.
 * - approve: `repo.createToken("write", 300)`, used once, inside the Worker,
 *   to push the note from a sandbox; it is never returned. The review is
 *   recorded in `result.json` with a compare-and-swap, exactly once: a second
 *   approve or reject gets 409. `principal` is the reviewer name the caller
 *   states (the request is authenticated by the write token, not per user).
 */
import {
  type ArtifactsNamespaceLike,
  checkoutCredentials,
  InvalidArtifactsName,
  UpstreamError,
  validate,
  withRepo
} from "../bisect/artifactsApi.js"
import { CommitRangeError } from "../bisect/artifacts.js"
import { ARTIFACTS_ERROR_CODES, ArtifactsApiError } from "../bisect/artifactsRest.js"
import { InvalidModel, type Rate } from "../bisect/model.js"
import {
  type BisectSession,
  modifySession,
  recordResult,
  recordSkip,
  recordStep,
  SessionConflict,
  SessionError,
  type SessionStore,
  sessionStatus,
  sessionTally,
  startSession,
  undoLast
} from "../bisect/session.js"
import { Clock, Duration, Effect, runPromiseOrThrow } from "../fx/index.js"
import { SessionId } from "../ids.js"
import { formatNote, type NoteWriteFailed, type WriteNoteInput, type WriteNoteResult } from "../bisect/notes.js"
import { AlreadyReviewed, type Review, type ResultStore } from "./resultStore.js"

/** Largest accepted `priors` map in POST /api/bisect. */
const MAX_PRIORS = 100_000
/** Idempotency keys of `results` requests. */
const STEP_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/

export interface BisectDeps {
  readonly artifacts: ArtifactsNamespaceLike
  readonly store: SessionStore
  readonly now: () => number
  /** New session id (default: 128 random bits, hex). */
  readonly newId?: () => SessionId
  /** Lifetime of minted read tokens (default 1 hour; whole seconds). */
  readonly tokenTtl?: Duration.Duration
  /** Result manifests (required by `result`, `approve`, `reject`). */
  readonly results?: ResultStore
  /** Writes a note from a fresh sandbox (required by `approve`); the edge passes `writeNote(getSandbox(...), input)`. */
  readonly notes?: (input: WriteNoteInput) => Effect.Effect<WriteNoteResult, NoteWriteFailed>
  /** Creates the BisectWorkflow instance for a session (required by `drive`); returns the instance id. */
  readonly drive?: (p: { readonly sessionId: SessionId; readonly fallbackBranch?: string }) => Effect.Effect<string, unknown>
}

/** Lifetime of the write token minted by `approve`. */
export const APPROVE_TOKEN_TTL = Duration.seconds(300)
/** Longest accepted reviewer name / comment. */
const MAX_PRINCIPAL = 128
const MAX_COMMENT = 2000

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }
  })

const randomId = (): SessionId => {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return SessionId(Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""))
}

const ID_RE = /^[0-9a-f]{8,64}$/

/** A path segment as a {@link SessionId}, if it has the session-id shape (the only place ids from requests are branded). */
const parseSessionId = (raw: string): SessionId | null => (ID_RE.test(raw) ? SessionId(raw) : null)

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

const parseRate = (x: unknown, name: string): Rate | undefined => {
  if (x === undefined) return undefined
  if (isRecord(x) && x["kind"] === "known" && typeof x["p"] === "number") return { kind: "known", p: x["p"] }
  if (isRecord(x) && x["kind"] === "beta" && typeof x["alpha"] === "number" && typeof x["beta"] === "number") {
    return { kind: "beta", alpha: x["alpha"], beta: x["beta"] }
  }
  throw new SessionError(`${name} must be { kind: "known", p } or { kind: "beta", alpha, beta }`)
}

/**
 * Body of the status responses. `tally` (per-commit fail / pass / skip
 * counts) is what the dashboard draws its per-commit bars from; the
 * posterior itself is `status` (computed here, never by the dashboard).
 */
export const statusBody = (id: string, s: BisectSession) => ({
  id,
  repo: s.repo,
  good: s.good,
  badRef: s.badRef,
  candidates: s.candidates.length,
  status: sessionStatus(s),
  tally: sessionTally(s)
})

/** The status response body. */
export type StatusBody = ReturnType<typeof statusBody>

/**
 * The original error behind an {@link UpstreamError} (classification looks
 * at the binding's or REST client's own error), or `e` itself.
 *
 * @param e - Any failure.
 * @returns The underlying error.
 */
export const unwrapUpstream = (e: unknown): unknown => (e instanceof UpstreamError ? e.cause : e)

/** The `code` field of a thrown value, if any (Artifacts binding errors carry `NOT_FOUND`, `10200`, …). */
const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined)

/**
 * "Not found" in the documented sense: Artifacts error `NOT_FOUND` / 10200
 * (`cloudflare-artifacts.md`, Errors), as a structured field (REST status or
 * error entry, binding `code`) or as that identifier in the message. Free
 * text such as "does not exist" is not a classification rule: it matches
 * unrelated failures (a missing bucket binding is a server fault, not a 404).
 */
export const isNotFoundError = (err: unknown): boolean => {
  const e = unwrapUpstream(err)
  if (e instanceof ArtifactsApiError) return e.status === 404 || e.hasCode(ARTIFACTS_ERROR_CODES.NOT_FOUND)
  const code = codeOf(e)
  if (code === "NOT_FOUND" || code === ARTIFACTS_ERROR_CODES.NOT_FOUND) return true
  const msg = e instanceof Error ? e.message : String(e)
  return /\bNOT_FOUND\b|\b10200\b/.test(msg)
}

/**
 * "Rate limited": HTTP 429 (REST status, `code`, or `429` as a word in the
 * message) or the phrases "too many requests" / "rate limit". A bare
 * substring `rate` is not a rule: it occurs in "generate", "separate",
 * "accurate", repository names, …
 */
export const isRateLimitedError = (err: unknown): boolean => {
  const e = unwrapUpstream(err)
  if (e instanceof ArtifactsApiError) return e.status === 429
  if (codeOf(e) === 429) return true
  const msg = e instanceof Error ? e.message : String(e)
  return /\b429\b|too many requests|\brate[- ]?limit/i.test(msg)
}

/** Map an error to an HTTP response; rethrows nothing. */
export const errorResponse = (err: unknown): Response => {
  const e = unwrapUpstream(err)
  if (e instanceof SessionConflict) return json({ error: e.message }, 409, { "retry-after": "1" })
  if (e instanceof AlreadyReviewed) return json({ error: `already ${e.review.decision} by ${e.review.principal}`, review: e.review }, 409)
  if (typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "NoteWriteFailed") {
    const n = e as NoteWriteFailed
    return json({ error: `could not write the note (${n.stage}): ${n.detail}` }, 502)
  }
  if (e instanceof SessionError || e instanceof InvalidModel || e instanceof InvalidArtifactsName || e instanceof RangeError) {
    return json({ error: e.message }, 400)
  }
  if (e instanceof CommitRangeError) return json({ error: e.message }, 422)
  const msg = e instanceof Error ? e.message : String(e)
  if (isNotFoundError(e)) return json({ error: msg }, 404)
  // R2 allows one write per key per second; surface it as retryable.
  if (isRateLimitedError(e)) return json({ error: msg }, 503, { "retry-after": "1" })
  return json({ error: `upstream error: ${msg}` }, 502)
}

const readJson = (request: Request): Effect.Effect<Record<string, unknown>, SessionError> =>
  Effect.flatMap(
    Effect.tryPromise({ try: () => request.json() as Promise<unknown>, catch: () => new SessionError("request body must be JSON") }),
    (body) => (isRecord(body) ? Effect.succeed(body) : Effect.fail(new SessionError("request body must be a JSON object")))
  )

const invalid = (message: string): Effect.Effect<never, SessionError> => Effect.fail(new SessionError(message))

/**
 * The routes as one effect. Expected failures (`SessionError`,
 * `CommitRangeError`, `UpstreamError`, ...) stay in the error channel and are
 * mapped to responses by {@link errorResponse} in {@link handleBisect}.
 *
 * @param request - The (authenticated) request.
 * @param parts - Non-empty path segments; `parts[0..1]` is `api/bisect`.
 * @param deps - Bindings and clock.
 * @returns The response.
 */
const route = (request: Request, parts: ReadonlyArray<string>, deps: BisectDeps): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    if (parts.length === 2) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
      const b = yield* readJson(request)
      const { repo, good, bad } = b
      if (typeof repo !== "string" || typeof good !== "string" || typeof bad !== "string") {
        return yield* invalid("repo, good and bad must be strings")
      }
      const priors = b["priors"]
      if (
        priors !== undefined &&
        !(
          isRecord(priors) &&
          Object.keys(priors).length <= MAX_PRIORS &&
          Object.values(priors).every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0)
        )
      ) {
        return yield* invalid(`priors must map at most ${MAX_PRIORS} commit ids to finite non-negative numbers`)
      }
      const newRate = yield* validate<Rate | undefined, SessionError>(() => parseRate(b["newRate"], "newRate"))
      const oldRate = yield* validate<Rate | undefined, SessionError>(() => parseRate(b["oldRate"], "oldRate"))
      const session = yield* withRepo(deps.artifacts, repo, (handle) =>
        startSession(handle, {
          repo,
          goodRef: good,
          badRef: bad,
          now: deps.now(),
          ...(newRate ? { newRate } : {}),
          ...(oldRate ? { oldRate } : {}),
          ...(typeof b["confidence"] === "number" ? { confidence: b["confidence"] } : {}),
          ...(typeof b["maxSteps"] === "number" ? { maxSteps: b["maxSteps"] } : {}),
          ...(priors !== undefined
            ? { priorWeight: (c) => ((priors as Record<string, number>)[c.oid] ?? 1) }
            : {})
        })
      )
      const id = (deps.newId ?? randomId)()
      if (!(yield* deps.store.create(id, session))) return json({ error: "session id collision; retry" }, 409)
      return json(statusBody(id, session), 201)
    }

    const id = parseSessionId(parts[2]!)
    if (id === null) return json({ error: "invalid session id" }, 400)
    const action = parts[3]
    if (parts.length > 4) return json({ error: "not found" }, 404)

    if (action === undefined) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
      const cur = yield* deps.store.load(id)
      return cur === null ? json({ error: "no such session" }, 404) : json(statusBody(id, cur.session))
    }

    if (action === "result" && request.method === "GET") {
      if (deps.results === undefined) return json({ error: "result store not configured" }, 501)
      const r = yield* deps.results.load(id)
      return r === null ? json({ error: "no result for this session yet" }, 404) : json({ id, result: r.result })
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405)

    if (action === "results") {
      const b = yield* readJson(request)
      const { commit, result, step } = b
      if (typeof commit !== "string") return yield* invalid("commit must be a string")
      if (result !== "fail" && result !== "pass" && result !== "skip") return yield* invalid('result must be "fail", "pass" or "skip"')
      if (step !== undefined && !(typeof step === "string" && STEP_KEY_RE.test(step))) {
        return yield* invalid("step must be 1-128 characters of [A-Za-z0-9._:-]")
      }
      const at = deps.now()
      // With a step key the write is idempotent: a retried request after a lost response records nothing new.
      const s = yield* modifySession(deps.store, id, (s) =>
        step !== undefined
          ? recordStep(s, step, commit, result, at)
          : result === "skip"
            ? recordSkip(s, commit, at)
            : recordResult(s, commit, result === "fail", at)
      )
      return s === null ? json({ error: "no such session" }, 404) : json(statusBody(id, s))
    }

    if (action === "undo") {
      const s = yield* modifySession(deps.store, id, undoLast)
      return s === null ? json({ error: "no such session" }, 404) : json(statusBody(id, s))
    }

    if (action === "credentials") {
      const cur = yield* deps.store.load(id)
      if (cur === null) return json({ error: "no such session" }, 404)
      const st = sessionStatus(cur.session)
      const creds = yield* withRepo(deps.artifacts, cur.session.repo, (h) => checkoutCredentials(h, "read", deps.tokenTtl ?? Duration.hours(1)))
      return json({
        remote: creds.remote,
        token: creds.token.plaintext,
        expiresAt: creds.token.expiresAt,
        commit: st.next?.oid ?? null
      })
    }

    if (action === "drive") {
      const drive = deps.drive
      if (drive === undefined) return json({ error: "workflow driver not configured" }, 501)
      const b = yield* readJson(request)
      const fb = b["fallbackBranch"]
      if (fb !== undefined && !(typeof fb === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(fb) && !fb.startsWith("-"))) return yield* invalid("fallbackBranch must be a branch name")
      const cur = yield* deps.store.load(id)
      if (cur === null) return json({ error: "no such session" }, 404)
      const instanceId = yield* drive({ sessionId: id, ...(typeof fb === "string" ? { fallbackBranch: fb } : {}) })
      return json({ id, instanceId }, 202)
    }

    if (action === "result" || action === "approve" || action === "reject") {
      const results = deps.results
      if (results === undefined) return json({ error: "result store not configured" }, 501)
      if (action === "result") return json({ error: "method not allowed" }, 405)
      const b = yield* readJson(request)
      const principal = b["principal"]
      const comment = b["comment"] ?? ""
      if (typeof principal !== "string" || principal.length === 0 || principal.length > MAX_PRINCIPAL) {
        return yield* invalid(`principal must be a non-empty string of at most ${MAX_PRINCIPAL} characters`)
      }
      if (typeof comment !== "string" || comment.length > MAX_COMMENT) return yield* invalid(`comment must be a string of at most ${MAX_COMMENT} characters`)
      if (action === "reject" && comment.length === 0) return yield* invalid("a rejection needs a comment")
      const notes = deps.notes
      if (action === "approve" && notes === undefined) return json({ error: "note writer not configured" }, 501)
      const reviewed = yield* results.review(id, (r) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          if (action === "reject") return { decision: "rejected", principal, at, note: null, comment } satisfies Review
          const text = formatNote({ result: r, principal, at, comment })
          const creds = yield* withRepo(deps.artifacts, r.repo, (h) => checkoutCredentials(h, "write", APPROVE_TOKEN_TTL))
          const cur = yield* deps.store.load(id)
          const written = yield* notes!({
            remote: creds.remote,
            token: creds.token.plaintext,
            commit: r.culprit.oid,
            branch: r.badRef,
            depth: (cur?.session.candidates.length ?? 0) + 1,
            sessionId: r.sessionId,
            text
          })
          return { decision: "approved", principal, at, note: { ref: written.ref, commit: written.commit, text }, comment } satisfies Review
        })
      )
      return reviewed === null ? json({ error: "no result for this session yet" }, 404) : json({ id, result: reviewed })
    }

    return json({ error: "not found" }, 404)
  })

/**
 * Handle a `/api/bisect…` request (already authenticated). Returns `null`
 * for paths outside `/api/bisect`. Runs {@link route} at the edge with
 * `runPromiseOrThrow`; every failure, typed or defect, becomes a response
 * via {@link errorResponse}.
 *
 * @param request - The request.
 * @param deps - Bindings and clock.
 * @returns The response, or `null` when the path is not a bisect route.
 */
export const handleBisect = async (request: Request, deps: BisectDeps): Promise<Response | null> => {
  const url = new URL(request.url)
  const parts = url.pathname.split("/").filter((p) => p.length > 0)
  if (parts[0] !== "api" || parts[1] !== "bisect") return null
  try {
    return await runPromiseOrThrow(route(request, parts, deps))
  } catch (e) {
    return errorResponse(e)
  }
}
