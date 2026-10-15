/**
 * State and pure update function of the clean build-pipeline scenario
 * (`--scenario clean`). `main.ts` does the terminal I/O.
 *
 * Rules:
 * - M1. The phases a panel shows depend only on the script time `t` and on
 *   when the panel was first opened (`visits`). A panel's progress starts
 *   when it is first shown. So a recording that opens the panels a little
 *   earlier or later sees the same sequence of states, and every
 *   intermediate state (RESTORING, REBUILDING, ...) is on screen for its full
 *   duration from the lookup tables.
 * - M2. `a` is accepted only while the approval gate is open (bisect
 *   converged, not yet approved). `n` is accepted only after approval and
 *   only once.
 * - M3. `--autoplay` presses the scripted keys at their scheduled times
 *   until the first key arrives from the keyboard. From then on the keyboard
 *   (for example a VHS tape) drives the panels. The first scripted key comes
 *   8 s after launch, later than a tape's first key even with recorder lag,
 *   so a recording never races the script.
 * - M4. `stateAt(T)` (snapshots, the headless transcript) is the state
 *   reached by pressing the scripted keys at their times, read at `T`. It is
 *   exact: no tick accumulation.
 * - M5. Nothing here reads a clock or a random source.
 */
import type { BisectStatus } from "./bisectStatus.ts"
import { isConverged } from "./bisectStatus.ts"
import { rebuildMs } from "./figures.ts"
import { BISECT, BUILD, DEPENDENCIES, LEASE_POLICY } from "./fixture.ts"

export type CleanPanelId = 1 | 2 | 3 | 4 | 5 | 6 | 7

export const CLEAN_PANELS: ReadonlyArray<{ readonly id: CleanPanelId; readonly name: string }> = [
  { id: 1, name: "Environment" },
  { id: 2, name: "Dependencies" },
  { id: 3, name: "Build" },
  { id: 4, name: "Bisect" },
  { id: 5, name: "Coordination" },
  { id: 6, name: "Event stream" },
  { id: 7, name: "Charts" }
]

export interface CleanState {
  /** Script seconds since launch. */
  readonly t: number
  /** 0 = start screen; 1-6 = the panel shown. */
  readonly focus: 0 | CleanPanelId
  /** Script time at which each panel was first shown. */
  readonly visits: Readonly<Partial<Record<CleanPanelId, number>>>
  readonly approvedAt: number | null
  readonly noteAt: number | null
}

export const START: CleanState = { t: 0, focus: 0, visits: {}, approvedAt: null, noteAt: null }

const MS = 1000

const since = (st: CleanState, id: CleanPanelId): number | null => {
  const v = st.visits[id]
  return v === undefined ? null : (st.t - v) * MS
}

export type DepsPhase = "unvisited" | "restoring" | "hit"
export const depsPhase = (st: CleanState): DepsPhase => {
  const e = since(st, 2)
  return e === null ? "unvisited" : e < DEPENDENCIES.restoreMs ? "restoring" : "hit"
}

export type BuildPhase = "unvisited" | "checking" | "rebuilding" | "published"
export const buildPhase = (st: CleanState): BuildPhase => {
  const e = since(st, 3)
  if (e === null) return "unvisited"
  if (e < BUILD.checkMs) return "checking"
  return e < BUILD.checkMs + rebuildMs() ? "rebuilding" : "published"
}

/** Observations replayed so far: -1 before the Bisect panel is opened, then 0..8. */
export const bisectStep = (st: CleanState): number => {
  const e = since(st, 4)
  return e === null ? -1 : Math.min(BISECT.observations.length, Math.floor(e / BISECT.stepMs))
}

/** The status body the Bisect panel shows (the last one for a live source with a single body). */
export const statusAt = (st: CleanState, statuses: ReadonlyArray<BisectStatus>): BisectStatus | null => {
  const k = bisectStep(st)
  return k < 0 || statuses.length === 0 ? null : statuses[Math.min(k, statuses.length - 1)]!
}

export const converged = (st: CleanState, statuses: ReadonlyArray<BisectStatus>): boolean => {
  const s = statusAt(st, statuses)
  return s !== null && isConverged(s)
}

export type ReviewPhase = "closed" | "open" | "approved"
export const reviewPhase = (st: CleanState, statuses: ReadonlyArray<BisectStatus>): ReviewPhase =>
  st.approvedAt !== null ? "approved" : converged(st, statuses) ? "open" : "closed"

export type CoordinationPhase = "unvisited" | "leases" | "heartbeat"
export const coordinationPhase = (st: CleanState): CoordinationPhase => {
  const e = since(st, 5)
  return e === null ? "unvisited" : e < LEASE_POLICY.heartbeatShownAfterMs ? "leases" : "heartbeat"
}

/** Apply a key at the state's current time. Unknown keys change nothing. */
export const pressKey = (st: CleanState, key: string, statuses: ReadonlyArray<BisectStatus>): CleanState => {
  const panel = key === "e" ? 6 : key === "c" || key === "7" ? 7 : /^[1-6]$/.test(key) ? (Number(key) as CleanPanelId) : null
  if (panel !== null) return { ...st, focus: panel, visits: st.visits[panel] === undefined ? { ...st.visits, [panel]: st.t } : st.visits }
  if (key === "a") return reviewPhase(st, statuses) === "open" ? { ...st, approvedAt: st.t } : st
  if (key === "n") return st.approvedAt !== null && st.noteAt === null ? { ...st, noteAt: st.t } : st
  return st
}

/** Quit keys: q, Ctrl-Q, Ctrl-C. */
export const isQuitKey = (key: string): boolean => key === "q" || key === "\x11" || key === "\x03"

/**
 * The autoplay script: keys and their script times (seconds). It follows
 * the storyboard. The tape presses the same keys, so a recording and an
 * unattended autoplay pass through the same states.
 */
export const AUTOPLAY_SCRIPT: ReadonlyArray<{ readonly at: number; readonly key: string }> = [
  { at: 8, key: "1" },
  { at: 11, key: "2" },
  { at: 15, key: "3" },
  { at: 19, key: "4" },
  { at: 27, key: "5" },
  { at: 31, key: "6" },
  { at: 35, key: "4" },
  { at: 37, key: "a" },
  { at: 39, key: "n" },
  { at: 41, key: "6" }
]

/** Script time at which the autoplay run is complete (the last frame of the headless transcript). */
export const AUTOPLAY_END = 44

/** M4: the state at script time `T` when the scripted keys are pressed at their times. */
export const stateAt = (T: number, statuses: ReadonlyArray<BisectStatus>): CleanState => {
  let st = START
  for (const k of AUTOPLAY_SCRIPT) {
    if (k.at > T) break
    st = pressKey({ ...st, t: k.at }, k.key, statuses)
  }
  return { ...st, t: Math.max(0, T) }
}

/** The interactive app: the scenario state plus autoplay bookkeeping. */
export interface CleanApp {
  readonly st: CleanState
  readonly autoplay: boolean
  /** A key arrived from the keyboard: autoplay stops pressing keys (M3). */
  readonly manual: boolean
  /** Index of the next scripted key. */
  readonly next: number
  readonly quit: boolean
}

export const initialApp = (autoplay: boolean): CleanApp => ({ st: START, autoplay, manual: false, next: 0, quit: false })

export const onKey = (app: CleanApp, key: string, statuses: ReadonlyArray<BisectStatus>): CleanApp =>
  isQuitKey(key) ? { ...app, quit: true } : { ...app, manual: true, st: pressKey(app.st, key, statuses) }

export const onTick = (app: CleanApp, dtS: number, statuses: ReadonlyArray<BisectStatus>): CleanApp => {
  let st: CleanState = { ...app.st, t: app.st.t + dtS }
  let next = app.next
  if (app.autoplay && !app.manual) {
    while (next < AUTOPLAY_SCRIPT.length && AUTOPLAY_SCRIPT[next]!.at <= st.t) {
      st = pressKey(st, AUTOPLAY_SCRIPT[next]!.key, statuses)
      next++
    }
  }
  return { ...app, st, next }
}
