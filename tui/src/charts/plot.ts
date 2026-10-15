/**
 * Chart primitives as pure functions from numbers to character cells. The
 * chart components (`src/panels/Charts*.tsx`) colour the cells and add the
 * axes; nothing here draws a digit, so every label stays a derived figure.
 *
 * Requirements (stated without reference to any test):
 * - P1. Every function returns exactly the requested number of rows, each
 *   of exactly the requested number of cells, for any input (NaN, ±∞,
 *   negative values, empty series, zero or negative sizes give blanks).
 * - P2. Every character drawn is a space or a glyph of the closed set
 *   (`CHART` and `GLYPHS.barOn` in `glyphs.ts`).
 * - P3. Monotone in the value: a larger value never gives a shorter bar or a
 *   lower line dot (within one call, same scale).
 * - P4. `null` in a series means "not yet": nothing is drawn for it, so a
 *   chart revealed up to the script time shows only the past.
 */
import { BRAILLE_BASE, GLYPHS, LEFT_EIGHTHS, LOWER_EIGHTHS } from "../glyphs.ts"

/** A character cell and the series (or category) that drew it; -1 = background. */
export interface Cell {
  readonly ch: string
  readonly k: number
}

export const BLANK: Cell = { ch: " ", k: -1 }

const EIGHTHS = 8
const DOTS_X = 2
const DOTS_Y = 4
const FULL = GLYPHS.barOn.char

const size = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)

const unit = (v: number, lo: number, hi: number): number => {
  if (Number.isNaN(v)) return Number.NaN
  if (!(hi > lo)) return v >= hi ? 1 : 0
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
}

const blankRows = (w: number, h: number): Cell[][] => Array.from({ length: size(h) }, () => Array.from({ length: size(w) }, () => BLANK))

/** Braille dot bits by (dot column 0..1, dot row 0..3 from the top). */
const DOT: ReadonlyArray<ReadonlyArray<number>> = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80]
]

const known = (v: number | null | undefined): v is number => v !== undefined && v !== null && !Number.isNaN(v)

/**
 * Value of `series` at dot column `dx` of `dots` columns: linear
 * interpolation between the two neighbouring samples when both are known,
 * the nearest known one otherwise; null if the nearest sample is not yet (P4).
 */
const sampleAt = (series: ReadonlyArray<number | null>, dx: number, dots: number): number | null => {
  if (series.length === 0) return null
  const x = dots <= 1 ? 0 : (dx * (series.length - 1)) / (dots - 1)
  const i = Math.min(series.length - 1, Math.max(0, Math.floor(x)))
  const j = Math.min(series.length - 1, i + 1)
  const a = series[i]
  const b = series[j]
  const nearest = series[Math.min(series.length - 1, Math.max(0, Math.round(x)))]
  if (!known(nearest)) return null
  if (known(a) && known(b) && Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * (x - i)
  return nearest
}

/**
 * A multi-series line chart in Braille, `w` cells × `h` rows (2 × 4 dots per
 * cell). Each series is resampled to the dot columns (linear interpolation
 * between samples); consecutive dots are
 * joined vertically so steep steps stay connected. A cell takes the colour of
 * the last series drawn in it (later series are on top).
 */
export const lineChart = (series: ReadonlyArray<ReadonlyArray<number | null>>, w: number, h: number, yMin: number, yMax: number): Cell[][] => {
  const cw = size(w)
  const ch = size(h)
  const dotsX = cw * DOTS_X
  const dotsY = ch * DOTS_Y
  if (dotsX === 0 || dotsY === 0) return blankRows(cw, ch)
  const bits: number[][] = Array.from({ length: ch }, () => Array.from({ length: cw }, () => 0))
  const owner: number[][] = Array.from({ length: ch }, () => Array.from({ length: cw }, () => -1))
  const set = (dx: number, dy: number, k: number) => {
    const row = Math.floor(dy / DOTS_Y)
    const col = Math.floor(dx / DOTS_X)
    if (row < 0 || row >= ch || col < 0 || col >= cw) return
    bits[row]![col]! |= DOT[dx % DOTS_X]![dy % DOTS_Y]!
    owner[row]![col] = k
  }
  series.forEach((s, k) => {
    let prev: number | null = null
    for (let dx = 0; dx < dotsX; dx++) {
      const v = sampleAt(s, dx, dotsX)
      if (v === null) {
        prev = null
        continue
      }
      const u = unit(v, yMin, yMax)
      if (Number.isNaN(u)) {
        prev = null
        continue
      }
      const dy = dotsY - 1 - Math.round(u * (dotsY - 1))
      if (prev === null) set(dx, dy, k)
      else for (let y = Math.min(prev, dy); y <= Math.max(prev, dy); y++) set(dx, y, k)
      prev = dy
    }
  })
  return bits.map((r, i) => r.map((b, j): Cell => (b === 0 ? BLANK : { ch: String.fromCodePoint(BRAILLE_BASE + b), k: owner[i]![j]! })))
}

/** Eighths of a cell filled for a fraction of `cells` cells (P3: monotone). */
const eighths = (fraction: number, cells: number): number => (Number.isNaN(fraction) ? 0 : Math.round(Math.max(0, Math.min(1, fraction)) * cells * EIGHTHS))

/** A horizontal bar of exactly `w` cells filled to `fraction`, with eighth-cell resolution. */
export const hbar = (fraction: number, w: number): string => {
  const cw = size(w)
  const e = eighths(fraction, cw)
  const full = Math.min(cw, Math.floor(e / EIGHTHS))
  const part = e % EIGHTHS
  const head = part === 0 || full >= cw ? "" : LEFT_EIGHTHS[part - 1]!
  return FULL.repeat(full) + head + " ".repeat(cw - full - (head === "" ? 0 : 1))
}

/**
 * Vertical bars, one per value, `h` rows high (top row first), with
 * eighth-cell resolution. Values are scaled against `max`. `k` of a cell is
 * the bar's index; `null` values (P4) and non-positive values draw nothing.
 */
export const vbars = (values: ReadonlyArray<number | null>, h: number, max: number): Cell[][] => {
  const ch = size(h)
  const heights = values.map((v) => (v === null || !(v > 0) ? 0 : eighths(unit(v, 0, max), ch)))
  return Array.from({ length: ch }, (_, r) => {
    const fromBottom = ch - 1 - r
    return heights.map((e, k): Cell => {
      const inCell = e - fromBottom * EIGHTHS
      if (inCell <= 0) return BLANK
      return { ch: inCell >= EIGHTHS ? FULL : LOWER_EIGHTHS[inCell - 1]!, k }
    })
  })
}

/** A one-row sparkline of `values` against `max` (one cell per value; `null` and non-positive = blank). */
export const sparkline = (values: ReadonlyArray<number | null>, max: number): Cell[] =>
  values.map((v, k): Cell => {
    if (v === null || Number.isNaN(v) || !(v > 0)) return BLANK
    const e = Math.max(1, Math.round(unit(v, 0, max) * EIGHTHS))
    return { ch: e >= EIGHTHS ? FULL : LOWER_EIGHTHS[e - 1]!, k }
  })

/** Resample `values` to `n` cells: each cell shows the largest value of its slice (null if all null). */
export const resampleMax = (values: ReadonlyArray<number | null>, n: number): Array<number | null> => {
  const cn = size(n)
  if (values.length === 0) return Array.from({ length: cn }, () => null)
  return Array.from({ length: cn }, (_, i) => {
    const a = Math.floor((i * values.length) / cn)
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / cn))
    let best: number | null = null
    for (const v of values.slice(a, b)) if (v !== null && !Number.isNaN(v) && (best === null || v > best)) best = v
    return best
  })
}

/** Resample categorical samples to `n` cells (nearest sample to the cell's centre). */
export const resampleNearest = <A>(values: ReadonlyArray<A>, n: number, empty: A): A[] => {
  const cn = size(n)
  if (values.length === 0) return Array.from({ length: cn }, () => empty)
  return Array.from({ length: cn }, (_, i) => values[Math.min(values.length - 1, Math.floor(((i + 0.5) * values.length) / cn))]!)
}

/** Column (0..w-1) of time `t` on an axis from 0 to `span` drawn over `w` cells; null outside. */
export const columnOf = (t: number, span: number, w: number): number | null => {
  const cw = size(w)
  if (cw === 0 || !(span > 0) || Number.isNaN(t) || t < 0 || t > span) return null
  return Math.min(cw - 1, Math.floor((t / span) * cw))
}

const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const

/** A "nice" axis maximum ≥ v: one of `NICE_STEPS` times a power of ten (0 for v ≤ 0 or NaN). */
export const niceMax = (v: number): number => {
  if (v === Infinity) return Infinity
  if (!(v > 0)) return 0
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of NICE_STEPS) if (m * p >= v * (1 - Number.EPSILON)) return m * p
  return 10 * p
}

/** Fraction of a value on a log axis from `lo` to `hi` (both > 0); clamped to [0, 1]. */
export const logFraction = (v: number, lo: number, hi: number): number => {
  if (!(v > 0) || !(lo > 0) || !(hi > lo)) return v >= hi ? 1 : 0
  return Math.max(0, Math.min(1, (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))))
}

/**
 * Bars of `values` spread over `w` columns: each value gets an equal slice
 * of whole columns (at least one), and the last column of a slice is a gap
 * when slices are at least `GAP_FROM` columns wide. Gap columns are null.
 * Columns beyond the last slice are null too.
 */
const GAP_FROM = 3
export const spreadBars = (values: ReadonlyArray<number | null>, w: number): Array<number | null> => {
  const cw = size(w)
  if (values.length === 0) return Array.from({ length: cw }, () => null)
  const per = Math.max(1, Math.floor(cw / values.length))
  return Array.from({ length: cw }, (_, i) => {
    const k = Math.floor(i / per)
    if (k >= values.length) return null
    if (per >= GAP_FROM && i % per === per - 1) return null
    return values[k] ?? null
  })
}

/** A log axis for positive values: from half the smallest to the largest (so the smallest still shows). */
export const logAxis = (values: ReadonlyArray<number>): { readonly lo: number; readonly hi: number } => {
  const pos = values.filter((v) => v > 0 && Number.isFinite(v))
  if (pos.length === 0) return { lo: 1, hi: 1 }
  const hi = Math.max(...pos)
  const lo = Math.min(...pos) / 2
  return { lo, hi: hi > lo ? hi : lo * 2 }
}
