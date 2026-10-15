/**
 * Layout constants of the clean scenario (the panel components contain no
 * numeric literal except 0 and 1; lint rule N1).
 */
export const CW = {
  label: 14, // "lockfile:    " style labels
  kind: 9, // event kind column
  clock: 10, // "T+22.0 s " column
  actionClock: 12, // "at 22.0 s " column of the actions strip
  agent: 14,
  op: 16,
  state: 10,
  ttl: 9,
  bar: 24, // confidence bar cells
  pairMin: 76 // below this inner width the two-column rows stack
} as const

/** Rows of a bordered panel that are not content: top border, title, bottom border. */
export const PANEL_CHROME_ROWS = 3

/** Frame rows that are not body: top border, header, rule, rule, footer, bottom border. */
export const FRAME_CHROME_ROWS = 6

/** Smallest terminal the clean scenario draws in (the minimal breakpoint). */
export const CLEAN_MIN = { cols: 80, rows: 24 } as const

/** The start screen reveals one logo row per this many milliseconds (deterministic in script time). */
export const LOGO_ROW_MS = 250

/** Milliseconds per second. */
export const MS_PER_S = 1000

/** The SIMULATED ACTIONS strip: its rows, and the smallest terminal height that shows it. */
export const CLEAN_STRIP = { rows: 6, minRows: 36 } as const

/** Rows of the strip at a terminal height (0 = no strip; small terminals keep every row for the panel). */
export const cleanStripRows = (rows: number): number => (rows >= CLEAN_STRIP.minRows ? CLEAN_STRIP.rows : 0)
