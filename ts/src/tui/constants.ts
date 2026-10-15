/**
 * Every number the dashboard's layout and derivations use. Panel code
 * (`rows.ts`, `ink/*.tsx`) contains no numeric literal other than 0 and 1;
 * figures shown to the user come from `derive.ts`, which reads its factors
 * from here.
 */

/** Cells of a PhaseBar (the brief's 30-cell bar). */
export const BAR_CELLS = 30

/** Terminal sizes the dashboard is laid out and tested for. */
export const SUPPORTED_SIZES = [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 200, rows: 60 }
] as const

/** Layout: one header row, one footer row; grid shapes by size class. */
export const LAYOUT = {
  headerRows: 1,
  footerRows: 1,
  /** Medium grid from 120x40, large grid from 200x60. */
  medium: { minCols: 120, minRows: 40, gridCols: 2, gridRows: 3 },
  large: { minCols: 200, minRows: 60, gridCols: 3, gridRows: 2 },
  /** Small terminals: the focused panel, then this many rows for the event stream (borders included). */
  smallEventRows: 8,
  /** Box border: one cell on each side. */
  border: 2
} as const

/** Column widths inside panels (cells). */
export const COL = {
  sha: 7,
  label: 12,
  num: 9,
  wideNum: 11,
  repo: 16,
  owner: 12,
  status: 9,
  key: 8,
  op: 10,
  platform: 10,
  clock: 8,
  kind: 7,
  pulse: 1,
  gap: 1
} as const

/** Unit factors. */
export const MS_PER_SECOND = 1000
export const SECONDS_PER_MINUTE = 60
export const MINUTES_PER_HOUR = 60
export const HOURS_PER_DAY = 24
export const BYTES_PER_KIB = 1024
export const PERCENT = 100
export const LN2 = Math.LN2

/** Decimal places of displayed figures. */
export const DECIMALS = { seconds: 1, percent: 1, bits: 2, usd: 4, bytes: 1, probability: 1 } as const

/**
 * Prices used by the cost panel (USD). Public list prices as given in the
 * task text; **not re-checked against the providers' current pages** from
 * this repository (no network).
 * - R2: Class A (writes) $4.50 / million, Class B (reads) $0.36 / million,
 *   storage $0.015 / GB-month.
 * - GitHub Actions: Linux 2-core runner $0.008 / minute (assumption).
 */
export const PRICES = {
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  r2StoragePerGbMonth: 0.015,
  ghaPerMinute: 0.008,
  perMillion: 1_000_000
} as const

/** A heartbeat younger than this pulses (ms). */
export const PULSE_FRESH_MS = 3000

/** Event stream: at most this many events are kept (oldest dropped). */
export const EVENT_CAP = 500

/** Live polling interval (ms). */
export const POLL_MS = 2000

/** Ranking rows shown by the bisect panel. */
export const RANK_ROWS = 5

/** Fixed origin of the snapshot scenario's clock: 2026-10-14T12:00:00Z (no wall clock in snapshots). */
export const SCENARIO_EPOCH_MS = Date.UTC(2026, 9, 14, 12, 0, 0)

/** Snapshot scenario timing (seconds). */
export const SCENARIO = {
  bisectStepSec: 6,
  bisectStartSec: 12,
  leaseSeconds: 30,
  heartbeatSeconds: 10,
  crashAtSec: 40,
  commits: 50,
  culprit: 34,
  hang: 22,
  flakeRate: 0.8,
  lockfileBumps: [10, 20, 30, 40],
  coldInstallMs: { min: 38_000, spread: 8_000 },
  restoreMs: { min: 1_400, spread: 900 },
  testMs: { min: 3_000, spread: 2_000 },
  tarballBytes: { min: 140 * 1024 * 1024, spread: 16 * 1024 * 1024 },
  agents: ["agent-alpha", "agent-beta", "agent-gamma"]
} as const
