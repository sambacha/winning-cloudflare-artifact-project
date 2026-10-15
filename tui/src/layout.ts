/**
 * Layout constants: widths, paddings, breakpoints and panel declarations.
 * These are the only numbers the panel components use (besides 0 and 1),
 * and none of them is a figure of the demo's data.
 */

/** Breakpoints (Phase 1 of the critique): the largest one that fits the terminal is used. */
export interface Breakpoint {
  readonly name: "minimal" | "standard" | "wide" | "full"
  readonly cols: number
  readonly rows: number
  /** Header rows: 1 = one-line title+status, 3 = title, rule, status; the logo adds its own rows. */
  readonly headerRows: number
  readonly logo: boolean
  /** Footer rows (controls). */
  readonly footerRows: number
  /** At most this many panels at once (`Infinity`: as many as fit by `minHeight`). */
  readonly maxPanels: number
  /** Show every panel (the body scrolls), regardless of `minHeight`. */
  readonly allPanels: boolean
  /**
   * Rows of the permanent SIMULATED ACTIONS strip (borders included). It sits
   * between the body and the footer in every view (panels, overview, charts,
   * overlays) and never scrolls.
   */
  readonly actionRows: number
}

export const BREAKPOINTS: ReadonlyArray<Breakpoint> = [
  { name: "minimal", cols: 80, rows: 24, headerRows: 1, logo: false, footerRows: 1, maxPanels: 1, allPanels: false, actionRows: 5 },
  { name: "standard", cols: 120, rows: 40, headerRows: 3, logo: false, footerRows: 2, maxPanels: Infinity, allPanels: false, actionRows: 7 },
  { name: "wide", cols: 160, rows: 50, headerRows: 3, logo: true, footerRows: 2, maxPanels: Infinity, allPanels: false, actionRows: 8 },
  { name: "full", cols: 200, rows: 60, headerRows: 3, logo: true, footerRows: 2, maxPanels: Infinity, allPanels: true, actionRows: 10 }
]

export type PanelId = 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * Panel declarations. `minHeight`: rows the panel needs to show its title
 * and essential rows (the rest of it is reached by scrolling). `priority`:
 * 1 is shown first; panels are dropped from the highest number down.
 */
export interface PanelDecl {
  readonly id: PanelId
  readonly name: string
  readonly key: string
  readonly minHeight: number
  readonly priority: number
}

export const PANELS: ReadonlyArray<PanelDecl> = [
  { id: 2, name: "R2 lease locks", key: "2", minHeight: 12, priority: 1 },
  { id: 6, name: "Event stream", key: "e", minHeight: 8, priority: 2 },
  { id: 1, name: "Artifacts forks", key: "1", minHeight: 10, priority: 3 },
  { id: 5, name: "Cost savings", key: "5", minHeight: 12, priority: 4 },
  { id: 3, name: "R2 build cache", key: "3", minHeight: 10, priority: 5 },
  { id: 4, name: "Lean 4 CI metrics", key: "4", minHeight: 12, priority: 6 },
  { id: 7, name: "Cloudflare URIs", key: "u", minHeight: 10, priority: 7 }
]

/** Canonical order of the panels in the body. */
export const PANEL_ORDER: ReadonlyArray<PanelId> = [1, 2, 3, 4, 5, 6, 7]

/** Two panels side by side need at least this inner width; below it they stack. */
export const PAIR_MIN_WIDTH = 116
export const GAP = 2
/** Columns of a side-by-side pair. */
export const PAIR = 2

export const W = {
  label: 10, // "holder: " style labels
  field: 11, // "│  status: " tree labels of the forks panel
  cell: 10, // table cells
  wideCell: 12,
  nameCell: 18,
  bar: 30, // PhaseBar width (the brief's 30-cell bar)
  minBar: 8,
  barReserve: 30, // columns kept for text next to a bar
  costLabel: 18,
  costCell: 11,
  digest: 12, // characters of a digest shown after the prefix
  costBarReserve: 16,
  events: 15, // event lines shown
  pct: 6, // "100% "
  lockInset: 4, // a lock card inside the locks panel (border + padding)
  kind: 8, // event kind column
  clock: 9, // "12:04:31 "
  ellipsis: 1,
  manifestHash: 4, // characters of the manifest hash shown
  noteFigure: 32,
  noteValue: 18,
  noteVerdict: 21,
  helpKey: 24,
  phaseLabel: 14,
  liveOid: 12 // characters of a live commit id shown
} as const

/** Events: a line is highlighted for this many seconds after it happened. */
export const FRESH_S = 1
/** Countdowns turn red below this many seconds. */
export const URGENT_S = 10
/** Animation: ticks per second of the UI clock, and blink periods in ticks. */
export const TICKS_PER_S = 10
export const BLINK_TICKS = 10
/** Ticks of each blink period during which the blinking glyph is "on". */
export const BLINK_ON_TICKS = 6

/** Decimal places used where the default of the unit is not precise enough. */
export const DIGITS = {
  price: 3, // unit prices such as $0.015
  perRun: 4, // Cobuilds per-run items are fractions of a cent
  cents: 2
} as const

/** Longest horizontal rule drawn (it is cut to the free space of its row). */
export const RULE_MAX = 400

/**
 * Overview layout (key `o`): every panel as a compact tile, three tiles per
 * row when the inner width allows (two, then one, below that). Base heights
 * of the three tile rows, borders included; the rows grow evenly when the
 * body is taller than their sum.
 */
export const OVERVIEW = {
  rowHeights: [10, 7, 7],
  threeColumns: 132,
  twoColumns: 88,
  gap: 2,
  /** Rows of a compact tile that are not content: top border, title, bottom border. */
  chrome: 3,
  /** Columns of a compact tile used by its border and padding. */
  inset: 4,
  bar: 10,
  label: 16,
  /** Label column of the monthly-cost bars, and the columns kept for their values. */
  costLabel: 14,
  costValue: 17,
  /** Channel column of the URI tile ("R2", "ART"). */
  tag: 4,
  agent: 12,
  fork: 9,
  status: 10,
  pct: 5
} as const

/** The SIMULATED ACTIONS strip: column widths. */
export const ACTIONS = {
  /** Rows of the strip that are not content: top border, title, bottom border. */
  chrome: 3,
  /** Below this inner width the strip shows only the action log (no task column). */
  splitMin: 100,
  /** Share of the inner width given to the task column. */
  taskShare: 0.36,
  /** Columns of the strip used by its border and padding. */
  inset: 4,
  gap: 2,
  channel: 10,
  verb: 6,
  /** Verb column when verbs such as CHECKOUT occur (clean scenario). */
  longVerb: 9,
  agent: 12,
  fork: 9,
  bar: 10,
  status: 9,
  pct: 5
} as const

/** Order of the URI rows in the compact overview tile (lower first). */
export const URI_RANK = { primary: 0, fork: 1, manifest: 2, lock: 3, other: 4 } as const
