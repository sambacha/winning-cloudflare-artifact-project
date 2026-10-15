/**
 * Time series of the scripted cobuild run for the charts view, sampled from
 * the scenario's own pure function `stateAt` (nothing here is typed in: every
 * point is a state of the run the panels already show).
 *
 * Requirements (stated without reference to any test):
 * - C1. The series cover script time 0..`CHART_SPAN_S` at `CHART_STEP_S`
 *   resolution and are computed once (they depend on nothing but the inputs).
 * - C2. `reveal(series, t)` keeps the samples at or before `t` and turns the
 *   later ones into `null` (P4 in `plot.ts`), so a chart never shows the
 *   future of the run; before the trigger (t < 0) nothing is shown.
 * - C3. The lock lanes of the timeline are exactly the scenario's locks, in
 *   the scenario's order, and each sample is that lock's state at that time.
 * - C4. Event and write counts per bucket are counts of the events in the
 *   state at `t` and of the scripted writes, in buckets of `BUCKET_S`.
 */
import { type Decision, type Lock, type OpState, type State, stateAt, TIMELINE } from "../scenario.ts"

/** Seconds between two samples of the time series. */
export const CHART_STEP_S = 0.5
/** Seconds of the run after the auto-approval that the charts still show (the merge). */
const TAIL_S = 4
/** Seconds of script time on the x axis: the review gate, the auto-approval, and the merge after it. */
export const CHART_SPAN_S = Math.ceil(TIMELINE.review + TIMELINE.autoApproveDelay) + TAIL_S
/** Seconds per bar of the activity histogram. */
export const BUCKET_S = 2

export interface LaneSample {
  readonly state: OpState
  readonly holder: string | null
  /** The holder missed its renewal (crashed): the lease is held but stale until it expires. */
  readonly stale: boolean
}

export interface Lane {
  readonly op: string
  readonly samples: ReadonlyArray<LaneSample>
}

export interface RunSeries {
  readonly times: ReadonlyArray<number>
  /** Cobuilds cost so far and the GitHub Actions equivalent, USD. */
  readonly cost: ReadonlyArray<number>
  readonly gha: ReadonlyArray<number>
  /** Theorems audited so far, and as a percentage of the project's theorems. */
  readonly theorems: ReadonlyArray<number>
  readonly auditPct: ReadonlyArray<number>
  /** Mean progress of the locks, percent (an operation that is done counts 100). */
  readonly progressPct: ReadonlyArray<number>
  /** Operations finished (SUCCEEDED). */
  readonly opsDone: ReadonlyArray<number>
  readonly lanes: ReadonlyArray<Lane>
}

const lockPct = (l: Lock): number => (l.state === "SUCCEEDED" ? 1 : l.state === "FREE" ? 0 : Math.max(0, Math.min(1, l.progress)))

const PCT = 100

/** C1: sample the run (decision-free: the series end before the review gate's outcome matters). */
export const sampleRun = (decision: Decision = null, theoremsTotal?: number): RunSeries => {
  const n = Math.round(CHART_SPAN_S / CHART_STEP_S) + 1
  const times = Array.from({ length: n }, (_, i) => i * CHART_STEP_S)
  const states: State[] = times.map((t) => stateAt(t, decision))
  const last = states[states.length - 1]!
  const total = theoremsTotal ?? Math.max(1, last.theoremsAudited.value)
  const ops = last.locks.map((l) => l.op)
  return {
    times,
    cost: states.map((s) => s.costSoFar.value),
    gha: states.map((s) => s.ghaEquivalent.value),
    theorems: states.map((s) => s.theoremsAudited.value),
    auditPct: states.map((s) => (s.theoremsAudited.value / total) * PCT),
    progressPct: states.map((s) => (s.locks.length === 0 ? 0 : (s.locks.reduce((a, l) => a + lockPct(l), 0) / s.locks.length) * PCT)),
    opsDone: states.map((s) => s.locks.filter((l) => l.state === "SUCCEEDED").length),
    lanes: ops.map((op) => ({
      op,
      samples: states.map((s): LaneSample => {
        const l = s.locks.find((x) => x.op === op)
        return l === undefined ? { state: "FREE", holder: null, stale: false } : { state: l.state, holder: l.holder, stale: l.state === "BUILDING" && l.renewalOverdue === true }
      })
    }))
  }
}

let cached: RunSeries | null = null

/** The run's series (computed on first use, then shared). */
export const runSeries = (): RunSeries => {
  if (cached === null) cached = sampleRun()
  return cached
}

/** C2: samples after `t` become null. */
export const reveal = <A>(values: ReadonlyArray<A>, times: ReadonlyArray<number>, t: number): Array<A | null> =>
  values.map((v, i) => (t >= 0 && times[i]! <= t + 1e-9 ? v : null))

/** Index of the last sample at or before `t` (-1 before the trigger). */
export const sampleIndex = (times: ReadonlyArray<number>, t: number): number => {
  if (t < 0) return -1
  let k = -1
  for (let i = 0; i < times.length; i++) if (times[i]! <= t + 1e-9) k = i
  return k
}

const bucketCount = (): number => Math.ceil(CHART_SPAN_S / BUCKET_S)

/** C4: number of `ts` per bucket of `BUCKET_S`, buckets that start after `t` are null. */
export const histogram = (ts: ReadonlyArray<number>, t: number): Array<number | null> => {
  const n = bucketCount()
  const counts = Array.from({ length: n }, () => 0)
  for (const x of ts) {
    if (x < 0 || x > t) continue
    counts[Math.min(n - 1, Math.floor(x / BUCKET_S))]! += 1
  }
  return counts.map((c, i) => (t >= 0 && i * BUCKET_S <= t ? c : null))
}

/** Events of the state per bucket (they include the decision's events). */
export const eventHistogram = (st: State): Array<number | null> =>
  histogram(
    st.events.map((e) => e.t),
    st.t
  )

/** Conditional writes to R2 per bucket (acquire, renew, publish, takeover). */
export const writeHistogram = (t: number): Array<number | null> =>
  histogram(
    TIMELINE.writes.map((w) => w.t),
    t
  )

/** Total scripted writes up to `t`. */
export const writesUpTo = (t: number): number => TIMELINE.writes.filter((w) => w.t <= t).length

/** The crash on the timeline: lane index and time, or null if the script has none. */
export const crashMark = (s: RunSeries): { readonly lane: number; readonly at: number; readonly expiry: number } | null => {
  const c = TIMELINE.crash
  if (c === null) return null
  const lane = s.lanes.findIndex((l) => l.op === c.op)
  return lane < 0 ? null : { lane, at: c.at, expiry: c.expiry }
}
