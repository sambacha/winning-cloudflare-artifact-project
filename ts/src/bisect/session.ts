/**
 * A resumable Bayesian bisection session, in the style of `git bayesect`
 * (`start --old/--new`, `fail`, `pass`, `skip`, `undo`, `status`).
 *
 * The session is a plain JSON value, so it can be stored anywhere (an R2
 * object, a file) and advanced by several runners. Every operation except
 * `startSession` is a pure function of the session.
 *
 * Model indexing. The good commit is model index `0` with prior weight `0`,
 * and the candidates (first-parent commits after it, oldest first) are
 * indices `1 … n`. A zero prior means "the good commit is not the culprit"
 * (`B = 0` keeps posterior `0`), while results recorded *at* the good commit
 * still count: under every hypothesis they lie on the old side, so with an
 * unknown old-side rate they calibrate how flaky the test is before the
 * culprit. This is how `git bayesect` lets you record runs at the old commit.
 *
 * Default rates. Unless given, the old-side failure rate has a `Beta(1, 3)`
 * prior (mean 0.25) and the new-side rate a `Beta(3, 1)` prior (mean 0.75).
 * They encode only the meaning of the two labels ("good" mostly passes,
 * "bad" mostly fails); no observation is invented for the endpoints.
 */
import { type BisectStep, nextAction, type StopReason, summarize } from "./engine.js"
import type { BisectModel, Observation, Rate } from "./model.js"
import { validateModel } from "./model.js"
import { type CommitInfo, UpstreamError, validate } from "./artifactsApi.js"
import { type CommitLog, commitRange, type HistoryError, resolveRef } from "./artifacts.js"
import { Data, Effect } from "../fx/index.js"
import type { SessionId } from "../ids.js"

export const DEFAULT_OLD_RATE: Rate = { kind: "beta", alpha: 1, beta: 3 }
export const DEFAULT_NEW_RATE: Rate = { kind: "beta", alpha: 3, beta: 1 }
export const DEFAULT_CONFIDENCE = 0.95
export const DEFAULT_MAX_STEPS = 200

/**
 * A recorded result. `step` is an optional idempotency key chosen by the
 * driver (for example `<workflow instance>:<step number>`): an event with a
 * step key that is already present is never recorded twice (see
 * {@link recordStep}), so a driver that crashed after storing a result but
 * before learning that it was stored can safely repeat the write.
 */
export type SessionEvent =
  | { readonly kind: "observe"; readonly oid: string; readonly failed: boolean; readonly at: number; readonly step?: string }
  | { readonly kind: "skip"; readonly oid: string; readonly at: number; readonly step?: string }

export interface BisectSession {
  readonly version: 1
  readonly repo: string
  readonly goodRef: string
  readonly badRef: string
  readonly good: CommitInfo
  /** First-parent commits after `good`, oldest first; the last one is the bad commit. */
  readonly candidates: ReadonlyArray<CommitInfo>
  readonly newRate: Rate
  readonly oldRate: Rate
  /** Prior weights over `candidates` (same length), or `null` for uniform. */
  readonly prior: ReadonlyArray<number> | null
  readonly confidence: number
  readonly maxSteps: number
  readonly events: ReadonlyArray<SessionEvent>
  readonly createdAt: number
}

export interface StartParams {
  readonly repo: string
  readonly goodRef: string
  readonly badRef: string
  readonly newRate?: Rate
  readonly oldRate?: Rate
  readonly priorWeight?: (commit: CommitInfo) => number
  readonly confidence?: number
  readonly maxSteps?: number
  readonly now: number
  readonly maxCommits?: number
}

/** A session value or a session operation is invalid. */
export class SessionError extends Data.TaggedError("SessionError")<{ readonly message: string }> {
  override readonly name = "SessionError"
  /** @param message - What is wrong. */
  constructor(message: string) {
    super({ message })
  }
}

const checkSettings = (confidence: number, maxSteps: number): void => {
  if (!(confidence > 0 && confidence <= 1)) throw new SessionError(`confidence must be in (0, 1], got ${confidence}`)
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new SessionError(`maxSteps must be a non-negative integer, got ${maxSteps}`)
}

/** Build a session from an explicit commit list (no I/O). */
export const makeSession = (args: {
  readonly repo: string
  readonly goodRef: string
  readonly badRef: string
  readonly good: CommitInfo
  readonly candidates: ReadonlyArray<CommitInfo>
  readonly newRate?: Rate
  readonly oldRate?: Rate
  readonly prior?: ReadonlyArray<number> | null
  readonly confidence?: number
  readonly maxSteps?: number
  readonly now: number
}): BisectSession => {
  const s: BisectSession = {
    version: 1,
    repo: args.repo,
    goodRef: args.goodRef,
    badRef: args.badRef,
    good: args.good,
    candidates: args.candidates,
    newRate: args.newRate ?? DEFAULT_NEW_RATE,
    oldRate: args.oldRate ?? DEFAULT_OLD_RATE,
    prior: args.prior ?? null,
    confidence: args.confidence ?? DEFAULT_CONFIDENCE,
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    events: [],
    createdAt: args.now
  }
  validateSession(s)
  return s
}

/**
 * Resolve the range through the repository handle and start a session.
 *
 * @param repo - History source.
 * @param p - Refs, model settings and the creation time.
 * @returns The new session (not yet stored).
 */
export const startSession = (repo: CommitLog, p: StartParams): Effect.Effect<BisectSession, HistoryError | SessionError> =>
  Effect.gen(function* () {
  const good = yield* resolveRef(repo, p.goodRef)
  const candidates = yield* commitRange(repo, p.goodRef, p.badRef, p.maxCommits)
  return yield* validate<BisectSession, SessionError>(() => makeSession({
    repo: p.repo,
    goodRef: p.goodRef,
    badRef: p.badRef,
    good,
    candidates,
    ...(p.newRate ? { newRate: p.newRate } : {}),
    ...(p.oldRate ? { oldRate: p.oldRate } : {}),
    prior: p.priorWeight ? candidates.map(p.priorWeight) : null,
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
    now: p.now
  }))
  })

/** The model behind a session: good commit at index 0 with prior 0. */
export const sessionModel = (s: BisectSession): BisectModel => ({
  n: s.candidates.length + 1,
  newRate: s.newRate,
  oldRate: s.oldRate,
  prior: [0, ...(s.prior ?? s.candidates.map(() => 1))]
})

/** Map from commit id to model index. */
const indexOf = (s: BisectSession): Map<string, number> => {
  const m = new Map<string, number>([[s.good.oid, 0]])
  s.candidates.forEach((c, i) => m.set(c.oid, i + 1))
  return m
}

const commitAt = (s: BisectSession, index: number): CommitInfo => (index === 0 ? s.good : s.candidates[index - 1]!)

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

const isCommit = (x: unknown): x is CommitInfo => isRecord(x) && typeof x["oid"] === "string" && x["oid"].length > 0

const isRate = (x: unknown): x is Rate =>
  isRecord(x) &&
  ((x["kind"] === "known" && typeof x["p"] === "number") ||
    (x["kind"] === "beta" && typeof x["alpha"] === "number" && typeof x["beta"] === "number"))

const isEvent = (x: unknown): x is SessionEvent =>
  isRecord(x) &&
  typeof x["oid"] === "string" &&
  typeof x["at"] === "number" &&
  (x["step"] === undefined || (typeof x["step"] === "string" && x["step"].length > 0)) &&
  (x["kind"] === "skip" || (x["kind"] === "observe" && typeof x["failed"] === "boolean"))

/** Decode a session from untrusted JSON (storage, a request). Throws `SessionError`. */
export const parseSession = (raw: unknown): BisectSession => {
  const ok =
    isRecord(raw) &&
    raw["version"] === 1 &&
    typeof raw["repo"] === "string" &&
    typeof raw["goodRef"] === "string" &&
    typeof raw["badRef"] === "string" &&
    isCommit(raw["good"]) &&
    Array.isArray(raw["candidates"]) &&
    raw["candidates"].every(isCommit) &&
    isRate(raw["newRate"]) &&
    isRate(raw["oldRate"]) &&
    (raw["prior"] === null || (Array.isArray(raw["prior"]) && raw["prior"].every((w) => typeof w === "number"))) &&
    typeof raw["confidence"] === "number" &&
    typeof raw["maxSteps"] === "number" &&
    Array.isArray(raw["events"]) &&
    raw["events"].every(isEvent) &&
    typeof raw["createdAt"] === "number"
  if (!ok) throw new SessionError("value is not a bisect session")
  const s = raw as unknown as BisectSession
  validateSession(s)
  return s
}

/** Structural checks for a session loaded from storage. Throws `SessionError`. */
export const validateSession = (s: BisectSession): void => {
  if (s.version !== 1) throw new SessionError(`unsupported session version ${String(s.version)}`)
  if (s.candidates.length < 1) throw new SessionError("a session needs at least one candidate commit")
  checkSettings(s.confidence, s.maxSteps)
  if (s.prior !== null && s.prior.length !== s.candidates.length) {
    throw new SessionError(`prior has length ${s.prior.length}, expected ${s.candidates.length}`)
  }
  const idx = indexOf(s)
  if (idx.size !== s.candidates.length + 1) throw new SessionError("commit ids in a session must be distinct")
  try {
    validateModel(sessionModel(s))
  } catch (e) {
    throw new SessionError((e as Error).message)
  }
  for (const e of s.events) if (!idx.has(e.oid)) throw new SessionError(`event refers to unknown commit ${e.oid}`)
}

/**
 * Resolve a user-supplied commit reference (full id or a unique prefix of at
 * least 4 characters) to a commit of the session.
 */
export const resolveSessionCommit = (s: BisectSession, ref: string): CommitInfo => {
  const all = [s.good, ...s.candidates]
  const exact = all.find((c) => c.oid === ref)
  if (exact) return exact
  if (ref.length < 4) throw new SessionError(`commit reference ${JSON.stringify(ref)} is too short (need ≥ 4 characters)`)
  const matches = all.filter((c) => c.oid.startsWith(ref))
  if (matches.length === 0) throw new SessionError(`commit ${JSON.stringify(ref)} is not in this bisection range`)
  if (matches.length > 1) throw new SessionError(`commit prefix ${JSON.stringify(ref)} is ambiguous (${matches.length} matches)`)
  return matches[0]!
}

/** Record a test result at a commit (`failed = true`: the bug showed). */
export const recordResult = (s: BisectSession, ref: string, failed: boolean, at: number): BisectSession => {
  const c = resolveSessionCommit(s, ref)
  return { ...s, events: [...s.events, { kind: "observe", oid: c.oid, failed, at }] }
}

/** Mark a commit as untestable; it is never proposed again (`git bisect skip`). */
export const recordSkip = (s: BisectSession, ref: string, at: number): BisectSession => {
  const c = resolveSessionCommit(s, ref)
  return { ...s, events: [...s.events, { kind: "skip", oid: c.oid, at }] }
}

/** The outcome of one predicate run, as a driver reports it. */
export type StepOutcome = "fail" | "pass" | "skip"

/** Has a result with idempotency key `step` been recorded? */
export const hasStep = (s: BisectSession, step: string): boolean => s.events.some((e) => e.step === step)

/**
 * Record the outcome of driver step `step` at commit `ref`, at most once:
 * if an event with this key exists the session is returned unchanged
 * (same object). `fail` means the bug showed; `skip` marks the commit
 * untestable (a timeout is a skip, not a failure).
 */
export const recordStep = (s: BisectSession, step: string, ref: string, outcome: StepOutcome, at: number): BisectSession => {
  if (step.length === 0) throw new SessionError("a step key must be non-empty")
  if (hasStep(s, step)) return s
  const c = resolveSessionCommit(s, ref)
  const event: SessionEvent = outcome === "skip" ? { kind: "skip", oid: c.oid, at, step } : { kind: "observe", oid: c.oid, failed: outcome === "fail", at, step }
  return { ...s, events: [...s.events, event] }
}

/** Per-commit observation counts (display data, not a posterior). */
export interface CommitTally {
  readonly oid: string
  readonly message?: string
  readonly fails: number
  readonly passes: number
  readonly skips: number
}

/** Counts of fail / pass / skip per tested commit, oldest commit first. */
export const sessionTally = (s: BisectSession): ReadonlyArray<CommitTally> => {
  const order = [s.good, ...s.candidates]
  const m = new Map<string, { fails: number; passes: number; skips: number }>()
  for (const e of s.events) {
    const t = m.get(e.oid) ?? { fails: 0, passes: 0, skips: 0 }
    if (e.kind === "skip") t.skips++
    else if (e.failed) t.fails++
    else t.passes++
    m.set(e.oid, t)
  }
  return order.flatMap((c) => {
    const t = m.get(c.oid)
    return t === undefined ? [] : [{ oid: c.oid, ...(c.message !== undefined ? { message: c.message } : {}), ...t }]
  })
}

/** Remove the most recent event. Throws if there is none. */
export const undoLast = (s: BisectSession): BisectSession => {
  if (s.events.length === 0) throw new SessionError("nothing to undo")
  return { ...s, events: s.events.slice(0, -1) }
}

export interface RankedCommit {
  readonly commit: CommitInfo
  readonly probability: number
}

export interface SessionStatus {
  readonly done: boolean
  readonly stopReason: StopReason | null
  /** The commit to test next (`null` when done). */
  readonly next: CommitInfo | null
  /** Most likely culprit so far, and its posterior probability. */
  readonly culprit: CommitInfo
  readonly confidence: number
  readonly entropy: number
  readonly observations: number
  readonly skipped: ReadonlyArray<string>
  readonly candidates: number
  /** The `top` most likely culprits, most likely first. */
  readonly ranking: ReadonlyArray<RankedCommit>
  /** Posterior mean failure rate on each side. */
  readonly rates: { readonly newMean: number; readonly oldMean: number }
}

/** Observations and skipped indices of a session, in model indexing. */
export const sessionObservations = (s: BisectSession): { obs: Observation[]; skipped: Set<number> } => {
  const idx = indexOf(s)
  const obs: Observation[] = []
  const skipped = new Set<number>()
  for (const e of s.events) {
    const i = idx.get(e.oid)
    if (i === undefined) throw new SessionError(`event refers to unknown commit ${e.oid}`)
    if (e.kind === "observe") obs.push({ index: i, failed: e.failed })
    else skipped.add(i)
  }
  return { obs, skipped }
}

export const sessionStatus = (s: BisectSession, top = 5): SessionStatus => {
  const m = sessionModel(s)
  const { obs, skipped } = sessionObservations(s)
  const steps: BisectStep[] = obs.map((o) => ({ ...o, map: 0, confidence: 0, entropy: 0 }))
  // Testing the good commit (index 0) can only inform the old-side rate; with
  // a known old-side rate it is useless, so it is never proposed then.
  const exclude = s.oldRate.kind === "known" ? new Set([...skipped, 0]) : skipped
  const action = nextAction(m, steps, { confidence: s.confidence, maxSteps: s.maxSteps }, exclude)
  const sum = summarize(m, obs)
  const order = Array.from(sum.posterior.keys())
    .filter((i) => i > 0)
    .sort((a, b) => sum.posterior[b]! - sum.posterior[a]! || a - b)
  return {
    done: action.done,
    stopReason: action.done ? action.result.stopReason : null,
    next: action.done ? null : commitAt(s, action.index),
    culprit: commitAt(s, sum.map),
    confidence: sum.confidence,
    entropy: sum.entropy,
    observations: obs.length,
    skipped: [...skipped].sort((a, b) => a - b).map((i) => commitAt(s, i).oid),
    candidates: s.candidates.length,
    ranking: order.slice(0, Math.max(0, top)).map((i) => ({ commit: commitAt(s, i), probability: sum.posterior[i]! })),
    rates: { newMean: sum.newRate.mean, oldMean: sum.oldRate.mean }
  }
}

// ---------------------------------------------------------------------------
// Persistence

export interface StoredSession {
  readonly session: BisectSession
  /** Opaque version for compare-and-swap (an R2 ETag, a counter). */
  readonly version: string
}

/** Failures of a {@link SessionStore}: the backing store failed, or held an invalid session. */
export type SessionStoreError = UpstreamError | SessionError

/**
 * Where sessions live. `create` and `update` are conditional so that two
 * runners recording results at the same time cannot overwrite each other:
 * a stale `update` succeeds with `false` and the caller reloads and retries.
 */
export interface SessionStore {
  readonly load: (id: SessionId) => Effect.Effect<StoredSession | null, SessionStoreError>
  /** Create only if absent; `false` if the id exists. */
  readonly create: (id: SessionId, session: BisectSession) => Effect.Effect<boolean, SessionStoreError>
  /** Replace only if the stored version is still `version`; `false` otherwise. */
  readonly update: (id: SessionId, session: BisectSession, version: string) => Effect.Effect<boolean, SessionStoreError>
}

/**
 * An in-memory {@link SessionStore} (tests, the local CLI). Values are kept
 * as JSON so that loads return fresh copies, as a real store would.
 *
 * @returns The store and a `size` probe.
 */
export const makeMemorySessionStore = (): SessionStore & { readonly size: () => number } => {
  const m = new Map<string, { json: string; version: number }>()
  return {
    size: () => m.size,
    load: (id) =>
      Effect.suspend(() => {
        const e = m.get(id)
        if (e === undefined) return Effect.succeed(null)
        return Effect.map(
          validate<BisectSession, SessionError>(() => parseSession(JSON.parse(e.json))),
          (session) => ({ session, version: String(e.version) })
        )
      }),
    create: (id, session) =>
      Effect.sync(() => {
        if (m.has(id)) return false
        m.set(id, { json: JSON.stringify(session), version: 1 })
        return true
      }),
    update: (id, session, version) =>
      Effect.sync(() => {
        const e = m.get(id)
        if (e === undefined || String(e.version) !== version) return false
        m.set(id, { json: JSON.stringify(session), version: e.version + 1 })
        return true
      })
  }
}

/** A compare-and-swap update lost the race `attempts` times in a row. */
export class SessionConflict extends Data.TaggedError("SessionConflict")<{ readonly message: string }> {
  override readonly name = "SessionConflict"
  /** @param message - Which session, and how many attempts. */
  constructor(message: string) {
    super({ message })
  }
}

/**
 * Load, apply `f`, and store with compare-and-swap, retrying on conflicts up
 * to `attempts` times.
 *
 * @param store - The session store.
 * @param id - Session id.
 * @param f - The (pure, possibly throwing `SessionError`) update.
 * @param attempts - Maximum number of load/update rounds.
 * @returns The stored session, or `null` if there is no session `id`.
 */
export const modifySession = (
  store: SessionStore,
  id: SessionId,
  f: (s: BisectSession) => BisectSession,
  attempts = 5
): Effect.Effect<BisectSession | null, SessionStoreError | SessionConflict> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const cur = yield* store.load(id)
      if (cur === null) return null
      const next = yield* validate<BisectSession, SessionError>(() => {
        const n = f(cur.session)
        validateSession(n)
        return n
      })
      // `f` returned the session itself (an idempotent no-op such as a repeated step): nothing to write.
      if (next === cur.session) return next
      if (yield* store.update(id, next, cur.version)) return next
    }
    return yield* Effect.fail(new SessionConflict(`session ${id} changed concurrently ${attempts} times; retry later`))
  })
