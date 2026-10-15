/**
 * Live data for the dashboard beyond the lock rows (`live.ts`): the cache
 * summary, the Artifacts repository, an event stream derived from successive
 * lock polls, the Lean axiom-audit measurement, and the provenance label of
 * every panel.
 *
 * Like `live.ts`, this file has no imports (the TUI stays independent of the
 * `ts/` package). The Worker's JSON shapes are restated and checked at run
 * time; `ts/test/worker/liveFeedContract.test.ts` feeds these functions real
 * Worker responses produced by the real lock and cache code.
 *
 * Events. R2 has no change feed here (event notifications need a Queue), so
 * the dashboard derives events by comparing two consecutive `GET /api/locks`
 * snapshots (`diffLocks`). An event describes the *net* change of one lock
 * object between the polls: several writes to the same key within one poll
 * interval appear as one event. Each lock object yields at most one event per
 * poll, and an object whose ETag did not change yields none, except
 * `LEASE_EXPIRED`, which is a change of time, not of the object.
 *
 * Provenance (the honest labelling of the Option A+ plan). A panel is `LIVE`
 * only if its data came from the Worker in this session, `MEASURED` only if
 * it shows a number read from a real measurement file, and `DEMO` otherwise.
 * Nothing is labelled live on the strength of a configuration flag alone.
 */

// ---------------------------------------------------------------------------
// Shapes of the Worker responses

export interface LiveCache {
  readonly scope: string
  readonly blobCount: number
  readonly blobBytes: number
  readonly manifestCount: number
  readonly manifestBytes: number
  readonly truncated: boolean
}

export interface LiveCommit {
  readonly oid: string
  readonly message: string | null
  readonly timestamp: string | null
}

export interface LiveArtifacts {
  readonly repo: string
  readonly remote: string
  readonly defaultBranch: string | null
  readonly ref: string
  readonly commits: ReadonlyArray<LiveCommit>
}

export class LiveFeedFormatError extends Error {
  override readonly name = "LiveFeedFormatError"
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

const field = <A>(o: Record<string, unknown>, k: string, ok: (v: unknown) => v is A, what: string): A => {
  const v = o[k]
  if (!ok(v)) throw new LiveFeedFormatError(`field ${k} must be ${what}`)
  return v
}
const isString = (v: unknown): v is string => typeof v === "string"
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string"

/** Validate a `GET /api/cache` body. Counts and byte totals must be non-negative safe integers. */
export const parseLiveCache = (body: unknown): LiveCache => {
  if (!isObj(body)) throw new LiveFeedFormatError("expected a JSON object")
  return {
    scope: field(body, "scope", isString, "a string"),
    blobCount: field(body, "blobCount", isCount, "a non-negative integer"),
    blobBytes: field(body, "blobBytes", isCount, "a non-negative integer"),
    manifestCount: field(body, "manifestCount", isCount, "a non-negative integer"),
    manifestBytes: field(body, "manifestBytes", isCount, "a non-negative integer"),
    truncated: field(body, "truncated", isBool, "a boolean")
  }
}

/** Validate a `GET /api/artifacts` body. Fields beyond the documented ones are dropped. */
export const parseLiveArtifacts = (body: unknown): LiveArtifacts => {
  if (!isObj(body)) throw new LiveFeedFormatError("expected a JSON object")
  const commits = body["commits"]
  if (!Array.isArray(commits)) throw new LiveFeedFormatError("field commits must be an array")
  return {
    repo: field(body, "repo", isString, "a string"),
    remote: field(body, "remote", isString, "a string"),
    defaultBranch: field(body, "defaultBranch", isStringOrNull, "a string or null"),
    ref: field(body, "ref", isString, "a string"),
    commits: commits.map((c) => {
      if (!isObj(c)) throw new LiveFeedFormatError("commit must be an object")
      return {
        oid: field(c, "oid", isString, "a string"),
        message: field(c, "message", isStringOrNull, "a string or null"),
        timestamp: field(c, "timestamp", isStringOrNull, "a string or null")
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Events from consecutive lock snapshots

/** The lock fields `diffLocks` needs (a subset of `live.ts`'s `LiveLock`). */
export interface LockSnapshotEntry {
  readonly key: string
  readonly cacheKey: string
  readonly etag: string
  readonly owner: string
  readonly status: "building" | "succeeded" | "failed"
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly leaseExpired: boolean
}

export type LockEventKind =
  | "ACQUIRED" // a new lock object, building
  | "RENEWED" // same holder, same acquisition, new heartbeat
  | "ABANDONED" // the holder gave the lease up (expiresAt moved before its heartbeat)
  | "TAKEOVER" // an existing object re-acquired (new acquisition time), by another job or after an abandon
  | "SUCCEEDED" // a success marker was published
  | "FAILED" // a failure marker was published
  | "LEASE_EXPIRED" // nothing was written, but the lease ran out: takeover is now allowed
  | "REMOVED" // the object is gone (manual cleanup; the lock never deletes)

export interface LockEvent {
  readonly kind: LockEventKind
  readonly key: string
  readonly cacheKey: string
  /** Holder after the change (before it, for `REMOVED`). */
  readonly owner: string
  /** Holder before the change, for `TAKEOVER`. */
  readonly prevOwner: string | null
  readonly etag: string
}

const changeOf = (prev: LockSnapshotEntry | undefined, next: LockSnapshotEntry): LockEventKind | null => {
  if (prev === undefined) {
    return next.status === "building" ? "ACQUIRED" : next.status === "succeeded" ? "SUCCEEDED" : "FAILED"
  }
  if (prev.etag === next.etag) return !prev.leaseExpired && next.leaseExpired ? "LEASE_EXPIRED" : null
  switch (next.status) {
    case "succeeded":
      return "SUCCEEDED"
    case "failed":
      return "FAILED"
    case "building":
      // A new acquisition: the object was a marker, or the holder or acquisition time changed, or the
      // previous version was an abandoned lease (acquisition times can coincide at millisecond resolution).
      if (prev.status !== "building" || next.owner !== prev.owner || next.acquiredAt !== prev.acquiredAt || prev.expiresAt < prev.heartbeatAt) {
        return "TAKEOVER"
      }
      return next.expiresAt < next.heartbeatAt ? "ABANDONED" : "RENEWED"
  }
}

/**
 * Events between two snapshots of one context, in the listing order of
 * `next`, followed by removed objects in the listing order of `prev`.
 * `prev = []` (the first poll) reports every existing lock once.
 */
export const diffLocks = (prev: ReadonlyArray<LockSnapshotEntry>, next: ReadonlyArray<LockSnapshotEntry>): ReadonlyArray<LockEvent> => {
  const before = new Map(prev.map((l) => [l.key, l]))
  const after = new Set(next.map((l) => l.key))
  const changed = next.flatMap((l): ReadonlyArray<LockEvent> => {
    const p = before.get(l.key)
    const kind = changeOf(p, l)
    if (kind === null) return []
    return [{ kind, key: l.key, cacheKey: l.cacheKey, owner: l.owner, prevOwner: kind === "TAKEOVER" ? (p?.owner ?? null) : null, etag: l.etag }]
  })
  const removed = prev
    .filter((l) => !after.has(l.key))
    .map((l): LockEvent => ({ kind: "REMOVED", key: l.key, cacheKey: l.cacheKey, owner: l.owner, prevOwner: null, etag: l.etag }))
  return [...changed, ...removed]
}

/** One line of the event stream for `e`. ETags are shown without quotes. */
export const describeLockEvent = (e: LockEvent): string => {
  const etag = e.etag.replace(/^"|"$/g, "")
  switch (e.kind) {
    case "ACQUIRED":
      return `${e.owner} acquired ${e.cacheKey} (If-None-Match: *, etag ${etag})`
    case "RENEWED":
      return `${e.owner} renewed ${e.cacheKey} (If-Match, etag ${etag})`
    case "ABANDONED":
      return `${e.owner} abandoned ${e.cacheKey}: takeover allowed now`
    case "TAKEOVER":
      return `${e.owner} took over ${e.cacheKey}${e.prevOwner !== null && e.prevOwner !== e.owner ? ` from ${e.prevOwner}` : ""} (If-Match, etag ${etag})`
    case "SUCCEEDED":
      return `${e.owner} published ${e.cacheKey}: SUCCEEDED`
    case "FAILED":
      return `${e.owner} published ${e.cacheKey}: FAILED (failure marker)`
    case "LEASE_EXPIRED":
      return `lease of ${e.cacheKey} held by ${e.owner} EXPIRED (heartbeat MISSING): takeover allowed`
    case "REMOVED":
      return `${e.cacheKey} lock object removed`
  }
}

/** Dashboard event kind for a lock event (`scenario.ts` `Kind`). */
export const eventKindOf = (e: LockEvent): "LOCK" | "HB" | "LEASE" | "CACHE" => {
  switch (e.kind) {
    case "RENEWED":
      return "HB"
    case "LEASE_EXPIRED":
    case "ABANDONED":
      return "LEASE"
    case "SUCCEEDED":
      return "CACHE"
    default:
      return "LOCK"
  }
}

// ---------------------------------------------------------------------------
// Lean axiom-audit measurement

export interface LeanAudit {
  readonly theorems: number
  readonly violations: number
  readonly prefix: string
}

const AUDIT_RE = /axiom audit: (\d+) theorems in modules under (\S+), (\d+) violations/

/**
 * The measurement printed by `lake build` (`RequestProject/Cobuilds/Tests/Audit.lean`):
 * `axiom audit: <N> theorems in modules under <prefix>, <M> violations`. The
 * last such line of the log wins; `null` when there is none.
 */
export const parseLeanAudit = (log: string): LeanAudit | null => {
  let found: LeanAudit | null = null
  for (const line of log.split(/\r?\n/)) {
    const m = AUDIT_RE.exec(line)
    if (m !== null) {
      const theorems = Number(m[1])
      const violations = Number(m[3])
      if (Number.isSafeInteger(theorems) && Number.isSafeInteger(violations)) found = { theorems, violations, prefix: m[2]! }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Provenance

export type Provenance = "LIVE" | "MEASURED" | "DEMO"
export type PanelId = "locks" | "cache" | "artifacts" | "lean" | "cost" | "events"

/** What actually arrived in this session (not what was configured). */
export interface Sources {
  /** At least one `/api/locks` poll succeeded. */
  readonly locks: boolean
  /** At least one `/api/cache` poll succeeded. */
  readonly cache: boolean
  /** At least one `/api/artifacts` poll succeeded. */
  readonly artifacts: boolean
  /** A Lean audit line was read from a build log. */
  readonly leanAudit: boolean
}

/**
 * Label of each panel. Events are live when they are derived from live lock
 * polls. The cost panel is always `DEMO`: it is computed from the brief's
 * inputs, not from measured operations.
 */
export const provenance = (s: Sources): Readonly<Record<PanelId, Provenance>> => ({
  locks: s.locks ? "LIVE" : "DEMO",
  cache: s.cache ? "LIVE" : "DEMO",
  artifacts: s.artifacts ? "LIVE" : "DEMO",
  lean: s.leanAudit ? "MEASURED" : "DEMO",
  cost: "DEMO",
  events: s.locks ? "LIVE" : "DEMO"
})

/** The bracketed tag shown in a panel title. */
export const provenanceTag = (p: Provenance): string => `[${p}]`

/** Human-readable byte count (binary units), for the live cache summary. */
export const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`byte count must be finite and non-negative, got ${n}`)
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`
}

// ---------------------------------------------------------------------------
// The live feed as the dashboard state carries it

export interface FeedEvent {
  /** Dashboard clock (seconds) of the poll that observed the change. */
  readonly t: number
  readonly event: LockEvent
}

export interface LiveFeedView {
  readonly provenance: Readonly<Record<PanelId, Provenance>>
  readonly cache: LiveCache | null
  readonly artifacts: LiveArtifacts | null
  readonly leanAudit: LeanAudit | null
  readonly events: ReadonlyArray<FeedEvent>
}

/** Append the events of one poll (observed at `t`), keeping the newest `max`. */
export const appendEvents = (log: ReadonlyArray<FeedEvent>, events: ReadonlyArray<LockEvent>, t: number, max: number): ReadonlyArray<FeedEvent> => {
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError(`max must be a non-negative integer, got ${max}`)
  const all = [...log, ...events.map((event) => ({ t, event }))]
  return max === 0 ? [] : all.slice(-max)
}

/** Attach the live feed to a dashboard state. */
export const withLiveFeed = <S extends object>(state: S, feed: LiveFeedView): S & { readonly feed: LiveFeedView } => ({ ...state, feed })

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const getJson = async (workerUrl: string, path: string, token: string, fetchImpl: FetchLike): Promise<unknown> => {
  const res = await fetchImpl(`${workerUrl.replace(/\/+$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new LiveFeedFormatError(`Worker answered HTTP ${res.status} for ${path.split("?")[0]}`)
  return res.json()
}

/** Fetch and validate `GET /api/cache`. */
export const fetchLiveCache = async (workerUrl: string, token: string, fetchImpl: FetchLike = fetch): Promise<LiveCache> =>
  parseLiveCache(await getJson(workerUrl, "/api/cache", token, fetchImpl))

/** Fetch and validate `GET /api/artifacts?repo=<repo>`. */
export const fetchLiveArtifacts = async (workerUrl: string, token: string, repo: string, fetchImpl: FetchLike = fetch): Promise<LiveArtifacts> =>
  parseLiveArtifacts(await getJson(workerUrl, `/api/artifacts?repo=${encodeURIComponent(repo)}&limit=5`, token, fetchImpl))

/**
 * The feed the dashboard draws. Provenance is computed from the data that is
 * actually present, so a panel cannot be labelled LIVE or MEASURED without
 * the data that justifies the label.
 */
export const feedView = (x: {
  readonly locksSeen: boolean
  readonly cache: LiveCache | null
  readonly artifacts: LiveArtifacts | null
  readonly leanAudit: LeanAudit | null
  readonly events: ReadonlyArray<FeedEvent>
}): LiveFeedView => ({
  provenance: provenance({ locks: x.locksSeen, cache: x.cache !== null, artifacts: x.artifacts !== null, leanAudit: x.leanAudit !== null }),
  cache: x.cache,
  artifacts: x.artifacts,
  leanAudit: x.leanAudit,
  events: x.events
})
