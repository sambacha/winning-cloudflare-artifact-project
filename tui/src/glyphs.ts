/**
 * The closed glyph set of the dashboard, display widths, and sanitising of
 * untrusted text.
 *
 * Requirements (stated without reference to any test):
 * - G1. Every non-ASCII character the dashboard itself draws comes from
 *   `GLYPHS` (or `BOX`), and each of those has East Asian Width N (neutral)
 *   or A (ambiguous). None is W/F (wide), and none is an emoji or a
 *   pictograph (no Unicode Emoji or Extended_Pictographic property), so no
 *   terminal draws one as an emoji. Ambiguous
 *   characters are drawn one column wide by every terminal unless an
 *   "ambiguous characters are wide" option is switched on; the ASCII mode
 *   (`--ascii`, automatic under `TERM=dumb`) avoids them entirely.
 * - G2. Every glyph has an ASCII fallback of the same display width.
 * - G3. `displayWidth` is the number of terminal columns a string takes:
 *   0 for combining marks, zero-width joiners and variation selectors, 2 for
 *   East Asian Wide/Fullwidth and emoji, 1 otherwise.
 * - G4. `sanitize` maps any string to one whose every character has a width
 *   that does not depend on the terminal: it keeps the closed set, and printable characters of
 *   width 1 or 2 (after NFC normalisation, so that "e" + U+0301 becomes "é")
 *   and replaces every grapheme cluster that still contains an emoji, a
 *   joiner, a variation selector, a combining mark, a control, a format or a
 *   private-use character by "?". So a sanitised string's `displayWidth` is
 *   its displayed width.
 */

export type GlyphName =
  | "ok"
  | "bad"
  | "live"
  | "liveOff"
  | "dot"
  | "ring"
  | "wait"
  | "play"
  | "playOff"
  | "barOn"
  | "barOff"
  | "arrow"
  | "left"
  | "up"
  | "down"
  | "ellipsis"
  | "dash"
  | "infinity"
  | "times"
  | "middot"
  | "sep"

interface GlyphDef {
  readonly char: string
  readonly ascii: string
  /** East Asian Width of `char` (Unicode UAX #11): N = neutral, A = ambiguous. */
  readonly eaw: "N" | "A"
}

export const GLYPHS: Readonly<Record<GlyphName, GlyphDef>> = {
  ok: { char: "✓", ascii: "+", eaw: "N" },
  bad: { char: "✗", ascii: "x", eaw: "N" },
  live: { char: "◆", ascii: "*", eaw: "A" },
  liveOff: { char: "◇", ascii: "o", eaw: "A" },
  dot: { char: "●", ascii: "*", eaw: "A" },
  ring: { char: "○", ascii: "o", eaw: "A" },
  wait: { char: "‖", ascii: "=", eaw: "A" },
  play: { char: "►", ascii: ">", eaw: "A" },
  playOff: { char: "▷", ascii: ">", eaw: "A" },
  barOn: { char: "█", ascii: "#", eaw: "A" },
  barOff: { char: "░", ascii: ".", eaw: "A" },
  arrow: { char: "→", ascii: ">", eaw: "A" },
  left: { char: "←", ascii: "<", eaw: "A" },
  up: { char: "↑", ascii: "^", eaw: "A" },
  down: { char: "↓", ascii: "v", eaw: "A" },
  ellipsis: { char: "…", ascii: ".", eaw: "A" },
  dash: { char: "—", ascii: "-", eaw: "A" },
  infinity: { char: "∞", ascii: "~", eaw: "A" },
  times: { char: "×", ascii: "x", eaw: "A" },
  middot: { char: "·", ascii: ".", eaw: "A" },
  sep: { char: "│", ascii: "|", eaw: "A" }
}

/** Box-drawing characters (all East Asian Width A) and their ASCII fallbacks. */
export const BOX: Readonly<Record<string, string>> = {
  "─": "-",
  "│": "|",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "├": "+",
  "┤": "+",
  "┬": "+",
  "┴": "+",
  "┼": "+",
  "╭": "+",
  "╮": "+",
  "╰": "+",
  "╯": "+",
  "═": "=",
  "║": "|",
  "╔": "+",
  "╗": "+",
  "╚": "+",
  "╝": "+",
  "╠": "+",
  "╣": "+"
}

/**
 * Chart glyphs (`src/charts/plot.ts`): the lower eighth blocks of vertical
 * bars and sparklines, the left eighth blocks of horizontal bars, a dotted
 * cursor, and the 256 Braille patterns of line charts (2×4 dots per cell).
 * Block elements are East Asian Width A, Braille is N; none has an emoji
 * form. ASCII fallbacks keep the width (one column each).
 */
export const LOWER_EIGHTHS: ReadonlyArray<string> = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"]
export const LEFT_EIGHTHS: ReadonlyArray<string> = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"]
export const BRAILLE_BASE = 0x2800
export const BRAILLE_COUNT = 256
export const CURSOR_CHAR = "┊"

export const CHART: Readonly<Record<string, string>> = {
  ...Object.fromEntries(LOWER_EIGHTHS.map((ch, i) => [ch, i < 2 ? "_" : i < 4 ? "-" : i < 6 ? "=" : "#"])),
  ...Object.fromEntries(LEFT_EIGHTHS.map((ch, i) => [ch, i < 3 ? "|" : "#"])),
  [CURSOR_CHAR]: ":",
  ...Object.fromEntries(
    Array.from({ length: BRAILLE_COUNT }, (_, i) => [String.fromCodePoint(BRAILLE_BASE + i), i === 0 ? " " : i === 0x40 || i === 0x80 || i === 0xc0 ? "." : "*"])
  )
}

/** Every non-ASCII character the dashboard may draw itself, with its ASCII fallback. */
export const ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.values(GLYPHS).map((g): [string, string] => [g.char, g.ascii]),
  ...Object.entries(BOX),
  ...Object.entries(CHART)
])

/**
 * ASCII mode: replace every glyph of the closed set by its fallback, and any
 * other non-ASCII character by as many "?" as it is wide (same width).
 */
export const toAscii = (text: string): string => {
  let out = ""
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    out += cp < 0x80 ? ch : (ALLOWED.get(ch) ?? "?".repeat(charWidth(ch)))
  }
  return out
}

/** The glyph for `name` in the current mode. */
export const glyph = (name: GlyphName, ascii: boolean): string => (ascii ? GLYPHS[name].ascii : GLYPHS[name].char)

// ---------------------------------------------------------------------------
// Display width

/** East Asian Wide (W) and Fullwidth (F) ranges, plus the emoji blocks (drawn wide). */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
]

const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = ranges[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

const ZERO = /^[\p{Mn}\p{Me}\u200b-\u200f\u2060-\u2064\ufe00-\ufe0f\u{e0100}-\u{e01ef}]$/u

/** Columns taken by one code point (G3). */
export const charWidth = (ch: string): number => {
  const cp = ch.codePointAt(0)!
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x7f) return 1
  if (ZERO.test(ch)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

/** Columns taken by a string (G3). */
export const displayWidth = (text: string): number => {
  let n = 0
  for (const ch of text) n += charWidth(ch)
  return n
}

// ---------------------------------------------------------------------------
// Sanitising untrusted text

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

const UNSAFE = /[\p{Extended_Pictographic}\p{M}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\u200d\ufe0e\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u

/** A grapheme cluster is kept iff it is one code point, printable, not an emoji, and of width 1 or 2 (G4). */
const safeCluster = (g: string): boolean => {
  if (ALLOWED.has(g)) return true // the closed set (G1: none of it has an emoji form)
  const cps = [...g]
  if (cps.length !== 1) return false
  const ch = cps[0]!
  if (UNSAFE.test(ch)) return false
  const w = charWidth(ch)
  if (w === 2 && inRanges(ch.codePointAt(0)!, [[0x1f000, 0x1faff]])) return false
  return w === 1 || w === 2
}

/** G4: a string whose displayed width is `displayWidth` in every terminal. */
export const sanitize = (text: string): string => {
  const nfc = text.normalize("NFC")
  // Fast path: printable ASCII only.
  if (/^[\x20-\x7e]*$/.test(nfc)) return nfc
  let out = ""
  for (const { segment } of segmenter.segment(nfc)) out += safeCluster(segment) ? segment : "?"
  return out
}
