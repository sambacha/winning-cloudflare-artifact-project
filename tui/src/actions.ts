/**
 * The simulated Cloudflare actions of the scripted run, as pure functions of
 * script time (and of the review decision). They feed the permanent
 * SIMULATED ACTIONS strip and the overview.
 *
 * Requirements (stated without reference to any test):
 * - SA1. Every lock write of the timeline (`TIMELINE.writes`) is one R2 PUT
 *   on the operation's lock key, at the write's time, with the write's
 *   conditional header (If-None-Match: * or If-Match: <previous ETag>).
 * - SA2. Every Artifacts fork of the run is one FORK action (and one TOKEN
 *   action) at the time the fork appears, and one PUSH action at the time its
 *   commit appears; the review opens a PR; an approval merges it, a
 *   rejection closes it.
 * - SA3. Cache traffic: the cold build's lookup is a GET that misses; the
 *   publish uploads the blobs, then the manifest; the takeover's lookup is a
 *   GET that hits, followed by the blob downloads.
 * - SA4. `actionsAt(t, d)` is the prefix of the action list up to `t`
 *   (ordered by time); it is empty before the run is triggered.
 * - SA5. Transfers (blob upload, blob download) have a progress in [0, 1]
 *   that is monotone in `t`, 0 before they start and 1 once they are done.
 * - SA6. Every fork shown by the run has one task row whose progress is in
 *   [0, 1]; a merged fork is at 1.
 */
import { INPUTS, type Inputs } from "./data.ts"
import { type Derived, type Figures, der, input } from "./derive.ts"
import { type Decision, effectiveDecisionAt, FIGURES, type Part, SCENARIO, type Scenario, type State } from "./scenario.ts"
import { CLOUDFLARE, forkRepo, lockKey } from "./uris.ts"

export type Channel = "R2" | "ARTIFACTS"
export type ActionStatus = "ok" | "miss" | "fail" | "pending"

export interface SimAction {
  readonly t: number
  readonly channel: Channel
  /** HTTP method or Git/Artifacts verb: PUT, GET, HEAD, FORK, TOKEN, PUSH, PR, MERGE. */
  readonly verb: string
  readonly agent: string
  /** Object key or repo the action addresses (shown as a reference). */
  readonly target: string
  readonly detail: ReadonlyArray<Part>
  readonly status: ActionStatus
}

export interface Transfer {
  readonly dir: "up" | "down"
  readonly agent: string
  readonly target: string
  readonly from: number
  readonly to: number
  readonly blobs: Derived
  readonly size: Derived
}

export type TaskStatus = "FORKING" | "WAITING" | "RUNNING" | "PUSHED" | "CRASHED" | "PR OPEN" | "MERGED" | "REJECTED"

export interface Task {
  readonly agent: string
  readonly fork: string
  readonly repo: string
  readonly branch: string
  readonly progress: number
  readonly status: TaskStatus
}

/** Seconds the blob upload takes before the manifest is published. */
export const UPLOAD_S = 3

const ramp = (t: number, a: number, b: number): number => (b <= a ? (t >= b ? 1 : 0) : t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a))

export interface Actions {
  /** SA4. */
  readonly actionsAt: (t: number, decision: Decision) => ReadonlyArray<SimAction>
  readonly transfers: ReadonlyArray<Transfer>
  /** SA5. */
  readonly transferProgress: (x: Transfer, t: number) => number
  /** SA6. */
  readonly tasksAt: (st: State) => ReadonlyArray<Task>
}

export const makeActions = (inp: Inputs, fig: Figures, sc: Scenario): Actions => {
  const tl = sc.timeline
  const run = inp.run
  const crash = tl.crash
  const ref = (r: string): Part => ({ ref: r })
  const fg = (d: Derived, digits?: number): Part => (digits === undefined ? { fig: d } : { fig: d, opts: { digits } })
  const manifestOp = run.ops.find((o) => o.result === "manifest") ?? null
  const hashPrefix = inp.cache.hashPrefix
  const manifestKey = `${inp.cache.lookupKey.slice(0, inp.cache.lookupKey.indexOf(hashPrefix) + hashPrefix.length + 4)}…`
  const blobsKey = `v1/blobs/${hashPrefix}…`
  const ttl = input("run.tokenTtlS", run.tokenTtlS, "s")
  const lease = input("run.leaseS", run.leaseS, "s")
  const script: SimAction[] = []
  const push = (a: SimAction) => void script.push(a)

  // SA2: forks and tokens.
  const forkAt = (agent: string, f: (typeof run.agents)[number]["forks"][number]): number | null =>
    f.at ?? (crash !== null && crash.taker === agent ? crash.expiry : null)
  for (const a of run.agents) {
    for (const f of a.forks) {
      const at = forkAt(a.id, f)
      if (at === null) continue
      push({ t: at, channel: "ARTIFACTS", verb: "FORK", agent: a.id, target: `${forkRepo(f.fork)}.git`, detail: ["from ", ref(CLOUDFLARE.repo), ", branch ", ref(f.branch)], status: "ok" })
      push({ t: at, channel: "ARTIFACTS", verb: "TOKEN", agent: a.id, target: `fork/${f.fork}`, detail: ["write token, TTL ", fg(ttl, 0)], status: "ok" })
    }
  }
  // SA2: pushes, at the first instant at which the fork's commit exists.
  const instants = [...tl.instants].sort((x, y) => x - y)
  for (const a of run.agents) {
    for (const f of a.forks) {
      const at = instants.find((t) => sc.stateAt(t, null).forks.some((v) => v.fork === f.fork && v.commit !== null))
      if (at === undefined) continue
      push({ t: at, channel: "ARTIFACTS", verb: "PUSH", agent: a.id, target: `${forkRepo(f.fork)}.git`, detail: [ref(f.branch), " ← ", ref(`"${f.commit}"`)], status: "ok" })
    }
  }
  // SA1: the lock writes.
  for (const w of tl.writes) {
    const detail: Part[] =
      w.kind === "acquire"
        ? ["If-None-Match: * → ", ref("200"), ", etag ", ref(w.etag)]
        : w.kind === "takeover"
          ? ["If-Match: ", ref(w.ifMatch!), " (stale lease) → ", ref("200"), ", etag ", ref(w.etag)]
          : ["If-Match: ", ref(w.ifMatch!), " → ", ref("200"), ", etag ", ref(w.etag), w.kind === "publish" ? " SUCCEEDED" : " (renew)"]
    push({ t: w.t, channel: "R2", verb: "PUT", agent: w.writer, target: lockKey(w.op), detail, status: "ok" })
  }
  // SA3: cache traffic.
  const transfers: Transfer[] = []
  if (manifestOp !== null) {
    push({ t: manifestOp.acquireAt, channel: "R2", verb: "GET", agent: manifestOp.holder, target: manifestKey, detail: ["manifest → ", ref("404"), " MISS (cold build)"], status: "miss" })
    if (manifestOp.doneAt !== undefined) {
      const done = manifestOp.doneAt
      transfers.push({ dir: "up", agent: manifestOp.holder, target: blobsKey, from: Math.max(manifestOp.workStart ?? manifestOp.acquireAt, done - UPLOAD_S), to: done, blobs: fig.cache.blobCount, size: fig.cache.stored })
      push({ t: done, channel: "R2", verb: "PUT", agent: manifestOp.holder, target: blobsKey, detail: [fg(fig.cache.blobCount), " uploaded (If-None-Match: *), ", fg(fig.cache.stored)], status: "ok" })
      push({ t: done, channel: "R2", verb: "PUT", agent: manifestOp.holder, target: manifestKey, detail: ["manifest last (commit point) → ", ref("200")], status: "ok" })
    }
  }
  if (crash !== null) {
    push({ t: crash.at, channel: "R2", verb: "PUT", agent: crash.agent, target: lockKey(crash.op), detail: ["renewal NOT SENT: agent crashed"], status: "fail" })
    push({ t: crash.expiry, channel: "R2", verb: "HEAD", agent: crash.taker, target: lockKey(crash.op), detail: ["lease expired (last write + ", fg(lease, 0), ")"], status: "fail" })
    if (manifestOp !== null) {
      transfers.push({ dir: "down", agent: crash.taker, target: blobsKey, from: crash.expiry, to: crash.takeoverDone, blobs: fig.cache.blobCount, size: fig.cache.stored })
      push({ t: crash.takeoverDone, channel: "R2", verb: "GET", agent: crash.taker, target: manifestKey, detail: ["manifest → ", ref("200"), " HIT (published by ", ref(manifestOp.holder), ")"], status: "ok" })
      push({ t: crash.takeoverDone, channel: "R2", verb: "GET", agent: crash.taker, target: blobsKey, detail: [fg(fig.cache.blobCount), " downloaded, BLAKE3 verified, ", fg(fig.cache.stored)], status: "ok" })
    }
  }
  const prFork = crash?.takerFork?.fork ?? null
  const reviewer = crash?.taker ?? run.agents[run.agents.length - 1]!.id
  const prRepo = prFork === null ? CLOUDFLARE.repo : forkRepo(prFork)
  push({ t: tl.review, channel: "ARTIFACTS", verb: "PR", agent: reviewer, target: `${prRepo} → ${CLOUDFLARE.repo}`, detail: ["opened, review pending"], status: "pending" })
  const order = (a: SimAction) => ["FORK", "TOKEN", "HEAD", "GET", "PUT", "PUSH", "PR", "MERGE"].indexOf(a.verb)
  script.sort((a, b) => a.t - b.t || order(a) - order(b))

  const outcome = (d: Decision): SimAction[] => {
    if (d === null) return []
    return d.kind === "approve"
      ? [{ t: d.at, channel: "ARTIFACTS", verb: "MERGE", agent: reviewer, target: `${CLOUDFLARE.repo}.git`, detail: ["fast-forward from ", ref(prRepo)], status: "ok" }]
      : [{ t: d.at, channel: "ARTIFACTS", verb: "PR", agent: reviewer, target: `${prRepo} → ${CLOUDFLARE.repo}`, detail: ["closed: rejected, fork kept"], status: "fail" }]
  }

  const actionsAt = (t: number, decision: Decision): ReadonlyArray<SimAction> =>
    t < 0 ? [] : [...script.filter((a) => a.t <= t), ...outcome(effectiveDecisionAt(tl.review, t, decision))]

  const transferProgress = (x: Transfer, t: number): number => ramp(t, x.from, x.to)

  const tasksAt = (st: State): ReadonlyArray<Task> =>
    st.forks.map((f): Task => {
      const agent = st.agents.find((a) => a.id === f.agent)
      const base = { agent: f.agent, fork: f.fork, repo: forkRepo(f.fork), branch: f.branch }
      if (f.merged) return { ...base, progress: 1, status: "MERGED" }
      if (agent === undefined || agent.fork !== f.fork) return { ...base, progress: f.commit === null ? 0 : 1, status: f.commit === null ? "WAITING" : "PUSHED" }
      const held = st.locks.filter((l) => l.holder === agent.id && (l.state === "BUILDING" || l.state === "EXPIRED"))
      const working = held.length === 0 ? null : held[held.length - 1]!.progress
      switch (agent.status) {
        case "SPAWNING":
        case "IDLE":
          return { ...base, progress: 0, status: "FORKING" }
        case "WAITING":
          return { ...base, progress: working ?? 0, status: "WAITING" }
        case "BUILDING":
          return { ...base, progress: working ?? (f.commit === null ? 0 : 1), status: "RUNNING" }
        case "CRASHED":
          return { ...base, progress: working ?? (f.commit === null ? 0 : 1), status: "CRASHED" }
        case "REVIEW":
          return { ...base, progress: 1, status: "PR OPEN" }
        case "MERGED":
          return { ...base, progress: 1, status: "MERGED" }
        case "REJECTED":
          return { ...base, progress: 1, status: "REJECTED" }
        case "DONE":
          return { ...base, progress: 1, status: "PUSHED" }
      }
    })

  return { actionsAt, transfers, transferProgress, tasksAt }
}

/** The demo's simulated actions. */
export const ACTIONS: Actions = makeActions(INPUTS, FIGURES, SCENARIO)

/** A progress fraction as a percentage figure (for `Num`). */
export const progressPct = (fraction: number): Derived => der(Math.round(Math.max(0, Math.min(1, fraction)) * 100), "%", "progress × 100", ["script time t"])
