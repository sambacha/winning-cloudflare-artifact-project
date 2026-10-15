/**
 * Application state and a pure update function (no I/O): keys, clock ticks
 * and resizes in, new state out. `main.ts` does the terminal I/O.
 *
 * Rules:
 * - A1. `scroll` stays within [0, body − viewport] after every message
 *   (key, tick or resize).
 * - A2. A decision (approve/reject) is accepted only while the review gate
 *   is open; SPACE restarts the run.
 * - A3. Autoplay triggers after `run.autoTriggerIdleS` idle seconds and
 *   approves `run.autoApproveDelayS` after the gate opens, at any tick size.
 * - A4. A resize keeps the script time, decision, focus and overlay and
 *   clamps the scroll to the new body (state preserved, layout reflowed).
 * - A5. Charts view (`c`): the selected tile is always in 1..n; digits,
 *   Tab and the arrow keys select a tile (and scroll to it), `z`/Enter zoom.
 *   Leaving and re-entering the view keeps the selection.
 * - A7. `o` toggles the overview (every panel as a tile); a panel key
 *   (1-5, e, u) leaves it and shows that panel.
 * - A6. Scrubbing (`[` `]` one second, `{` `}` five seconds) pauses the run
 *   and moves the script time within [0, CHART_SPAN_S]; SPACE or `p` resume.
 */
import { type Decision, stateAt, TIMELINE } from "./scenario.ts"
import { DEFAULT_VIEW, frame, maxScroll, type Overlay, type Ui, type ViewOpts } from "./view.tsx"
import { clampTile, nextTile, prevTile, RUN_TILES } from "./charts/layout.ts"
import { CHART_SPAN_S } from "./charts/series.ts"

export interface App {
  readonly t: number // script time in seconds; < 0 = idle (not triggered)
  readonly speed: number // script seconds per wall second
  readonly paused: boolean
  readonly decision: Decision
  readonly ui: Ui
  readonly autoplay: boolean
  readonly idleS: number // wall seconds spent idle (for autoplay)
  readonly quit: boolean
  readonly viewport: { readonly cols: number; readonly rows: number }
  readonly view: ViewOpts
}

export const initial = (opts: { autoplay?: boolean; speed?: number; cols?: number; rows?: number; view?: ViewOpts; ui?: Partial<Ui> } = {}): App => ({
  t: -1,
  speed: opts.speed ?? 1,
  paused: false,
  decision: null,
  ui: { focus: 0, scroll: 0, overlay: null, tick: 0, chart: 1, zoom: false, ...opts.ui },
  autoplay: opts.autoplay ?? false,
  idleS: 0,
  quit: false,
  viewport: { cols: opts.cols ?? 120, rows: opts.rows ?? 40 },
  view: opts.view ?? DEFAULT_VIEW
})

export type Msg =
  | { readonly type: "tick"; readonly dtS: number }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const

const withUi = (app: App, ui: Partial<Ui>): App => ({ ...app, ui: { ...app.ui, ...ui } })

/** Body length, viewport height and panel anchors for the app's current state (overlays included). */
export const bodyMetrics = (app: App): { readonly length: number; readonly rows: number; readonly anchors: Readonly<Record<number, number>> } => {
  const f = frame(stateAt(app.t, app.decision), app.ui, app.viewport.cols, app.viewport.rows, app.view)
  return { length: f.bodyLength, rows: f.bodyRows, anchors: f.anchors }
}

const clampScroll = (app: App, scroll: number): App => {
  const m = bodyMetrics(app)
  return withUi(app, { scroll: Math.min(maxScroll(m.length, m.rows), Math.max(0, scroll)) })
}

const scrollBy = (app: App, d: number): App => clampScroll(app, app.ui.scroll + d)

/** Focus a panel (1–7) and scroll to it; a hidden panel becomes visible because the focused panel is chosen first (L3). */
const jump = (app: App, panel: number): App => {
  const focused = withUi(app, { focus: panel, overlay: null })
  const target = bodyMetrics(focused).anchors[panel] ?? 0
  return clampScroll(focused, Math.max(0, target))
}

const toggle = (app: App, o: Exclude<Overlay, null>): App => withUi(app, { overlay: app.ui.overlay === o ? null : o, scroll: 0 })

/** The review gate is open at `t` and no decision has been taken. */
export const reviewOpen = (app: App): boolean => app.t >= TIMELINE.review && app.decision === null

const decide = (app: App, kind: "approve" | "reject"): App => (reviewOpen(app) ? { ...app, decision: { kind, at: app.t } } : app)

const speedStep = (app: App, d: number): App => {
  const i = SPEEDS.indexOf(app.speed as (typeof SPEEDS)[number])
  return { ...app, speed: SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? SPEEDS.indexOf(1) : i) + d))]! }
}

/** A6: scrub seconds per key. */
export const SCRUB_S: Readonly<Record<string, number>> = { "[": -1, "]": 1, "{": -5, "}": 5 }

const scrub = (app: App, d: number): App => {
  const from = app.t < 0 ? 0 : app.t
  return clampScroll({ ...app, paused: true, idleS: 0, t: Math.max(0, Math.min(CHART_SPAN_S, Math.round(from + d))) }, app.ui.scroll)
}

/** A5: select a tile and scroll to it. */
const selectTile = (app: App, n: number): App => {
  const chart = clampTile(n, RUN_TILES.length)
  const selected = withUi(app, { chart })
  if (app.ui.zoom === true) return withUi(selected, { scroll: 0 })
  const target = bodyMetrics(selected).anchors[chart as 1 | 2 | 3 | 4 | 5 | 6] ?? 0
  return clampScroll(selected, Math.max(0, target))
}

/** Keys of the charts view; null = not a charts key (falls through to the dashboard's keys). */
const onChartsKey = (app: App, key: string): App | null => {
  const sel = clampTile(app.ui.chart ?? 1, RUN_TILES.length)
  if (/^[1-9]$/.test(key) && Number(key) <= RUN_TILES.length) return selectTile(app, Number(key))
  switch (key) {
    case "\t":
    case "\x1b[C":
    case "l":
      return selectTile(app, nextTile(sel, RUN_TILES.length))
    case "\x1b[D":
      return selectTile(app, prevTile(sel, RUN_TILES.length))
    case "z":
    case "\r":
      return withUi(app, { zoom: app.ui.zoom !== true, scroll: 0 })
    case "\x1b":
      return withUi(app, { overlay: null, zoom: false, scroll: 0 })
    default:
      return null
  }
}

export const onKey = (app: App, key: string): App => {
  if (SCRUB_S[key] !== undefined) return scrub(app, SCRUB_S[key])
  if (app.ui.overlay === "charts") {
    const next = onChartsKey(app, key)
    if (next !== null) return next
  }
  switch (key) {
    case "c":
      return withUi(app, { overlay: app.ui.overlay === "charts" ? null : "charts", scroll: 0, chart: clampTile(app.ui.chart ?? 1, RUN_TILES.length) })
    case " ":
      return clampScroll({ ...app, t: 0, decision: null, idleS: 0 }, app.ui.scroll)
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return jump(app, Number(key))
    case "6":
    case "e":
      return jump(app, 6)
    case "7":
    case "u":
      return jump(app, 7)
    case "o":
      return toggle(app, "overview")
    case "a":
      return decide(app, "approve")
    case "r":
      return decide(app, "reject")
    case "w":
      return toggle(app, "git")
    case "n":
      return toggle(app, "notes")
    case "h":
    case "?":
      return toggle(app, "help")
    case "j":
    case "\x1b[B":
      return scrollBy(app, 1)
    case "k":
    case "\x1b[A":
      return scrollBy(app, -1)
    case "\x1b[6~":
    case "f":
      return scrollBy(app, Math.max(1, bodyMetrics(app).rows - 1))
    case "\x1b[5~":
    case "b":
      return scrollBy(app, -Math.max(1, bodyMetrics(app).rows - 1))
    case "g":
      return withUi(app, { scroll: 0 })
    case "G":
      return scrollBy(app, Number.MAX_SAFE_INTEGER / 2)
    case "+":
      return speedStep(app, 1)
    case "-":
      return speedStep(app, -1)
    case "p":
      return { ...app, paused: !app.paused }
    case "\x1b":
      return clampScroll(withUi(app, { overlay: null, focus: 0 }), app.ui.scroll)
    case "q":
    case "\x11":
    case "\x03":
      return { ...app, quit: true }
    default:
      return app
  }
}

/** Advance the clocks (A3); the body may change length over time, so a non-zero scroll is clamped again (A1). */
export const onTick = (app: App, dtS: number): App => {
  const next = advance(app, dtS)
  return next.ui.scroll > 0 ? clampScroll(next, next.ui.scroll) : next
}

const advance = (app: App, dtS: number): App => {
  const ui = { ...app.ui, tick: app.ui.tick + 1 }
  if (app.paused) return { ...app, ui }
  if (app.t < 0) {
    const idleS = app.idleS + dtS
    return app.autoplay && idleS >= TIMELINE.autoTriggerIdle ? { ...app, ui, idleS: 0, t: 0 } : { ...app, ui, idleS }
  }
  const t = app.t + dtS * app.speed
  const next = { ...app, ui, t }
  const approveAt = TIMELINE.review + TIMELINE.autoApproveDelay
  return app.autoplay && next.decision === null && t >= approveAt ? { ...next, decision: { kind: "approve", at: approveAt } } : next
}

/** A4: keep everything but the viewport; clamp the scroll to the new body. */
export const onResize = (app: App, cols: number, rows: number): App => clampScroll({ ...app, viewport: { cols, rows } }, app.ui.scroll)

export const update = (app: App, msg: Msg): App =>
  msg.type === "tick" ? onTick(app, msg.dtS) : msg.type === "key" ? onKey(app, msg.key) : onResize(app, msg.cols, msg.rows)
