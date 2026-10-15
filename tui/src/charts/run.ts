/**
 * The charts of the cobuild run as data: for a state and a plot size, the
 * cells of every chart and the derived figures of its axes and legend. The
 * components in `src/panels/ChartsView.tsx` only lay these out.
 *
 * Requirements (stated without reference to any test):
 * - R1. Scales are fixed for the whole run (computed from the full series),
 *   so a chart does not rescale while the run plays; only the revealed part
 *   changes (C2 in `series.ts`).
 * - R2. The cursor column is the column of the script time `t` (null before
 *   the trigger and after the end of the axis).
 * - R3. Every figure shown carries a formula naming where it comes from.
 */
import { GLYPHS, LOWER_EIGHTHS } from "../glyphs.ts"
import { type Derived, type Figures, der } from "../derive.ts"
import type { Inputs } from "../data.ts"
import { type OpState, type State, stateAt } from "../scenario.ts"
import { type Cell, BLANK, columnOf, hbar, lineChart, logAxis, logFraction, niceMax, resampleNearest, sparkline, spreadBars, vbars } from "./plot.ts"
import {
  CHART_SPAN_S,
  crashMark,
  eventHistogram,
  type LaneSample,
  reveal,
  runSeries,
  type RunSeries,
  sampleIndex,
  writeHistogram,
  writesUpTo
} from "./series.ts"

const SRC = ["charts", "stateAt(t) sampled every CHART_STEP_S"]
const PCT = 100

/** Time-axis labels: 0 s and the span. */
export const timeAxis = (): { readonly left: Derived; readonly right: Derived } => ({
  left: der(0, "s", "start of the run", ["script time"]),
  right: der(CHART_SPAN_S, "s", "review + autoApproveDelay + tail", ["inputs.run", "charts"])
})

/** R2. */
export const cursorColumn = (t: number, plotW: number): number | null => columnOf(t, CHART_SPAN_S, plotW)

// ---------------------------------------------------------------------------
// Lease timeline

/** Palette index of a timeline cell: background categories, then one per agent. */
export const LANE_KIND = { free: 0, done: 1, expired: 2, failed: 3, crash: 4, stale: 5, agent0: 6 } as const

export interface Timeline {
  readonly lanes: ReadonlyArray<{ readonly op: string; readonly cells: ReadonlyArray<Cell> }>
  readonly agents: ReadonlyArray<string>
  readonly cursor: number | null
}

const laneCell = (s: LaneSample | null, agents: ReadonlyArray<string>): Cell => {
  if (s === null) return BLANK
  if (s.stale) return { ch: GLYPHS.barOff.char, k: LANE_KIND.stale }
  const byState: Record<OpState, Cell> = {
    FREE: { ch: GLYPHS.middot.char, k: LANE_KIND.free },
    SUCCEEDED: { ch: LOWER_EIGHTHS[LOWER_EIGHTHS.length >> 1]!, k: LANE_KIND.done },
    EXPIRED: { ch: GLYPHS.barOff.char, k: LANE_KIND.expired },
    FAILED: { ch: GLYPHS.barOn.char, k: LANE_KIND.failed },
    BUILDING: { ch: GLYPHS.barOn.char, k: LANE_KIND.agent0 + Math.max(0, agents.indexOf(s.holder ?? "")) }
  }
  return byState[s.state]
}

export const timeline = (st: State, inputs: Inputs, plotW: number, series: RunSeries = runSeries()): Timeline => {
  const agents = inputs.run.agents.map((a) => a.id)
  const crash = crashMark(series)
  const crashCol = crash === null || st.t < crash.at ? null : cursorColumn(crash.at, plotW)
  return {
    agents,
    cursor: cursorColumn(st.t, plotW),
    lanes: series.lanes.map((lane, li) => {
      const cells = resampleNearest(reveal(lane.samples, series.times, st.t), plotW, null).map((s) => laneCell(s, agents))
      return { op: lane.op, cells: crash !== null && li === crash.lane && crashCol !== null ? cells.map((c, i) => (i === crashCol ? { ch: GLYPHS.bad.char, k: LANE_KIND.crash } : c)) : cells }
    })
  }
}

// ---------------------------------------------------------------------------
// Line charts

export interface LinePlot {
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>
  readonly yTop: Derived
  readonly yBottom: Derived
  readonly cursor: number | null
}

const fullMax = (xs: ReadonlyArray<number>): number => niceMax(Math.max(0, ...xs))

/** Cumulative cost: series 0 = GitHub Actions equivalent, 1 = Cobuilds. */
export const costPlot = (st: State, plotW: number, plotH: number, series: RunSeries = runSeries()) => {
  const top = fullMax(series.gha)
  const k = sampleIndex(series.times, st.t)
  const plot: LinePlot = {
    rows: lineChart([reveal(series.gha, series.times, st.t), reveal(series.cost, series.times, st.t)], plotW, plotH, 0, top),
    yTop: der(top, "USD", "nice ceiling of the largest GitHub Actions equivalent of the run", SRC),
    yBottom: der(0, "USD", "axis origin", SRC),
    cursor: cursorColumn(st.t, plotW)
  }
  const gha = k < 0 ? 0 : series.gha[k]!
  const cost = k < 0 ? 0 : series.cost[k]!
  return {
    plot,
    gha: der(gha, "USD", "state.ghaEquivalent at the cursor", SRC),
    cost: der(cost, "USD", "state.costSoFar at the cursor", SRC),
    saved: der(gha <= 0 ? 0 : ((gha - cost) / gha) * PCT, "%", "(gha − cost) / gha × 100 at the cursor", SRC)
  }
}

/** Progress: series 0 = mean lock progress, 1 = audit share. */
export const progressPlot = (st: State, plotW: number, plotH: number, series: RunSeries = runSeries()) => {
  const k = sampleIndex(series.times, st.t)
  const plot: LinePlot = {
    rows: lineChart([reveal(series.progressPct, series.times, st.t), reveal(series.auditPct, series.times, st.t)], plotW, plotH, 0, PCT),
    yTop: der(PCT, "%", "percent scale", SRC),
    yBottom: der(0, "%", "axis origin", SRC),
    cursor: cursorColumn(st.t, plotW)
  }
  return {
    plot,
    progress: der(k < 0 ? 0 : series.progressPct[k]!, "%", "mean of the locks' progress at the cursor", SRC),
    audited: der(k < 0 ? 0 : series.theorems[k]!, "theorems", "state.theoremsAudited at the cursor", SRC),
    opsDone: der(k < 0 ? 0 : series.opsDone[k]!, "ops", "locks in state SUCCEEDED at the cursor", SRC),
    ops: der(series.lanes.length, "ops", "locks of the run", SRC)
  }
}

// ---------------------------------------------------------------------------
// Activity

let eventTop: number | null = null

/** Largest events-per-bucket count of the whole run (R1), at least 1. */
const eventScale = (): number => {
  if (eventTop === null) eventTop = Math.max(1, ...eventHistogram(stateAt(CHART_SPAN_S, null)).map((v) => v ?? 0))
  return eventTop
}

export const activityPlot = (st: State, plotW: number, plotH: number) => {
  const events = eventHistogram(st)
  const writes = writeHistogram(st.t)
  const top = niceMax(eventScale())
  const writeTop = Math.max(1, ...writeHistogram(CHART_SPAN_S).map((v) => v ?? 0))
  return {
    rows: vbars(spreadBars(events, plotW), plotH, top),
    spark: sparkline(spreadBars(writes, plotW), writeTop),
    yTop: der(top, "events", "nice ceiling of the largest events per bucket of the run", SRC),
    yBottom: der(0, "events", "axis origin", SRC),
    cursor: cursorColumn(st.t, plotW),
    events: der(st.events.filter((e) => e.t <= st.t).length, "events", "events in the state at t", SRC),
    writes: der(writesUpTo(st.t), "writes", "scripted conditional writes at or before t", ["timeline.writes"])
  }
}

// ---------------------------------------------------------------------------
// Bar charts (static figures)

export interface BarSpec {
  readonly label: string
  readonly fraction: number
  readonly value: Derived
  readonly bar: string
}

export const monthlyBars = (fig: Figures, barW: number): ReadonlyArray<BarSpec & { readonly good: boolean }> => {
  const c = fig.cost
  const rows = [
    { label: "GitHub Actions (standard runners)", value: c.ghaMonthly, good: false },
    { label: "GitHub Actions (larger 4-core runners)", value: c.ghaLargerMonthly, good: false },
    { label: "Cobuilds on Cloudflare", value: c.cobuildsMonthly, good: true }
  ]
  const top = Math.max(0, ...rows.map((r) => r.value.value))
  return rows.map((r) => {
    const fraction = top <= 0 ? 0 : r.value.value / top
    return { ...r, fraction, bar: hbar(fraction, barW) }
  })
}

export const algorithmBars = (fig: Figures, barW: number): ReadonlyArray<BarSpec & { readonly speedup: Derived }> => {
  const axis = logAxis(fig.algorithms.map((a) => a.total.value))
  return fig.algorithms.map((a) => {
    const fraction = logFraction(a.total.value, axis.lo, axis.hi)
    return { label: a.name, value: a.total, speedup: a.speedup, fraction, bar: hbar(fraction, barW) }
  })
}
