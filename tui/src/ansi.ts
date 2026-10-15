/**
 * Styled text as data: a line is a list of segments, each with a style.
 * Widths are computed on the segments with `displayWidth` (never by parsing
 * escape codes), so padding and truncation are exact. Text that comes from
 * outside the program is passed through `sanitize` before it gets here (the
 * Ink shim does this for every `<Text>` child), so the computed width is the
 * displayed width in every terminal.
 */
import { charWidth, displayWidth, toAscii } from "./glyphs.ts"

export interface Style {
  readonly fg?: string // "#rrggbb"
  readonly bg?: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly underline?: boolean
}

export interface Seg {
  readonly text: string
  readonly style?: Style
}

export type Line = ReadonlyArray<Seg>

/** A segment. */
export const s = (text: string, style?: Style): Seg => (style === undefined ? { text } : { text, style })

/** Display width of a string in terminal columns. */
export const width = (text: string): number => displayWidth(text)

export const lineWidth = (line: Line): number => line.reduce((n, g) => n + width(g.text), 0)

/** Plain text of a line (no styling). */
export const plain = (line: Line): string => line.map((g) => g.text).join("")

/**
 * Cut a line to at most `w` columns. A wide character that would straddle
 * the edge is dropped (never half drawn), so the result may be one column
 * narrower than `w`; `fit` pads it back.
 */
export const truncate = (line: Line, w: number): Line => {
  const out: Seg[] = []
  let left = w
  for (const g of line) {
    if (left <= 0) break
    const n = width(g.text)
    if (n <= left) {
      out.push(g)
      left -= n
      continue
    }
    let text = ""
    for (const ch of g.text) {
      const cw = charWidth(ch)
      if (cw > left) break
      text += ch
      left -= cw
    }
    out.push({ ...g, text })
    break
  }
  return out
}

/** Pad (or cut) a line to exactly `w` columns. */
export const fit = (line: Line, w: number, fill: Style | undefined = undefined): Line => {
  const cut = truncate(line, w)
  const n = lineWidth(cut)
  return n < w ? [...cut, s(" ".repeat(w - n), fill)] : cut
}

/** Right-align a line in `w` columns. */
export const fitRight = (line: Line, w: number): Line => {
  const cut = truncate(line, w)
  const n = lineWidth(cut)
  return n < w ? [s(" ".repeat(w - n)), ...cut] : cut
}

/** Centre a line in `w` columns. */
export const center = (line: Line, w: number): Line => {
  const cut = truncate(line, w)
  const n = lineWidth(cut)
  const left = Math.floor((w - n) / 2)
  return fit([s(" ".repeat(Math.max(0, left))), ...cut], w)
}

const hex = (c: string): [number, number, number] => {
  const v = Number.parseInt(c.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

const sgr = (st: Style): string => {
  const codes: string[] = [
    ...(st.bold ? ["1"] : []),
    ...(st.dim ? ["2"] : []),
    ...(st.underline ? ["4"] : []),
    ...(st.fg ? [`38;2;${hex(st.fg).join(";")}`] : []),
    ...(st.bg ? [`48;2;${hex(st.bg).join(";")}`] : [])
  ]
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`
}

export interface RenderMode {
  readonly color: boolean
  readonly ascii?: boolean
}

/**
 * Render a line to a terminal string. `color = false` gives plain text;
 * `ascii` replaces the closed glyph set by its same-width ASCII fallbacks.
 */
export const render = (line: Line, mode: boolean | RenderMode): string => {
  const m: RenderMode = typeof mode === "boolean" ? { color: mode } : mode
  const text = (t: string) => (m.ascii === true ? toAscii(t) : t)
  return m.color ? line.map((g) => (g.style ? `${sgr(g.style)}${text(g.text)}\x1b[0m` : text(g.text))).join("") : text(plain(line))
}
