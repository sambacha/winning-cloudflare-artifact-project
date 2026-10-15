/**
 * Terminal cell width, and the sanitiser that guarantees it.
 *
 * Rule: after `sanitize`, a string contains only
 * - printable ASCII (U+0020-U+007E), one cell each, and
 * - East Asian **Wide / Fullwidth** characters (CJK ideographs, kana,
 *   Hangul, fullwidth forms), two cells each.
 *
 * Everything else is replaced, so no glyph of unknown width reaches the
 * terminal:
 * - accented Latin letters are folded to their base letter (NFD, combining
 *   marks dropped: `e` + acute -> `e`);
 * - emoji, ZWJ sequences, flags, variation-selector sequences, and East
 *   Asian **Ambiguous** characters (box drawing, Greek, arrows, ...) become
 *   `?` (one cell, one per grapheme cluster);
 * - control characters (C0, DEL, C1, including ESC) are removed.
 *
 * Grapheme clusters come from `Intl.Segmenter`, so a ZWJ family emoji is
 * one `?`, not five.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

/** East Asian Wide / Fullwidth ranges (subset of EastAsianWidth.txt W/F that terminals render as two cells). */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
]

/** Is `cp` a two-cell character? */
export const isWide = (cp: number): boolean => WIDE.some(([a, b]) => cp >= a && cp <= b)

const isAsciiPrintable = (cp: number): boolean => cp >= 0x20 && cp <= 0x7e
const isControl = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g

/** The replacement for a grapheme of undetermined width. */
export const REPLACEMENT = "?"

/** One grapheme cluster, sanitised: `""` (control), a printable ASCII char, a wide char, or `?`. */
const sanitizeGrapheme = (g: string): string => {
  const cps = [...g].map((c) => c.codePointAt(0)!)
  if (cps.length === 1) {
    const cp = cps[0]!
    if (isControl(cp)) return ""
    if (isAsciiPrintable(cp) || isWide(cp)) return g
  }
  if (cps.every(isControl)) return ""
  // Fold accents: NFD, drop combining marks; keep the result if it is one safe character.
  const folded = g.normalize("NFD").replace(COMBINING, "")
  const fcps = [...folded].map((c) => c.codePointAt(0)!)
  if (fcps.length === 1 && (isAsciiPrintable(fcps[0]!) || isWide(fcps[0]!))) return folded
  return REPLACEMENT
}

/** Sanitise a string (see the module comment). */
export const sanitize = (s: string): string => {
  let out = ""
  for (const { segment } of segmenter.segment(s)) out += sanitizeGrapheme(segment)
  return out
}

/** Cells of a **sanitised** string. */
const cellsOfSafe = (s: string): number => {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

/** Display width of any string (the width it has after `sanitize`). */
export const displayWidth = (s: string): number => cellsOfSafe(sanitize(s))

/** Marker of a truncated field. */
export const TRUNCATED = "~"

/**
 * Exactly `width` cells: sanitised, truncated (last cell `~`) if longer,
 * padded with spaces if shorter. A wide character that would straddle the
 * edge is replaced by a space.
 */
export const fit = (s: string, width: number, align: "left" | "right" = "left"): string => {
  if (width <= 0) return ""
  const safe = sanitize(s)
  const total = cellsOfSafe(safe)
  if (total <= width) {
    const pad = " ".repeat(width - total)
    return align === "left" ? safe + pad : pad + safe
  }
  let out = ""
  let w = 0
  for (const ch of safe) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + " ".repeat(width - 1 - w) + TRUNCATED
}

/** Thrown when a rendered line does not have the frame's width (a layout bug). */
export class WidthViolation extends Error {
  override readonly name = "WidthViolation"
  /** @param line - Index of the line. @param expected - Frame width. @param actual - Its width. */
  constructor(
    readonly line: number,
    readonly expected: number,
    readonly actual: number
  ) {
    super(`line ${line} is ${actual} cells wide, expected ${expected}`)
  }
}

/** Assert every line is exactly `width` cells and contains only safe characters. */
export const assertWidths = (lines: ReadonlyArray<string>, width: number): void => {
  lines.forEach((l, i) => {
    if (sanitize(l) !== l) throw new WidthViolation(i, width, -1)
    const w = cellsOfSafe(l)
    if (w !== width) throw new WidthViolation(i, width, w)
  })
}
