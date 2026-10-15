/**
 * The scripted cobuild run, as a pure function of time, generated from the
 * run script in `inputs.json` (`run`).
 *
 * Requirements (stated without reference to any test):
 * - S1. Every lock change is a conditional write in a per-key write log:
 *   `acquire` (If-None-Match: *), `renew` and `publish` (If-Match on the
 *   holder's last ETag), `takeover` (If-Match on the crashed holder's last
 *   ETag, only once that lease has expired).
 * - S2. ETags are per-key versions (`<op>.v<n>`, n = 1, 2, …), so they are
 *   strictly increasing per key and a takeover's If-Match names the ETag of
 *   the last write before it.
 * - S3. A holder renews every `renewS` while it works; a write is never
 *   closer than `minWriteGapS` to the previous write on the same key (R2:
 *   one write per key per second).
 * - S4. A lease expires `leaseS` after the holder's last write. The crashed
 *   holder's lease therefore expires `leaseS` after its last write, and the
 *   expiry event says so (last write + lease, and the renewal that was missed).
 * - S5. A takeover happens on a new fork of the taker; agent and fork are
 *   named in the events and in the git view.
 * - S6. `stateAt(t, decision)` is pure: the same `t` and decision give the same state.
 */
import type { LiveFeedView } from "./liveFeed.ts"
import { type AgentInput, type ForkInput, INPUTS, type Inputs, type OpInput, type RunInput } from "./data.ts"
import { type Derived, type Figures, type FormatOpts, clockAt, der, deriveFigures, format, input } from "./derive.ts"

export type Kind = "LOCK" | "FORK" | "TOKEN" | "CACHE" | "HB" | "LEAN" | "LEASE" | "REVIEW" | "MERGE" | "REJECT" | "COST"

/** A piece of event text: plain words, a derived figure, or a reference (an id, key, ETag or branch). */
export type Part = string | { readonly fig: Derived; readonly opts?: FormatOpts } | { readonly ref: string }

export interface Event {
  readonly t: number
  readonly kind: Kind
  readonly parts: ReadonlyArray<Part>
}

/** Plain text of event parts. */
export const partsText = (parts: ReadonlyArray<Part>): string =>
  parts.map((p) => (typeof p === "string" ? p : "fig" in p ? format(p.fig, p.opts) : p.ref)).join("")

export const eventText = (e: Event): string => partsText(e.parts)

export type Decision = { readonly kind: "approve" | "reject"; readonly at: number } | null

/** `FAILED`: a failure marker (live mode only); `EXPIRED`: the holder's lease ran out and nobody took over yet. */
export type OpState = "FREE" | "BUILDING" | "SUCCEEDED" | "FAILED" | "EXPIRED"

export interface Lock {
  readonly op: string
  readonly holder: string | null
  readonly state: OpState
  readonly progress: number // 0..1
  readonly lastWrite: number | null
  readonly expiresAt: number | null
  readonly etag: string | null
  readonly via: string
  readonly prev: string | null
  readonly result: string | null
  /** The holder missed its renewal (more than `renewS` since its last write). */
  readonly renewalOverdue?: boolean
  /** Real R2 object key (live mode). The script shows an illustrative key. */
  readonly key?: string
  /** Read from R2 through the Worker (`live.ts`); progress is not reported there. */
  readonly live?: boolean
}

export type AgentStatus = "IDLE" | "SPAWNING" | "BUILDING" | "WAITING" | "CRASHED" | "REVIEW" | "MERGED" | "REJECTED" | "DONE"

export interface Agent {
  readonly id: string
  readonly fork: string | null
  readonly status: AgentStatus
  readonly detail: ReadonlyArray<Part>
  readonly tokenLeft: number | null // seconds; null = no token yet; 0 = expired/revoked
  readonly branch: string
  readonly commit: string | null
  readonly diff: { readonly added: Derived; readonly removed: Derived; readonly files: Derived } | null
  readonly set: string
  readonly audited: Derived | null
}

export interface State {
  /** Lock rows come from R2 through the Worker; every other panel stays illustrative. */
  readonly live?: boolean
  /** Live cache, Artifacts, events and the provenance label of every panel (`liveFeed.ts`). */
  readonly feed?: LiveFeedView
  readonly t: number
  readonly triggered: boolean
  readonly agents: ReadonlyArray<Agent>
  readonly locks: ReadonlyArray<Lock>
  readonly events: ReadonlyArray<Event>
  readonly theoremsAudited: Derived
  readonly auditDone: boolean
  readonly published: boolean
  readonly verifiedByTaker: boolean
  readonly costSoFar: Derived
  readonly ghaEquivalent: Derived
  readonly finished: boolean
  readonly awaitingReview: boolean
  readonly forks: ReadonlyArray<ForkView>
}

/** A fork as shown by the git view. */
export interface ForkView {
  readonly agent: string
  readonly fork: string
  readonly branch: string
  readonly commit: string | null
  readonly merged: boolean
}

export type WriteKind = "acquire" | "renew" | "publish" | "takeover"

export interface Write {
  readonly t: number
  readonly op: string
  readonly writer: string
  readonly kind: WriteKind
  readonly version: number
  readonly etag: string
  /** The ETag named in If-Match (null for If-None-Match: *). */
  readonly ifMatch: string | null
}

export interface Crash {
  readonly op: string
  readonly agent: string
  readonly at: number
  readonly lastWrite: number
  readonly renewalDue: number
  readonly expiry: number
  readonly taker: string
  readonly takeoverDone: number
  readonly takerFork: ForkInput | null
}

export interface Timeline {
  readonly writes: ReadonlyArray<Write>
  readonly crash: Crash | null
  readonly review: number
  readonly autoApproveDelay: number
  readonly autoTriggerIdle: number
  /** Instants at which something happens (for tests, goldens and narration cues). */
  readonly instants: ReadonlyArray<number>
}

const ramp = (t: number, a: number, b: number): number => (b <= a ? (t >= b ? 1 : 0) : t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a))

const shortOp = (op: string): string => op.replace(/^op:/, "")

const etagOf = (op: string, version: number): string => `${shortOp(op)}.v${version}`

/** Renewal instants of a holder that holds from `from`; strictly before `until`, and at least `gap` before `publishAt` if it publishes. */
const renewals = (run: RunInput, from: number, until: number, publishAt: number | null): number[] => {
  const out: number[] = []
  for (let k = 1; ; k++) {
    const r = from + k * run.renewS
    if (r >= until) break
    if (publishAt !== null && r > publishAt - run.minWriteGapS) break
    out.push(r)
  }
  return out
}

/**
 * The time of a holder's publish write: the scripted end of the work, or
 * later if the holder renewed less than `minWriteGapS` before it (R2 takes
 * one write per key per second, so the client waits). Renewals happen every
 * `renewS` from `from` while the work runs.
 */
const publishTime = (run: RunInput, from: number, done: number): number => {
  let last = from
  for (let k = 1; from + k * run.renewS < done; k++) last = from + k * run.renewS
  return Math.max(done, last + run.minWriteGapS)
}

/** The script with every publish moved to its write time (`publishTime`); idempotent. */
export const effectiveRun = (run: RunInput): RunInput => ({
  ...run,
  ops: run.ops.map((o) => {
    if (o.doneAt !== undefined) return { ...o, doneAt: publishTime(run, o.acquireAt, o.doneAt) }
    const crashAt = o.crashAt!
    let lastWrite = o.acquireAt
    for (let k = 1; o.acquireAt + k * run.renewS < crashAt; k++) lastWrite = o.acquireAt + k * run.renewS
    const expiry = lastWrite + run.leaseS
    return { ...o, takeoverWorkS: publishTime(run, expiry, expiry + o.takeoverWorkS!) - expiry }
  })
})

/** S1–S4: the write log of every key, and the crash/takeover times. */
export const buildTimeline = (scripted: RunInput): Timeline => {
  const run = effectiveRun(scripted)
  const writes: Write[] = []
  let crash: Crash | null = null
  for (const op of run.ops) {
    let version = 0
    const push = (t: number, writer: string, kind: WriteKind) => {
      const prev = version === 0 ? null : etagOf(op.op, version)
      version += 1
      writes.push({ t, op: op.op, writer, kind, version, etag: etagOf(op.op, version), ifMatch: kind === "acquire" ? null : prev })
    }
    push(op.acquireAt, op.holder, "acquire")
    if (op.doneAt !== undefined) {
      for (const r of renewals(run, op.acquireAt, op.doneAt, op.doneAt)) push(r, op.holder, "renew")
      push(op.doneAt, op.holder, "publish")
    } else {
      const crashAt = op.crashAt!
      const rs = renewals(run, op.acquireAt, crashAt, null)
      for (const r of rs) push(r, op.holder, "renew")
      const lastWrite = rs.length === 0 ? op.acquireAt : rs[rs.length - 1]!
      const expiry = lastWrite + run.leaseS
      const done = expiry + op.takeoverWorkS!
      push(expiry, op.takeoverBy!, "takeover")
      for (const r of renewals(run, expiry, done, done)) push(r, op.takeoverBy!, "renew")
      push(done, op.takeoverBy!, "publish")
      const taker = run.agents.find((a) => a.id === op.takeoverBy)
      crash = {
        op: op.op,
        agent: op.holder,
        at: crashAt,
        lastWrite,
        renewalDue: lastWrite + run.renewS,
        expiry,
        taker: op.takeoverBy!,
        takeoverDone: done,
        takerFork: taker?.forks.find((f) => f.on === "takeover") ?? null
      }
    }
  }
  writes.sort((a, b) => a.t - b.t || a.op.localeCompare(b.op) || a.version - b.version)
  const lastEnd = Math.max(...run.ops.map((o) => o.doneAt ?? o.crashAt ?? 0))
  const review = (crash?.takeoverDone ?? lastEnd) + run.reviewAfterTakeoverS
  const forkTimes = run.agents.flatMap((a) => a.forks.flatMap((f) => (f.at === undefined ? [] : [f.at, f.at + run.spawnS])))
  const workTimes = run.ops.flatMap((o) => [o.workStart, o.workEnd].filter((x): x is number => x !== undefined))
  const instants = [...new Set([...writes.map((w) => w.t), ...forkTimes, ...workTimes, ...(crash === null ? [] : [crash.at, crash.renewalDue]), review])].sort((a, b) => a - b)
  return { writes, crash, review, autoApproveDelay: run.autoApproveDelayS, autoTriggerIdle: run.autoTriggerIdleS, instants }
}

export interface Scenario {
  readonly timeline: Timeline
  /** The fixed part of the stream (everything except the review outcome). */
  readonly script: ReadonlyArray<Event>
  readonly stateAt: (t: number, decision: Decision) => State
  readonly clock: (t: number) => Derived
}

/** A decision only counts once the review gate is open and once it has happened. */
export const effectiveDecisionAt = (review: number, t: number, d: Decision): Decision => (d !== null && d.at >= review && d.at <= t ? d : null)

export const makeScenario = (inp: Inputs, fig: Figures = deriveFigures(inp)): Scenario => {
  const run = effectiveRun(inp.run)
  const tl = buildTimeline(run)
  const crash = tl.crash
  const clock = (t: number) => clockAt(run.startClockS, t)
  const opOf = (name: string): OpInput => run.ops.find((o) => o.op === name)!
  const agentOf = (id: string): AgentInput => run.agents.find((a) => a.id === id)!
  const auditOp = run.ops.find((o) => o.result === "audit") ?? null
  const manifestOp = run.ops.find((o) => o.result === "manifest") ?? null
  const hashPrefix = inp.cache.hashPrefix
  const keyShort = `${inp.cache.lookupKey.slice(0, inp.cache.lookupKey.indexOf(hashPrefix) + hashPrefix.length + 4)}…`
  const ref = (r: string): Part => ({ ref: r })
  const fg = (d: Derived, opts?: FormatOpts): Part => (opts === undefined ? { fig: d } : { fig: d, opts })
  const leaseD = input("run.leaseS", run.leaseS, "s")
  const ttlD = input("run.tokenTtlS", run.tokenTtlS, "s")
  const forbidden = fig.axioms.forbiddenFound

  /** The normal (non-takeover) fork an agent works on at time `t`, if any. */
  const normalFork = (a: AgentInput, t: number): ForkInput | null => {
    const fs = a.forks.filter((f) => f.at !== undefined && f.at <= t)
    return fs.length === 0 ? null : fs[fs.length - 1]!
  }

  // ---- the fixed event stream -------------------------------------------
  const script: Event[] = []
  for (const a of run.agents) {
    for (const f of a.forks) {
      const at = f.at ?? (crash !== null && crash.taker === a.id ? crash.expiry : null)
      if (at === null) continue
      script.push({ t: at, kind: "FORK", parts: [ref(a.id), " forked trunk → ", ref(f.fork), " (Artifacts fork, branch ", ref(f.branch), ")"] })
      script.push({ t: at, kind: "TOKEN", parts: [ref(a.id), " minted a write token (TTL ", fg(ttlD, { digits: 0 }), ", scope ", ref(`fork/${f.fork}`), ")"] })
    }
  }
  for (const w of tl.writes) {
    const parts: Part[] =
      w.kind === "acquire"
        ? [ref(w.writer), " acquired ", ref(w.op), " (If-None-Match: *) → etag ", ref(w.etag)]
        : w.kind === "renew"
          ? [ref(w.writer), " renewed ", ref(w.op), " (If-Match: ", ref(w.ifMatch!), ") → ", ref(w.etag)]
          : w.kind === "publish"
            ? [ref(w.writer), " completed ", ref(w.op), " → SUCCEEDED (If-Match: ", ref(w.ifMatch!), ") → ", ref(w.etag)]
            : [ref(w.writer), " took over ", ref(w.op), " (If-Match: ", ref(w.ifMatch!), ") → ", ref(w.etag)]
    script.push({ t: w.t, kind: w.kind === "renew" ? "HB" : "LOCK", parts })
  }
  if (manifestOp !== null) {
    script.push({ t: manifestOp.acquireAt, kind: "CACHE", parts: [ref(manifestOp.holder), ": cache MISS on ", ref(keyShort), " (cold build)"] })
    if (manifestOp.workStart !== undefined) {
      const dur = der((manifestOp.doneAt ?? manifestOp.workStart) - manifestOp.workStart, "s", "op.doneAt − op.workStart", ["inputs.run.ops"])
      script.push({ t: manifestOp.workStart, kind: "CACHE", parts: [ref(manifestOp.holder), ": importing Mathlib (", fg(fig.project.constants), ", ", fg(dur), ")"] })
    }
    if (manifestOp.doneAt !== undefined) {
      script.push({ t: manifestOp.doneAt, kind: "CACHE", parts: [ref(manifestOp.holder), ": published manifest ", ref(keyShort), " (", fg(fig.cache.blobCount), ", ", fg(fig.cache.stored), ")"] })
    }
  }
  if (auditOp !== null) {
    if (auditOp.workStart !== undefined) {
      script.push({ t: auditOp.workStart, kind: "LEAN", parts: [ref(auditOp.holder), ": axiom audit, Set ", ref(agentOf(auditOp.holder).set), ", ", fg(fig.project.theorems)] })
    }
    if (auditOp.workEnd !== undefined) {
      script.push({ t: auditOp.workEnd, kind: "LEAN", parts: [ref(auditOp.holder), ": forbidden axioms found: ", fg(forbidden, { bare: true }), " of ", fg(fig.axioms.checked), " checked"] })
    }
  }
  if (crash !== null) {
    script.push({ t: crash.at, kind: "HB", parts: [ref(crash.agent), " renewal of ", ref(crash.op), " due ", fg(clock(crash.renewalDue)), " MISSING (simulated crash)"] })
    script.push({
      t: crash.expiry,
      kind: "LEASE",
      parts: [ref(crash.op), " lease EXPIRED: last write ", fg(clock(crash.lastWrite)), " + ", fg(leaseD, { digits: 0 }), " lease (renewal due ", fg(clock(crash.renewalDue)), " missed)"]
    })
    if (manifestOp !== null) {
      script.push({ t: crash.takeoverDone, kind: "CACHE", parts: [ref(crash.taker), ": cache HIT on ", ref(keyShort), " (published by ", ref(manifestOp.holder), ")"] })
      script.push({ t: crash.takeoverDone, kind: "CACHE", parts: [ref(crash.taker), ": ", fg(fig.cache.blobCount), " verified (streaming BLAKE3, ", fg(fig.cache.stored), ")"] })
    }
  }
  const prFork = crash?.takerFork?.fork ?? null
  const reviewer = crash?.taker ?? run.agents[run.agents.length - 1]!.id
  script.push({ t: tl.review, kind: "REVIEW", parts: [ref(reviewer), ": PR ", ref(`fork/${prFork ?? "trunk"}`), " → trunk awaiting review ([a]pprove / [r]eject)"] })
  const order = (e: Event) => ["LEASE", "FORK", "TOKEN", "LOCK", "HB", "CACHE", "LEAN", "REVIEW"].indexOf(e.kind)
  script.sort((a, b) => a.t - b.t || order(a) - order(b))

  const runProgress = (t: number, finished: boolean): number => (t < 0 ? 0 : finished ? 1 : Math.min(0.99, tl.review === 0 ? 0.99 : t / tl.review))

  const outcome = (d: Decision): Event[] => {
    if (d === null || d.at < tl.review) return []
    return d.kind === "approve"
      ? [
          { t: d.at, kind: "MERGE", parts: [ref(reviewer), ": ", ref(`fork/${prFork ?? "trunk"}`), " → trunk (fast-forward)"] },
          {
            t: d.at,
            kind: "COST",
            parts: ["run complete: ", fg(fig.cost.cobuildsPerRun), " (vs ", fg(fig.cost.ghaPerRun), " on GitHub Actions); saved ", fg(fig.cost.savingsPerRun)]
          }
        ]
      : [{ t: d.at, kind: "REJECT", parts: [ref(reviewer), ": PR ", ref(`fork/${prFork ?? "trunk"}`), " rejected; fork kept for rework"] }]
  }

  // ---- state at time t ---------------------------------------------------
  const lockAt = (op: OpInput, t: number): Lock => {
    const ws = tl.writes.filter((w) => w.op === op.op && w.t <= t)
    const last = ws[ws.length - 1]
    const crashed = crash !== null && crash.op === op.op
    if (last === undefined) return { op: op.op, holder: null, state: "FREE", progress: 0, lastWrite: null, expiresAt: null, etag: null, via: "—", prev: null, result: null }
    const takenOver = crashed && last.writer === crash.taker && t >= crash.expiry
    const prev = takenOver ? `${crash.agent} (crashed)` : null
    const progress = takenOver
      ? ramp(t, crash.expiry, crash.takeoverDone)
      : op.waitsFor !== undefined
        ? ramp(t, opOf(op.waitsFor).doneAt ?? op.acquireAt, op.doneAt ?? op.crashAt!)
        : ramp(t, op.workStart ?? op.acquireAt, op.workEnd ?? op.doneAt ?? op.crashAt!)
    if (last.kind === "publish") {
      const result = op.result === "manifest" ? `manifest → ${keyShort}` : `${op.result} → ${last.etag}`
      return { op: op.op, holder: last.writer, state: "SUCCEEDED", progress: 1, lastWrite: last.t, expiresAt: null, etag: last.etag, via: "If-Match (publish)", prev, result }
    }
    const expiresAt = last.t + run.leaseS
    const via = last.kind === "acquire" ? "If-None-Match: *" : last.kind === "takeover" ? "If-Match (takeover)" : "If-Match (renew)"
    return {
      op: op.op,
      holder: last.writer,
      state: t >= expiresAt ? "EXPIRED" : "BUILDING",
      progress,
      lastWrite: last.t,
      expiresAt,
      etag: last.etag,
      via,
      prev,
      result: null,
      renewalOverdue: t > last.t + run.renewS
    }
  }

  const stateAt = (t: number, decision: Decision): State => {
    const triggered = t >= 0
    const d = effectiveDecisionAt(tl.review, t, decision)
    const finished = d !== null
    const events = triggered ? [...script, ...outcome(d)].filter((e) => e.t <= t) : []
    const locks = run.ops.map((op) => (triggered ? lockAt(op, t) : lockAt(op, -Infinity)))
    const auditRamp = auditOp === null || !triggered ? 0 : ramp(t, auditOp.workStart ?? auditOp.acquireAt, auditOp.workEnd ?? auditOp.crashAt ?? auditOp.doneAt!)
    const theoremsAudited = der(Math.round(inp.project.theorems * auditRamp), "theorems", "project.theorems × audit progress", ["inputs.project.theorems", "script time t"])
    const auditDone = auditOp !== null && triggered && t >= (auditOp.workEnd ?? auditOp.doneAt ?? Infinity)
    const published = manifestOp !== null && triggered && t >= (manifestOp.doneAt ?? Infinity)
    const verifiedByTaker = crash !== null && triggered && t >= crash.takeoverDone
    const p = runProgress(t, finished)
    const costSoFar = der(fig.cost.cobuildsPerRun.value * p, "USD", "cobuildsPerRun × run progress", ["cost.cobuildsPerRun", "script time t"])
    const ghaEquivalent = der(fig.cost.ghaPerRun.value * p, "USD", "ghaPerRun × run progress", ["cost.ghaPerRun", "script time t"])

    const agents = run.agents.map((a): Agent => agentAt(a, t, triggered, d, locks))
    const forks: ForkView[] = run.agents.flatMap((a) =>
      a.forks.flatMap((f): ForkView[] => {
        const at = f.at ?? (crash !== null && crash.taker === a.id ? crash.expiry : null)
        if (!triggered || at === null || t < at) return []
        const isPr = crash !== null && f.on === "takeover" && crash.taker === a.id
        return [{ agent: a.id, fork: f.fork, branch: f.branch, commit: commitOf(a, f, t), merged: isPr && d !== null && d.kind === "approve" }]
      })
    )
    return {
      t,
      triggered,
      agents,
      locks,
      events,
      theoremsAudited,
      auditDone,
      published,
      verifiedByTaker,
      costSoFar,
      ghaEquivalent,
      finished,
      awaitingReview: triggered && t >= tl.review && d === null,
      forks
    }
  }

  /** The time a fork's work is finished (its commit exists from then on). */
  const forkDoneAt = (a: AgentInput, f: ForkInput): number => {
    if (f.on === "takeover") return crash !== null && crash.taker === a.id ? crash.takeoverDone : Infinity
    const mine = run.ops.filter((o) => o.holder === a.id && normalFork(a, o.acquireAt) === f)
    if (mine.length === 0) return Infinity
    return Math.max(...mine.map((o) => o.workEnd ?? o.doneAt ?? Infinity))
  }
  const commitOf = (a: AgentInput, f: ForkInput, t: number): string | null => (t >= forkDoneAt(a, f) ? f.commit : null)

  const agentAt = (a: AgentInput, t: number, triggered: boolean, d: Decision, locks: ReadonlyArray<Lock>): Agent => {
    const isTaker = crash !== null && crash.taker === a.id
    const takeoverFork = isTaker && t >= crash.expiry ? crash.takerFork : null
    const fork = takeoverFork ?? normalFork(a, t)
    const first = a.forks.filter((f) => f.at !== undefined).map((f) => f.at!)
    const firstAt = first.length === 0 ? Infinity : Math.min(...first)
    const idle: Agent = { id: a.id, fork: null, status: "IDLE", detail: [], tokenLeft: null, branch: a.forks[0]!.branch, commit: null, diff: null, set: a.set, audited: null }
    if (!triggered || fork === null || t < firstAt) return idle
    const held = locks.filter((l) => l.holder === a.id && (l.state === "BUILDING" || l.state === "EXPIRED"))
    const crashed = crash !== null && crash.agent === a.id && t >= crash.at
    const future = run.ops.some((o) => o.holder === a.id && o.acquireAt > t) || (isTaker && t < crash.expiry)
    const hadWork = run.ops.some((o) => o.holder === a.id && o.acquireAt <= t)
    let status: AgentStatus
    let detail: Part[]
    if (t < firstAt + run.spawnS) {
      status = "SPAWNING"
      detail = ["fork + token"]
    } else if (crashed) {
      status = "CRASHED"
      detail = ["no write since ", fg(clock(crash.lastWrite))]
    } else if (isTaker && t >= tl.review) {
      status = d === null ? "REVIEW" : d.kind === "approve" ? "MERGED" : "REJECTED"
      detail = [d === null ? "PR awaiting review" : d.kind === "approve" ? "fast-forward to trunk" : "PR rejected"]
    } else if (held.length > 0) {
      const op = opOf(held[held.length - 1]!.op)
      const waiting = op.waitsFor !== undefined && t < (opOf(op.waitsFor).doneAt ?? Infinity)
      status = waiting ? "WAITING" : "BUILDING"
      detail = waiting ? ["awaiting ", ref(op.waitsFor!)] : isTaker && crash.op === op.op ? ["takeover of ", ref(op.op)] : [ref(shortOp(op.op))]
    } else if (isTaker && t >= crash.takeoverDone) {
      status = "BUILDING"
      detail = ["opening PR"]
    } else if (future) {
      status = "WAITING"
      detail = isTaker ? [ref(crash.op), " held by ", ref(crash.agent)] : ["next operation"]
    } else if (hadWork) {
      status = "DONE"
      detail = ["all operations succeeded"]
    } else {
      status = "WAITING"
      detail = ["no operation"]
    }
    const mint = takeoverFork !== null ? crash!.expiry : (fork.at ?? 0)
    const revoked = status === "CRASHED" || status === "DONE" || status === "MERGED" || status === "REJECTED"
    const tokenLeft = revoked ? 0 : Math.max(0, Math.min(run.tokenTtlS, Math.ceil(mint + run.tokenTtlS - t)))
    const commit = commitOf(a, fork, t)
    const ai = run.agents.indexOf(a)
    const fi = a.forks.indexOf(fork)
    const diff =
      commit === null
        ? null
        : {
            added: input(`run.agents[${ai}].forks[${fi}].added`, fork.added, "lines"),
            removed: input(`run.agents[${ai}].forks[${fi}].removed`, fork.removed, "lines"),
            files: input(`run.agents[${ai}].forks[${fi}].files`, fork.files, "files")
          }
    const audited =
      auditOp !== null && auditOp.holder === a.id
        ? der(
            Math.round(inp.project.theorems * ramp(t, auditOp.workStart ?? auditOp.acquireAt, auditOp.workEnd ?? auditOp.crashAt ?? auditOp.doneAt!)),
            "theorems",
            "project.theorems × audit progress",
            ["inputs.project.theorems", "script time t"]
          )
        : null
    return { id: a.id, fork: fork.fork, status, detail, tokenLeft, branch: fork.branch, commit, diff, set: a.set, audited }
  }

  return { timeline: tl, script, stateAt, clock }
}

/** The demo's scenario, from `inputs.json`. */
export const FIGURES: Figures = deriveFigures(INPUTS)
export const SCENARIO: Scenario = makeScenario(INPUTS, FIGURES)
export const TIMELINE: Timeline = SCENARIO.timeline
export const SCRIPT: ReadonlyArray<Event> = SCENARIO.script
export const stateAt = SCENARIO.stateAt
export const effectiveDecision = (t: number, d: Decision): Decision => effectiveDecisionAt(TIMELINE.review, t, d)
