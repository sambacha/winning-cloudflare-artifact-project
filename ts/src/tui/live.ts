/**
 * Live mode of the dashboard: a client for the Worker's read routes, the
 * review/drive actions, and the pure functions that turn successive polls
 * into a {@link DashboardInput} (rows, event stream, cost inputs).
 *
 * Every response is decoded with a Schema at this boundary; a malformed or
 * failed response becomes an error event and an empty panel, never a crash.
 * The dashboard computes no posterior: the bisect panel shows the status
 * route's body as decoded.
 *
 * Routes used (see `../worker/handler.ts`, `../worker/bisectRoutes.ts`):
 * - `GET /api/artifacts?repo=<name>` (one per configured repository)
 * - `GET /api/locks?context=<ctx>`
 * - `GET /api/node-modules`
 * - `GET /api/bisect/<id>` and `GET /api/bisect/<id>/result`
 * - `POST /api/bisect/<id>/drive | approve | reject` (write token)
 */
import { Result, Schema } from "../fx/index.js"
import type { StatusBody } from "../worker/bisectRoutes.js"
import type { NodeModulesView } from "../worker/nodeModulesView.js"
import { BisectResultManifest } from "../worker/resultStore.js"
import { EVENT_CAP, MS_PER_SECOND, SECONDS_PER_MINUTE } from "./constants.js"
import type { CostInputs } from "./derive.js"
import type { DashboardInput, DashEvent, LeaseRow, RepoRow } from "./model.js"

// ---------------------------------------------------------------------------
// Response schemas

const CommitInfoS = Schema.Struct({
  oid: Schema.String,
  message: Schema.optionalKey(Schema.String),
  parents: Schema.optionalKey(Schema.Array(Schema.String)),
  timestamp: Schema.optionalKey(Schema.String)
})

/** `GET /api/bisect/<id>`. */
export const StatusBodyS = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  good: CommitInfoS,
  badRef: Schema.String,
  candidates: Schema.Number,
  status: Schema.Struct({
    done: Schema.Boolean,
    stopReason: Schema.NullOr(Schema.Literals(["confidence", "maxSteps", "noTestableCommit"])),
    next: Schema.NullOr(CommitInfoS),
    culprit: CommitInfoS,
    confidence: Schema.Number,
    entropy: Schema.Number,
    observations: Schema.Number,
    skipped: Schema.Array(Schema.String),
    candidates: Schema.Number,
    ranking: Schema.Array(Schema.Struct({ commit: CommitInfoS, probability: Schema.Number })),
    rates: Schema.Struct({ newMean: Schema.Number, oldMean: Schema.Number })
  }),
  tally: Schema.Array(
    Schema.Struct({ oid: Schema.String, message: Schema.optionalKey(Schema.String), fails: Schema.Number, passes: Schema.Number, skips: Schema.Number })
  )
})

/** `GET /api/bisect/<id>/result`. */
export const ResultBodyS = Schema.Struct({ id: Schema.String, result: BisectResultManifest })

/** `GET /api/artifacts?repo=`. */
export const ArtifactsBodyS = Schema.Struct({
  repo: Schema.String,
  remote: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  ref: Schema.String,
  commits: Schema.Array(Schema.Struct({ oid: Schema.String, message: Schema.NullOr(Schema.String), timestamp: Schema.NullOr(Schema.String) }))
})

const LockOk = Schema.Struct({
  key: Schema.String,
  cacheKey: Schema.String,
  owner: Schema.String,
  status: Schema.Literals(["building", "succeeded", "failed"]),
  heartbeatAt: Schema.Number,
  expiresAt: Schema.Number,
  leaseExpired: Schema.Boolean
})
const LockErr = Schema.Struct({ key: Schema.String, error: Schema.String })

/** `GET /api/locks?context=`. */
export const LocksBodyS = Schema.Struct({ locks: Schema.Array(Schema.Union([LockOk, LockErr])), truncated: Schema.Boolean })

const NmEntryS = Schema.Struct({
  key: Schema.String,
  lockfileSha256: Schema.String,
  abi: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  nodeVersion: Schema.String,
  tarballBytes: Schema.Number,
  coldInstallMs: Schema.Number,
  createdAt: Schema.Number,
  hits: Schema.Number,
  misses: Schema.Number,
  meanRestoreMs: Schema.NullOr(Schema.Number),
  savedMs: Schema.Number
})

/** `GET /api/node-modules`. */
export const NodeModulesBodyS = Schema.Struct({
  entries: Schema.Array(NmEntryS),
  totals: Schema.Struct({
    hits: Schema.Number,
    misses: Schema.Number,
    storedBytes: Schema.Number,
    savedMs: Schema.Number,
    meanRestoreMs: Schema.NullOr(Schema.Number),
    meanColdInstallMs: Schema.NullOr(Schema.Number)
  }),
  orphanEvents: Schema.Number,
  truncated: Schema.Boolean
})

// Compile-time checks: the decoded types are the Worker's own types.
const _status = (x: typeof StatusBodyS.Type): StatusBody => x
const _nm = (x: typeof NodeModulesBodyS.Type): NodeModulesView => x
void _status
void _nm

/** Decode `body` with `schema`: the value, or a one-line error. */
export const decodeWith =
  <A>(schema: Schema.Decoder<A>) =>
  (body: unknown): Result.Result<A, string> => {
    const r = Schema.decodeUnknownResult(schema)(body)
    return Result.isSuccess(r) ? Result.succeed(r.success) : Result.fail(r.failure.message.split("\n").join(" "))
  }

// ---------------------------------------------------------------------------
// Client

/** Where and how to poll. */
export interface LiveConfig {
  readonly url: string
  /** Read token (`Authorization: Bearer`). */
  readonly token: string
  /** Write token for drive / approve / reject; defaults to `token`. */
  readonly writeToken?: string
  readonly repos: ReadonlyArray<string>
  readonly context: string | null
  readonly session: string | null
  /** Reviewer name sent with approve / reject. */
  readonly principal: string
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/** One poll's worth of decoded data (errors as text, per source). */
export interface LiveSnapshot {
  readonly repos: ReadonlyArray<RepoRow>
  readonly leases: ReadonlyArray<LeaseRow> | null
  readonly nodeModules: NodeModulesView | null
  readonly bisect: StatusBody | null
  readonly result: BisectResultManifest | null
  readonly errors: ReadonlyArray<string>
}

type Fetched = { readonly ok: true; readonly status: number; readonly body: unknown } | { readonly ok: false; readonly error: string }

const getJson = async (cfg: LiveConfig, path: string, init?: RequestInit): Promise<Fetched> => {
  try {
    const res = await cfg.fetch(new URL(path, cfg.url).toString(), init ?? { headers: { authorization: `Bearer ${cfg.token}` } })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text.length === 0 ? null : JSON.parse(text)
    } catch {
      return { ok: false, error: `${path}: HTTP ${res.status}, body is not JSON` }
    }
    return { ok: true, status: res.status, body }
  } catch (e) {
    return { ok: false, error: `${path}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

const errorText = (path: string, f: Fetched): string => {
  if (!f.ok) return f.error
  const b = f.body
  const msg = typeof b === "object" && b !== null && "error" in b && typeof b.error === "string" ? b.error : ""
  return `${path}: HTTP ${f.status}${msg.length > 0 ? ` ${msg}` : ""}`
}

const isOk = (f: Fetched): f is Extract<Fetched, { ok: true }> => f.ok && f.status >= MIN_OK && f.status < MAX_OK
const MIN_OK = 200
const MAX_OK = 300
const NOT_FOUND = 404

/** A repository row from an artifacts response (or its error). */
export const toRepoRow = (name: string, f: Result.Result<typeof ArtifactsBodyS.Type, string>): RepoRow => {
  if (Result.isFailure(f)) return { name, status: "error", head: null, headAt: null, detail: f.failure }
  const c = f.success.commits[0]
  const at = c?.timestamp == null ? null : Date.parse(c.timestamp)
  return { name, status: "ok", head: c?.oid ?? null, headAt: at === null || Number.isNaN(at) ? null : at, detail: c === undefined ? "no commits" : (c.message ?? "") }
}

/** Lease rows from a locks response (unreadable lock objects are skipped). */
export const toLeaseRows = (body: typeof LocksBodyS.Type): ReadonlyArray<LeaseRow> =>
  body.locks.flatMap((l): ReadonlyArray<LeaseRow> =>
    "error" in l ? [] : [{ cacheKey: l.cacheKey, owner: l.owner, status: l.status, heartbeatAt: l.heartbeatAt, expiresAt: l.expiresAt, leaseExpired: l.leaseExpired }]
  )

/** Poll every configured source once. Never throws. */
export const poll = async (cfg: LiveConfig): Promise<LiveSnapshot> => {
  const errors: Array<string> = []
  const decoded = <A>(path: string, f: Fetched, schema: Schema.Decoder<A>): Result.Result<A, string> => {
    if (!isOk(f)) return Result.fail(errorText(path, f))
    return Result.mapError(decodeWith(schema)(f.body), (e) => `${path}: ${e}`)
  }
  const repos = await Promise.all(
    cfg.repos.map(async (name) => {
      const path = `/api/artifacts?repo=${encodeURIComponent(name)}`
      const r = decoded(path, await getJson(cfg, path), ArtifactsBodyS)
      if (Result.isFailure(r)) errors.push(r.failure)
      return toRepoRow(name, r)
    })
  )
  let leases: ReadonlyArray<LeaseRow> | null = null
  if (cfg.context !== null) {
    const path = `/api/locks?context=${encodeURIComponent(cfg.context)}`
    const r = decoded(path, await getJson(cfg, path), LocksBodyS)
    if (Result.isFailure(r)) errors.push(r.failure)
    else leases = toLeaseRows(r.success)
  }
  let nodeModules: NodeModulesView | null = null
  {
    const path = "/api/node-modules"
    const r = decoded(path, await getJson(cfg, path), NodeModulesBodyS)
    if (Result.isFailure(r)) errors.push(r.failure)
    else nodeModules = r.success
  }
  let bisect: StatusBody | null = null
  let result: BisectResultManifest | null = null
  if (cfg.session !== null) {
    const auth = { headers: { authorization: `Bearer ${cfg.writeToken ?? cfg.token}` } }
    const sPath = `/api/bisect/${encodeURIComponent(cfg.session)}`
    const s = decoded(sPath, await getJson(cfg, sPath, auth), StatusBodyS)
    if (Result.isFailure(s)) errors.push(s.failure)
    else bisect = s.success
    const rPath = `${sPath}/result`
    const rf = await getJson(cfg, rPath, auth)
    // 404 = no result yet (not an error).
    if (!(rf.ok && rf.status === NOT_FOUND)) {
      const r = decoded(rPath, rf, ResultBodyS)
      if (Result.isFailure(r)) errors.push(r.failure)
      else result = r.success.result
    }
  }
  return { repos, leases, nodeModules, bisect, result, errors }
}

/** Outcome of an action, for the header line and the event stream. */
export interface ActionOutcome {
  readonly ok: boolean
  readonly text: string
}

const post = async (cfg: LiveConfig, action: string, body: Record<string, unknown>): Promise<ActionOutcome> => {
  if (cfg.session === null) return { ok: false, text: `${action}: no session (--session <id>)` }
  const path = `/api/bisect/${encodeURIComponent(cfg.session)}/${action}`
  const f = await getJson(cfg, path, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.writeToken ?? cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  })
  return isOk(f) ? { ok: true, text: `${action}: done (HTTP ${f.status})` } : { ok: false, text: errorText(path, f) }
}

/** [SPACE]: start (or continue) the Workflow driver for the session. */
export const drive = (cfg: LiveConfig): Promise<ActionOutcome> => post(cfg, "drive", {})
/** [a]: approve the result (writes the context note on the culprit). */
export const approve = (cfg: LiveConfig, comment: string): Promise<ActionOutcome> => post(cfg, "approve", { principal: cfg.principal, comment })
/** [r]: reject the result (a comment is required). */
export const reject = (cfg: LiveConfig, comment: string): Promise<ActionOutcome> => post(cfg, "reject", { principal: cfg.principal, comment })

// ---------------------------------------------------------------------------
// Pure: events and dashboard input

const sha = (oid: string | null | undefined): string => (oid ?? "-").slice(0, SHORT)
const SHORT = 7

/**
 * Events implied by going from `prev` to `next` (append-only: the stream
 * only ever grows). The first poll (`prev === null`) reports what is there.
 */
export const diffEvents = (prev: LiveSnapshot | null, next: LiveSnapshot, at: number): ReadonlyArray<DashEvent> => {
  const out: Array<DashEvent> = []
  const ev = (kind: DashEvent["kind"], text: string) => out.push({ at, kind, text })
  const prevRepos = new Map((prev?.repos ?? []).map((r) => [r.name, r]))
  for (const r of next.repos) {
    const p = prevRepos.get(r.name)
    if (r.head !== null && p?.head !== r.head) ev("push", `${r.name}: head ${sha(p?.head)} -> ${sha(r.head)}`)
  }
  const prevLeases = new Map((prev?.leases ?? []).map((l) => [l.cacheKey, l]))
  for (const l of next.leases ?? []) {
    const p = prevLeases.get(l.cacheKey)
    if (p === undefined) ev("lease", `${l.owner} holds ${l.cacheKey} (${l.status})`)
    else if (p.owner !== l.owner) ev("lease", `${l.owner} took over ${l.cacheKey} from ${p.owner}`)
    else if (p.status !== l.status) ev(l.status === "failed" ? "error" : "lease", `${l.owner} finished ${l.cacheKey} (${l.status})`)
    else if (!p.leaseExpired && l.leaseExpired) ev("error", `lease on ${l.cacheKey} held by ${l.owner} expired`)
  }
  const pn = prev?.nodeModules?.totals
  const nn = next.nodeModules?.totals
  if (nn !== undefined) {
    const dh = nn.hits - (pn?.hits ?? 0)
    const dm = nn.misses - (pn?.misses ?? 0)
    if (dh > 0) ev("cache", `node_modules: ${dh} restore${dh === 1 ? "" : "s"} from R2`)
    if (dm > 0) ev("cache", `node_modules: ${dm} cold install${dm === 1 ? "" : "s"} published`)
  }
  const pb = prev?.bisect?.status
  const nb = next.bisect
  if (nb !== null) {
    const s = nb.status
    if (pb === undefined) ev("bisect", `session ${nb.id.slice(0, SHORT + 1)}: ${s.observations} runs, next ${sha(s.next?.oid)}`)
    else {
      if (s.observations > pb.observations) ev("bisect", `runs ${pb.observations} -> ${s.observations}; culprit ${sha(s.culprit.oid)}; next ${sha(s.next?.oid)}`)
      if (s.skipped.length > pb.skipped.length) ev("bisect", `skipped ${s.skipped.slice(pb.skipped.length).map((o) => sha(o)).join(", ")} (timeout)`)
      if (s.done && !pb.done) ev("bisect", `done (${s.stopReason ?? "-"}): culprit ${sha(s.culprit.oid)}`)
    }
  }
  const pr = prev?.result ?? null
  const nr = next.result
  if (nr !== null && pr === null) ev("bisect", `result recorded: ${sha(nr.culprit.oid)}`)
  if (nr?.review != null && pr?.review == null) ev("review", `${nr.review.decision} by ${nr.review.principal}${nr.review.note !== null ? `; note on ${sha(nr.review.note.commit)}` : ""}`)
  const prevErrors = new Set(prev?.errors ?? [])
  for (const e of next.errors) if (!prevErrors.has(e)) ev("error", e)
  return out
}

/** Append, keeping at most {@link EVENT_CAP} (oldest dropped). */
export const appendEvents = (events: ReadonlyArray<DashEvent>, add: ReadonlyArray<DashEvent>): ReadonlyArray<DashEvent> => {
  const all = [...events, ...add]
  return all.length <= EVENT_CAP ? all : all.slice(all.length - EVENT_CAP)
}

/**
 * Cost inputs estimated from what the routes expose (labelled "estimated"
 * in the docs): per observation one session CAS write, one event report and
 * reads of the session, manifest and tarball; per cold install a tarball and
 * a manifest write. GitHub Actions minutes: every install as a cold `npm ci`.
 */
export const estimateCost = (s: LiveSnapshot): CostInputs => {
  const t = s.nodeModules?.totals
  const runs = (s.bisect?.status.observations ?? 0) + (s.bisect?.status.skipped.length ?? 0)
  const installs = (t?.hits ?? 0) + (t?.misses ?? 0)
  const writesPerRun = 1 + 1
  const readsPerRun = 1 + 1 + 1
  const writesPerMiss = 1 + 1
  return {
    r2ClassA: runs * writesPerRun + (t?.misses ?? 0) * writesPerMiss,
    r2ClassB: runs * readsPerRun,
    r2StoredBytes: t?.storedBytes ?? 0,
    ghaMinutes: (installs * (t?.meanColdInstallMs ?? 0)) / (MS_PER_SECOND * SECONDS_PER_MINUTE)
  }
}

/** Accumulated live state. */
export interface LiveState {
  readonly last: LiveSnapshot | null
  readonly previousEntropy: number | null
  readonly events: ReadonlyArray<DashEvent>
}

export const initialLive: LiveState = { last: null, previousEntropy: null, events: [] }

/** Fold one poll into the state (pure). */
export const step = (st: LiveState, next: LiveSnapshot, at: number): LiveState => {
  const prevEntropy = st.last?.bisect?.status.entropy ?? null
  const changed = prevEntropy !== null && next.bisect !== null && next.bisect.status.entropy !== prevEntropy
  return {
    last: next,
    previousEntropy: changed ? prevEntropy : st.previousEntropy,
    events: appendEvents(st.events, diffEvents(st.last, next, at))
  }
}

/** Add an action's outcome to the stream (pure). */
export const noteAction = (st: LiveState, o: ActionOutcome, at: number): LiveState => ({
  ...st,
  events: appendEvents(st.events, [{ at, kind: o.ok ? "review" : "error", text: o.text }])
})

/** The frame input for the current state. */
export const liveInput = (st: LiveState, now: number, title: string): DashboardInput => {
  const s = st.last
  return {
    now,
    title,
    repos: s?.repos ?? [],
    nodeModules: s?.nodeModules ?? null,
    leases: s?.leases ?? [],
    bisect: s?.bisect == null ? null : { body: s.bisect, previousEntropy: st.previousEntropy, result: s.result },
    cost: s === null ? { r2ClassA: 0, r2ClassB: 0, r2StoredBytes: 0, ghaMinutes: 0 } : estimateCost(s),
    events: st.events
  }
}
