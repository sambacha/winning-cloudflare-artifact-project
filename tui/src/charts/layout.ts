/**
 * Layout of the charts view: tile declarations, sizes and keys. These are
 * the only numbers the chart components use (besides 0 and 1; lint rule N1).
 *
 * Requirements (stated without reference to any test):
 * - K1. Tiles are numbered 1..n in reading order; `nextTile`/`prevTile`
 *   cycle through them and `clampTile` maps anything else into range.
 * - K2. `tileRows` gives every tile at least `CH.minPlotRows` plot rows; the
 *   body scrolls when the tiles do not fit (the frame stays exact).
 * - K3. A zoomed tile takes the whole body: its plot gets every body row
 *   that the tile's chrome does not use (and at least `CH.minPlotRows`).
 */

export interface TileDecl {
  readonly id: number
  readonly title: string
  /** One line saying what the chart shows (shown in the zoomed tile). */
  readonly about: string
}

/** Tile numbers of the run's charts (the keys that select them). */
export const RUN_TILE = { timeline: 1, cost: 2, progress: 3, activity: 4, monthly: 5, algorithms: 6 } as const

/** Tile numbers of the clean run's charts. */
export const CLEAN_TILE = { confidence: 1, probes: 2, cache: 3, cost: 4 } as const

/** Charts of the cobuild run (default scenario). */
export const RUN_TILES: ReadonlyArray<TileDecl> = [
  { id: 1, title: "LEASE TIMELINE", about: "who holds each R2 lease lock over script time; the crash and the takeover are marked" },
  { id: 2, title: "CUMULATIVE CI COST", about: "Cobuilds cost so far against the GitHub Actions equivalent of the same work" },
  { id: 3, title: "BUILD & AUDIT PROGRESS", about: "mean lock progress and the share of the axiom audit done, in percent" },
  { id: 4, title: "ACTIVITY", about: "events per bucket (bars) and conditional R2 writes per bucket (sparkline)" },
  { id: 5, title: "MONTHLY COST", about: "CI cost per month at the stated run volume, GitHub Actions against Cobuilds" },
  { id: 6, title: "AXIOM AUDIT ALGORITHMS", about: "audit time per algorithm on a log scale, with the speedup over the first" }
]

/** Charts of the clean build-pipeline run (`--scenario clean`). */
export const CLEAN_TILES: ReadonlyArray<TileDecl> = [
  { id: 1, title: "BISECT CONFIDENCE", about: "posterior confidence of the culprit and the remaining entropy after each observation" },
  { id: 2, title: "BISECT PROBES", about: "the commit probed at each observation (pass or fail) and the culprit guess after it" },
  { id: 3, title: "CACHE EFFECT", about: "dependency restore against a cold install, and build-cache hits against misses" },
  { id: 4, title: "COST PER RUN", about: "cost of one run, GitHub Actions against Cobuilds" }
]

export const CH = {
  /** Width of the y-axis labels. */
  axis: 10,
  /** Columns between the y labels and the plot: a space and the axis line. */
  axisGap: 2,
  /** Rows of a tile that are not plot: borders, title, legend, x axis, x labels. */
  tileChrome: 6,
  /** Rows of a bar-chart tile that are not bars: borders, title, legend. */
  barChrome: 4,
  minPlotRows: 4,
  minPlotCols: 12,
  /** Inner columns of a tile used by its border and padding. */
  tileInset: 4,
  /** Tile rows of the clean scenario's charts panel. */
  cleanGridRows: 2,
  /** Tile rows of the grid when tiles sit side by side. */
  gridRows: 3,
  /** Legend rows of the timeline beyond the usual one. */
  legendRows: 1,
  /** Lanes taller than this many rows end with a blank separator row. */
  laneGapFrom: 2,
  /** Width of the lane labels of the timeline. */
  laneLabel: 16,
  /** Width of the bar labels of the bar charts. */
  barLabel: 24,
  /** Columns kept for the value after a bar. */
  barValue: 18,
  /** Columns kept for a speedup after the value. */
  speedup: 10,
  /** Rows of the zoomed tile's extra text (what the chart shows, and the keys). */
  zoomText: 2,
  /** Decimal places of USD axis labels and of time labels. */
  usdDigits: 2,
  /** Decimal places of a cost that is a fraction of a cent per second. */
  usdFine: 4,
  timeDigits: 0
} as const

/** K1. */
export const clampTile = (n: number, tiles: number): number => (tiles <= 0 ? 0 : Number.isInteger(n) && n >= 1 && n <= tiles ? n : 1)
export const nextTile = (n: number, tiles: number): number => (tiles <= 0 ? 0 : (clampTile(n, tiles) % tiles) + 1)
export const prevTile = (n: number, tiles: number): number => (tiles <= 0 ? 0 : ((clampTile(n, tiles) + tiles - 2) % tiles) + 1)

/** K2: rows of one tile in the grid for a body of `bodyRows` rows; `paired` = two tiles per row. */
export const tileRows = (bodyRows: number, tiles: number, paired: boolean): number => {
  const perColumn = paired ? Math.ceil(tiles / 2) : tiles
  const rows = Math.min(perColumn, CH.gridRows)
  return Math.max(CH.minPlotRows + CH.tileChrome, Math.floor(bodyRows / Math.max(1, rows)))
}

/** Plot rows of a chart tile `rows` high (K2/K3); a zoomed tile also shows `CH.zoomText` rows of text. */
export const plotRows = (rows: number, zoomed = false): number => Math.max(CH.minPlotRows, rows - CH.tileChrome - (zoomed ? CH.zoomText : 0))

/** K3: rows of the zoomed tile (all of the body). */
export const zoomRows = (bodyRows: number): number => Math.max(CH.minPlotRows + CH.tileChrome + CH.zoomText, bodyRows)

/** Rows per lane of the timeline: lanes share the plot rows (at least one each). */
export const laneRows = (plot: number, lanes: number): number => Math.max(1, Math.floor(plot / Math.max(1, lanes)))

/** Plot columns of a tile `width` wide with a y axis. */
export const plotCols = (width: number): number => Math.max(CH.minPlotCols, width - CH.tileInset - CH.axis - CH.axisGap)
