/**
 * The charts of the clean build-pipeline run (`--scenario clean`, panel 7)
 * as data. Bisect charts read the status bodies the Bisect panel shows
 * (fixture or live route), revealed up to the current step; the cache and
 * cost charts read the same figures as the other panels.
 *
 * Requirements (stated without reference to any test):
 * - CC1. Before the Bisect panel has been opened (step -1) the bisect charts
 *   are empty; after k observations they show steps 0..k and nothing later.
 * - CC2. The probe of step k is the commit whose tally changed between the
 *   bodies k-1 and k (read from the route, never from the fixture's script).
 * - CC3. A commit is placed on the probe axis by its `#n` number out of the
 *   candidates; a commit without a number is not drawn.
 */
import type { BisectStatus, StatusTally } from "../clean/bisectStatus.ts"
import { buildFigures, costFigures, dependencyFigures } from "../clean/figures.ts"
import { DEPENDENCIES } from "../clean/fixture.ts"
import { MS_PER_S } from "../clean/layout.ts"
import { bisectStep, type CleanState } from "../clean/model.ts"
import { type Derived, der } from "../derive.ts"
import { GLYPHS } from "../glyphs.ts"
import { type Cell, hbar, lineChart } from "./plot.ts"

const PCT = 100
const SRC = ["status route"]

/** CC1: the status bodies shown so far (index k = after k observations). */
export const shownStatuses = (st: CleanState, statuses: ReadonlyArray<BisectStatus>): ReadonlyArray<BisectStatus> => {
  const k = bisectStep(st)
  return k < 0 ? [] : statuses.slice(0, Math.min(statuses.length, k + 1))
}

/** Steps on the x axis: the longest run the source has (so the axis does not move). */
export const stepSpan = (statuses: ReadonlyArray<BisectStatus>): number => Math.max(1, statuses.length - 1)

/** Confidence (series 0) and entropy as a percentage of the initial entropy (series 1). */
export const confidencePlot = (st: CleanState, statuses: ReadonlyArray<BisectStatus>, plotW: number, plotH: number) => {
  const shown = shownStatuses(st, statuses)
  const n = stepSpan(statuses) + 1
  const h0 = statuses[0]?.status.entropy ?? 0
  const pad = <A>(xs: ReadonlyArray<A>): Array<A | null> => Array.from({ length: n }, (_, i) => (i < xs.length ? xs[i]! : null))
  const conf = pad(shown.map((s) => s.status.confidence * PCT))
  const ent = pad(shown.map((s) => (h0 > 0 ? (s.status.entropy / h0) * PCT : 0)))
  const last = shown[shown.length - 1]
  return {
    rows: lineChart([ent, conf], plotW, plotH, 0, PCT),
    yTop: der(PCT, "%", "percent scale", ["charts"]),
    yBottom: der(0, "%", "axis origin", ["charts"]),
    xLeft: der(0, "steps", "before the first observation", SRC),
    xRight: der(stepSpan(statuses), "steps", "status bodies of the source − 1", SRC),
    confidence: last === undefined ? null : der(last.status.confidence, "probability", "status.confidence of the last body shown", SRC),
    entropy: last === undefined ? null : der(last.status.entropy, "probability", "status.entropy of the last body shown (bits)", SRC),
    started: shown.length > 0
  }
}

/** The `#n` number of a commit message, or null. */
export const commitNumber = (message: string | undefined): number | null => {
  const m = /^#(\d+)/.exec(message ?? "")
  return m === null ? null : Number(m[1])
}

const count = (t: StatusTally): number => t.fails + t.passes + t.skips

/** CC2: the probe of each step k ≥ 1 (null for step 0 and when no tally changed). */
export const probes = (shown: ReadonlyArray<BisectStatus>): ReadonlyArray<{ readonly n: number | null; readonly failed: boolean } | null> =>
  shown.map((s, k) => {
    if (k === 0) return null
    const before = new Map(shown[k - 1]!.tally.map((t) => [t.oid, t]))
    const changed = s.tally.find((t) => count(t) > (before.get(t.oid) === undefined ? 0 : count(before.get(t.oid)!)))
    if (changed === undefined) return null
    const prev = before.get(changed.oid)
    return { n: commitNumber(changed.message), failed: changed.fails > (prev?.fails ?? 0) }
  })

/** Probe-axis kinds: 0 = pass, 1 = fail, 2 = posterior culprit, 3 = axis dots. */
export const PROBE_KIND = { pass: 0, fail: 1, culprit: 2, axis: 3 } as const

/** CC3: one row per observation: the probed commit (✓ pass / ✗ fail) and the culprit guess (●) on the 1..candidates axis. */
export const probeRows = (st: CleanState, statuses: ReadonlyArray<BisectStatus>, plotW: number): ReadonlyArray<{ readonly step: Derived; readonly cells: ReadonlyArray<Cell> }> => {
  const shown = shownStatuses(st, statuses)
  const candidates = statuses[0]?.candidates ?? 0
  const col = (n: number | null): number | null => (n === null || candidates <= 0 || n < 1 || n > candidates ? null : Math.min(plotW - 1, Math.floor(((n - 1) * plotW) / candidates)))
  const ps = probes(shown)
  return shown.slice(1).map((s, i) => {
    const cells: Cell[] = Array.from({ length: plotW }, () => ({ ch: GLYPHS.middot.char, k: PROBE_KIND.axis }))
    const c = col(commitNumber(s.status.culprit.message))
    if (c !== null) cells[c] = { ch: GLYPHS.dot.char, k: PROBE_KIND.culprit }
    const p = ps[i + 1]
    const pc = p === null || p === undefined ? null : col(p.n)
    if (p !== null && p !== undefined && pc !== null) cells[pc] = p.failed ? { ch: GLYPHS.bad.char, k: PROBE_KIND.fail } : { ch: GLYPHS.ok.char, k: PROBE_KIND.pass }
    return { step: der(i + 1, "steps", "observation number", SRC), cells }
  })
}

export const probeAxis = (statuses: ReadonlyArray<BisectStatus>) => ({
  left: der(1, "commits", "first candidate", SRC),
  right: der(statuses[0]?.candidates ?? 0, "commits", "status.candidates", SRC)
})

export interface CleanBar {
  readonly label: string
  readonly value: Derived
  readonly fraction: number
  readonly bar: string
  readonly good: boolean
}

const bars = (rows: ReadonlyArray<{ readonly label: string; readonly value: Derived; readonly good: boolean }>, barW: number): CleanBar[] => {
  const top = Math.max(0, ...rows.map((r) => r.value.value))
  return rows.map((r) => {
    const fraction = top <= 0 ? 0 : r.value.value / top
    return { ...r, fraction, bar: hbar(fraction, barW) }
  })
}

/** Dependency restore against a cold install (seconds), and build-cache hits against misses. */
export const cacheBars = (barW: number) => {
  const d = dependencyFigures()
  const b = buildFigures()
  const cold = der(DEPENDENCIES.coldInstallMs / MS_PER_S, "s", "manifest.coldInstallMs / 1000 (the cold npm ci a hit avoids)", ["fixture.DEPENDENCIES.coldInstallMs"])
  return {
    deps: bars(
      [
        { label: "cold npm ci", value: cold, good: false },
        { label: "R2 cache restore", value: d.restore, good: true }
      ],
      barW
    ),
    build: bars(
      [
        { label: "cache hits", value: b.hits, good: true },
        { label: "cache misses (rebuilt)", value: b.misses, good: false }
      ],
      barW
    ),
    saved: d.saved
  }
}

export const costBars = (barW: number) => {
  const c = costFigures()
  return {
    bars: bars(
      [
        { label: "GitHub Actions", value: c.gha, good: false },
        { label: "Cobuilds", value: c.cobuilds, good: true }
      ],
      barW
    ),
    reduction: der(c.gha.value <= 0 ? 0 : ((c.gha.value - c.cobuilds.value) / c.gha.value) * PCT, "%", "(gha − cobuilds) / gha × 100", ["fixture.COST"])
  }
}
