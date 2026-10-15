/**
 * The dashboard as a pure function: `frame(state, ui, cols, rows, opts)`
 * returns exactly `rows` lines of exactly `cols` display columns.
 *
 * Layout rules (Phase 1 of the critique):
 * - L1. The breakpoint is the largest of `BREAKPOINTS` that fits the
 *   terminal (minimal 80×24, standard 120×40, wide 160×50, full 200×60);
 *   below 80×24 a "too small" message is shown.
 * - L2. Header and footer are fixed; the body between them scrolls; the
 *   footer is never pushed off the screen.
 * - L3. Panels are chosen by priority: the focused panel first, then by
 *   `priority`, while the sum of their `minHeight` fits the body (and at most
 *   `maxPanels`); at least one panel is shown; `full` shows all. Hidden
 *   panels are announced as "+N panels (press 1-5, e, u)".
 * - L4. Visible panels appear in the canonical order; forks and locks sit
 *   side by side when the width allows.
 * - L5. The SIMULATED ACTIONS strip (`bp.actionRows` rows) is drawn between
 *   the body and the footer in every view; it never scrolls.
 * - L6. The overview (overlay "overview", key `o`) shows every panel as a
 *   compact tile: three tiles per row from `OVERVIEW.threeColumns` inner
 *   columns, two from `OVERVIEW.twoColumns`, one below that.
 */
import { type Line, center, fit, s } from "./ansi.ts"
import { INPUTS } from "./data.ts"
import { count, dataNotes, der, type Derived } from "./derive.ts"
import { type InkNode, renderToLines } from "./ink/index.ts"
import { BREAKPOINTS, type Breakpoint, OVERVIEW, PAIR, PAIR_MIN_WIDTH, PANEL_ORDER, PANELS, type PanelId } from "./layout.ts"
import { LOGO_ROWS } from "./logo.ts"
import { CachePanel } from "./panels/CachePanel.tsx"
import { Footer, Header } from "./panels/Chrome.tsx"
import { Pair } from "./panels/common.tsx"
import { CostSavingsPanel } from "./panels/CostSavingsPanel.tsx"
import { EventStream } from "./panels/EventStream.tsx"
import { ForksPanel } from "./panels/ForksPanel.tsx"
import { Lean4MetricsPanel } from "./panels/Lean4MetricsPanel.tsx"
import { LocksPanel } from "./panels/LocksPanel.tsx"
import { GitOverlay, HelpOverlay, NotesOverlay } from "./panels/Overlays.tsx"
import { ActionsPanel } from "./panels/ActionsPanel.tsx"
import { UrisPanel } from "./panels/UrisPanel.tsx"
import { CacheTile, EventsTile, ForksTile, LeanTile, LocksTile, MonthlyTile, PerRunTile, type TileProps, UrisTile } from "./panels/Overview.tsx"
import { RunChartTile } from "./panels/ChartsView.tsx"
import { clampTile, RUN_TILE, RUN_TILES, tileRows, zoomRows } from "./charts/layout.ts"
import type { PanelProps } from "./panels/props.ts"
import { FIGURES, SCENARIO, type State } from "./scenario.ts"
import { C, T } from "./theme.ts"

export type Overlay = null | "git" | "notes" | "help" | "charts" | "overview"

export interface Ui {
  readonly focus: number // 0 = none, 1..7 = panel (6 = events, 7 = URIs)
  readonly scroll: number
  readonly overlay: Overlay
  readonly tick: number // animation counter (TICKS_PER_S per second)
  /** Charts view: the selected tile (1..6; 0 or absent = the first). */
  readonly chart?: number
  /** Charts view: the selected tile fills the body. */
  readonly zoom?: boolean
}

export interface ViewOpts {
  readonly seed: number
  /** Motion policy (blinking). */
  readonly anim: boolean
}

export const DEFAULT_VIEW: ViewOpts = { seed: 1, anim: true }

export const MIN_COLS = BREAKPOINTS[0]!.cols
export const MIN_ROWS = BREAKPOINTS[0]!.rows

/** L1: the largest breakpoint that fits, or null if the terminal is too small. */
export const breakpointFor = (cols: number, rows: number): Breakpoint | null => {
  const fits = BREAKPOINTS.filter((b) => cols >= b.cols && rows >= b.rows)
  return fits.length === 0 ? null : fits[fits.length - 1]!
}

/** Rows of the frame that are not body: borders, header (with logo), two rules, the actions strip, footer. */
export const chromeRows = (bp: Breakpoint): number => 2 + bp.headerRows + (bp.logo ? LOGO_ROWS : 0) + 2 + bp.actionRows + bp.footerRows

export interface Viewport {
  readonly bp: Breakpoint
  readonly innerWidth: number
  readonly bodyRows: number
}

export const viewportFor = (cols: number, rows: number): Viewport | null => {
  const bp = breakpointFor(cols, rows)
  return bp === null ? null : { bp, innerWidth: cols - 2, bodyRows: rows - chromeRows(bp) }
}

/** L3: visible panels (canonical order) and hidden ones, for a focus and a body height. */
export const choosePanels = (bp: Breakpoint, bodyRows: number, focus: number): { readonly visible: PanelId[]; readonly hidden: PanelId[] } => {
  if (bp.allPanels) return { visible: [...PANEL_ORDER], hidden: [] }
  const byPriority = [...PANELS].sort((a, b) => a.priority - b.priority)
  const focused = byPriority.find((p) => p.id === focus)
  const order = focused === undefined ? byPriority : [focused, ...byPriority.filter((p) => p !== focused)]
  const chosen: PanelId[] = []
  let used = 0
  for (const p of order) {
    if (chosen.length >= bp.maxPanels) break
    if (chosen.length > 0 && used + p.minHeight > bodyRows) break
    chosen.push(p.id)
    used += p.minHeight
  }
  return { visible: PANEL_ORDER.filter((id) => chosen.includes(id)), hidden: PANEL_ORDER.filter((id) => !chosen.includes(id)) }
}

export interface Body {
  readonly lines: ReadonlyArray<Line>
  /** Line index of each visible panel (by panel id; -1 if hidden). */
  readonly anchors: Readonly<Record<PanelId, number>>
  readonly visible: ReadonlyArray<PanelId>
  readonly hidden: ReadonlyArray<PanelId>
}

const NO_ANCHORS: Readonly<Record<PanelId, number>> = { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1, 6: -1, 7: -1 }

/** The body: visible panels, laid out at the inner width `iw`. */
export const body = (st: State, ui: Ui, vp: Viewport, opts: ViewOpts = DEFAULT_VIEW): Body => {
  const { visible, hidden } = choosePanels(vp.bp, vp.bodyRows, ui.focus)
  const iw = vp.innerWidth
  const props = (id: PanelId, width: number): PanelProps => ({ state: st, fig: FIGURES, inputs: INPUTS, width, focused: ui.focus === id, tick: ui.tick, anim: opts.anim })
  const one = (id: PanelId, width: number) => {
    switch (id) {
      case 1:
        return <ForksPanel {...props(1, width)} />
      case 2:
        return <LocksPanel {...props(2, width)} />
      case 3:
        return <CachePanel {...props(3, width)} />
      case 4:
        return <Lean4MetricsPanel {...props(4, width)} />
      case 5:
        return <CostSavingsPanel {...props(5, width)} />
      case 6:
        return <EventStream {...props(6, width)} clock={SCENARIO.clock} />
      case 7:
        return <UrisPanel {...props(7, width)} />
    }
  }
  const lines: Line[] = []
  const anchors: Record<PanelId, number> = { ...NO_ANCHORS }
  const both = visible.includes(1) && visible.includes(2)
  for (const id of visible) {
    if (both && id === 2) continue
    anchors[id] = lines.length
    if (both && id === 1) {
      anchors[2] = lines.length
      lines.push(...renderToLines(<Pair width={iw} left={(w) => one(1, w)} right={(w) => one(2, w)} />, iw))
    } else {
      lines.push(...renderToLines(one(id, iw), iw))
    }
  }
  return { lines, anchors, visible, hidden }
}

/**
 * The charts view (overlay "charts"): the six chart tiles, two per row when
 * the width allows, or only the selected tile when zoomed. Anchors are the
 * first line of each tile (by tile number), so selecting a tile can scroll to it.
 */
export const chartsBody = (st: State, ui: Ui, vp: Viewport, opts: ViewOpts = DEFAULT_VIEW): Body => {
  const iw = vp.innerWidth
  const sel = clampTile(ui.chart ?? 1, RUN_TILES.length)
  const tile = (id: number, width: number, rows: number, zoomed: boolean) => (
    <RunChartTile id={id} rows={rows} zoomed={zoomed} state={st} fig={FIGURES} inputs={INPUTS} width={width} focused={id === sel} tick={ui.tick} anim={opts.anim} />
  )
  const anchors: Record<PanelId, number> = { ...NO_ANCHORS }
  if (ui.zoom === true) {
    anchors[sel as PanelId] = 0
    return { lines: renderToLines(tile(sel, iw, zoomRows(vp.bodyRows), true), iw), anchors, visible: [], hidden: [] }
  }
  const paired = iw >= PAIR_MIN_WIDTH
  const rows = tileRows(vp.bodyRows, RUN_TILES.length, paired)
  const lines: Line[] = []
  const ids = RUN_TILES.map((t) => t.id)
  const step = paired ? PAIR : 1
  for (let i = 0; i < ids.length; i += step) {
    const group = ids.slice(i, i + step)
    for (const id of group) anchors[id as PanelId] = lines.length
    lines.push(
      ...renderToLines(
        group.length === PAIR ? <Pair width={iw} left={(w) => tile(group[0]!, w, rows, false)} right={(w) => tile(group[1]!, w, rows, false)} /> : tile(group[0]!, iw, rows, false),
        iw
      )
    )
  }
  return { lines, anchors, visible: [], hidden: [] }
}

/** Lines placed side by side, each cut or padded to its width, `gap` columns apart. */
const sideBySide = (cols: ReadonlyArray<ReadonlyArray<Line>>, widths: ReadonlyArray<number>, gap: number, rows: number): Line[] =>
  Array.from({ length: rows }, (_, i): Line => cols.flatMap((c, j) => [...(j === 0 ? [] : [s(" ".repeat(gap))]), ...fit(c[i] ?? [], widths[j]!)]))

/** Tiles of the overview, in reading order, with the tile row (0, 1, 2) each belongs to. */
const OVERVIEW_TILES: ReadonlyArray<{ readonly row: number; readonly id: PanelId | null; readonly tile: ((p: TileProps) => InkNode) | null }> = [
  { row: 0, id: 5, tile: MonthlyTile },
  { row: 0, id: 5, tile: PerRunTile },
  { row: 0, id: null, tile: null },
  { row: 1, id: 2, tile: LocksTile },
  { row: 1, id: 1, tile: ForksTile },
  { row: 1, id: 7, tile: UrisTile },
  { row: 2, id: 6, tile: EventsTile },
  { row: 2, id: 3, tile: CacheTile },
  { row: 2, id: 4, tile: LeanTile }
]

/**
 * L6: the overview body. The third tile of the first row is the BUILD & AUDIT
 * PROGRESS chart. Tile row heights are `OVERVIEW.rowHeights`, grown evenly to
 * fill a taller body; with fewer columns the tiles flow in the same order.
 */
export const overviewBody = (st: State, ui: Ui, vp: Viewport, opts: ViewOpts = DEFAULT_VIEW): Body => {
  const iw = vp.innerWidth
  const ncols = iw >= OVERVIEW.threeColumns ? 3 : iw >= OVERVIEW.twoColumns ? 2 : 1
  const base = OVERVIEW.rowHeights
  const total = base.reduce((a, b) => a + b, 0)
  const extra = ncols === 3 ? Math.max(0, Math.floor((vp.bodyRows - total) / base.length)) : 0
  const heights = base.map((h) => h + extra)
  const widths = Array.from({ length: ncols }, (_, j) => Math.floor((iw - OVERVIEW.gap * (ncols - 1)) / ncols) + (j < (iw - OVERVIEW.gap * (ncols - 1)) % ncols ? 1 : 0))
  const render = (k: number, width: number, rows: number): Line[] => {
    const d = OVERVIEW_TILES[k]!
    const tp: TileProps = { state: st, fig: FIGURES, inputs: INPUTS, width, focused: false, tick: ui.tick, anim: opts.anim, rows: rows - OVERVIEW.chrome, clock: SCENARIO.clock }
    const node =
      d.tile === null ? (
        <RunChartTile id={RUN_TILE.progress} rows={rows} zoomed={false} state={st} fig={FIGURES} inputs={INPUTS} width={width} focused={false} tick={ui.tick} anim={opts.anim} />
      ) : (
        d.tile(tp)
      )
    const lines = renderToLines(node, width)
    return Array.from({ length: rows }, (_, i) => lines[i] ?? [])
  }
  const lines: Line[] = []
  const anchors: Record<PanelId, number> = { ...NO_ANCHORS }
  for (let k = 0; k < OVERVIEW_TILES.length; k += ncols) {
    const group = OVERVIEW_TILES.slice(k, k + ncols).map((_, j) => k + j)
    const rows = Math.max(...group.map((g) => heights[OVERVIEW_TILES[g]!.row]!))
    for (const g of group) {
      const id = OVERVIEW_TILES[g]!.id
      if (id !== null && anchors[id] < 0) anchors[id] = lines.length
    }
    lines.push(...sideBySide(group.map((g, j) => render(g, widths[j]!, rows)), widths, OVERVIEW.gap, rows))
  }
  return { lines, anchors, visible: [], hidden: [] }
}

/** Largest valid scroll offset for a body of `n` lines in a viewport of `h` rows. */
export const maxScroll = (n: number, h: number): number => Math.max(0, n - h)

export interface Frame {
  readonly lines: ReadonlyArray<Line>
  readonly bodyLength: number
  readonly bodyRows: number
  readonly anchors: Readonly<Record<PanelId, number>>
  readonly scroll: number // the clamped scroll actually used
  readonly breakpoint: Breakpoint | null
  readonly visible: ReadonlyArray<PanelId>
  readonly hidden: ReadonlyArray<PanelId>
}

const lineCount = (n: number): Derived => der(n, "lines", "body line index", ["layout"])

/** The full screen: exactly `rows` lines of exactly `cols` columns. */
export const frame = (st: State, ui: Ui, cols: number, rows: number, opts: ViewOpts = DEFAULT_VIEW): Frame => {
  const vp = viewportFor(cols, rows)
  if (vp === null) {
    const msg: Line = [s(`Terminal ${cols}×${rows} is too small: need at least ${MIN_COLS}×${MIN_ROWS}.`, T.warnB)]
    const lines = Array.from({ length: Math.max(0, rows) }, (_, i): Line => fit(i === Math.floor(rows / 2) ? center(msg, cols) : [], cols))
    return { lines, bodyLength: 0, bodyRows: 0, anchors: NO_ANCHORS, scroll: 0, breakpoint: null, visible: [], hidden: [] }
  }
  const { bp, innerWidth: iw, bodyRows } = vp
  const frameStyle = { fg: C.cyan, dim: true }
  const wrap = (l: Line): Line => [s("║", frameStyle), ...fit(l, iw), s("║", frameStyle)]
  const rule: Line = [s("╠" + "═".repeat(iw) + "╣", frameStyle)]
  const head = renderToLines(
    <Header
      state={st}
      inputs={INPUTS}
      clock={SCENARIO.clock}
      constants={FIGURES.project.constants}
      seed={opts.seed}
      tick={ui.tick}
      anim={opts.anim}
      compact={bp.headerRows === 1}
      logo={bp.logo}
      width={iw}
    />,
    iw
  )
  const b: Body =
    ui.overlay === null
      ? body(st, ui, vp, opts)
      : ui.overlay === "charts"
        ? chartsBody(st, ui, vp, opts)
        : ui.overlay === "overview"
          ? overviewBody(st, ui, vp, opts)
          : {
          lines: renderToLines(
            ui.overlay === "git" ? <GitOverlay state={st} width={iw} /> : ui.overlay === "notes" ? <NotesOverlay notes={dataNotes(INPUTS, FIGURES)} width={iw} /> : <HelpOverlay width={iw} />,
            iw
          ),
          anchors: NO_ANCHORS,
          visible: [],
          hidden: []
        }
  const scroll = Math.min(Math.max(0, ui.scroll), maxScroll(b.lines.length, bodyRows))
  const visibleLines = b.lines.slice(scroll, scroll + bodyRows)
  const foot = renderToLines(
    <Footer
      state={st}
      tick={ui.tick}
      anim={opts.anim}
      compact={bp.footerRows === 1}
      width={iw}
      charts={ui.overlay === "charts"}
      hidden={b.hidden.length === 0 ? null : count(b.hidden.length, "panels", "panels that do not fit the body (L3)")}
      scroll={b.lines.length > bodyRows ? { from: lineCount(scroll + 1), to: lineCount(scroll + visibleLines.length), total: lineCount(b.lines.length) } : null}
    />,
    iw
  )
  const strip = renderToLines(<ActionsPanel state={st} width={iw} rows={bp.actionRows} clock={SCENARIO.clock} />, iw)
  const lines: Line[] = [
    [s("╔" + "═".repeat(iw) + "╗", frameStyle)],
    ...Array.from({ length: bp.headerRows + (bp.logo ? LOGO_ROWS : 0) }, (_, i) => wrap(head[i] ?? [])),
    rule,
    ...Array.from({ length: bodyRows }, (_, i) => wrap(visibleLines[i] ?? [])),
    ...Array.from({ length: bp.actionRows }, (_, i) => wrap(strip[i] ?? [])),
    rule,
    ...Array.from({ length: bp.footerRows }, (_, i) => wrap(foot[i] ?? [])),
    [s("╚" + "═".repeat(iw) + "╝", frameStyle)]
  ].map((l) => fit(l, cols))
  return { lines, bodyLength: b.lines.length, bodyRows, anchors: b.anchors, scroll, breakpoint: bp, visible: b.visible, hidden: b.hidden }
}
