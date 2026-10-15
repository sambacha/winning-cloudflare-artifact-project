/**
 * Layout and the plain-text renderer of a whole frame (`--snapshot`).
 *
 * Size classes:
 * - large (>= 200x60): a 3 x 2 grid: the five panels and the event stream;
 * - medium (>= 120x40): a 2 x 3 grid, same six boxes;
 * - small (anything else, e.g. 80x24): the focused panel, the event stream
 *   below it.
 *
 * Boxes use ASCII borders only (`+`, `-`, `|`): box-drawing characters are
 * East Asian Ambiguous and render two cells wide in some terminals. Every
 * line of a frame is checked to be exactly the terminal width
 * (`assertWidths`), and the frame has exactly the terminal's row count.
 */
import { LAYOUT } from "./constants.js"
import type { DashboardInput, PanelKey, UiState } from "./model.js"
import { eventPanel, footer, header, type PanelContent, panelFor, type Row } from "./rows.js"
import { assertWidths, displayWidth, fit } from "./width.js"

/** A box on screen. */
export interface Slot {
  readonly kind: "panel" | "events"
  readonly key: PanelKey | null
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The screen's layout. */
export interface Layout {
  readonly size: "small" | "medium" | "large"
  readonly cols: number
  readonly rows: number
  readonly slots: ReadonlyArray<Slot>
}

const ORDER: ReadonlyArray<PanelKey | null> = [1, 2, 3, 4, 5, null]

/** Split `total` into `n` parts differing by at most one (larger parts first). */
export const split = (total: number, n: number): ReadonlyArray<number> => {
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * Where each box goes for a terminal of `cols` x `rows`.
 *
 * @param focus - The focused panel (the only one shown when small).
 */
export const layoutFor = (cols: number, rows: number, focus: PanelKey): Layout => {
  const bodyTop = LAYOUT.headerRows
  const bodyH = Math.max(0, rows - LAYOUT.headerRows - LAYOUT.footerRows)
  const grid = cols >= LAYOUT.large.minCols && rows >= LAYOUT.large.minRows ? LAYOUT.large : cols >= LAYOUT.medium.minCols && rows >= LAYOUT.medium.minRows ? LAYOUT.medium : null
  if (grid === null) {
    const ev = Math.min(LAYOUT.smallEventRows, Math.max(0, bodyH - LAYOUT.border))
    return {
      size: "small",
      cols,
      rows,
      slots: [
        { kind: "panel", key: focus, x: 0, y: bodyTop, w: cols, h: bodyH - ev },
        { kind: "events", key: null, x: 0, y: bodyTop + bodyH - ev, w: cols, h: ev }
      ]
    }
  }
  const widths = split(cols, grid.gridCols)
  const heights = split(bodyH, grid.gridRows)
  const slots: Array<Slot> = []
  ORDER.forEach((key, i) => {
    const c = i % grid.gridCols
    const r = Math.floor(i / grid.gridCols)
    const x = widths.slice(0, c).reduce((a, b) => a + b, 0)
    const y = bodyTop + heights.slice(0, r).reduce((a, b) => a + b, 0)
    slots.push({ kind: key === null ? "events" : "panel", key, x, y, w: widths[c]!, h: heights[r]! })
  })
  return { size: grid === LAYOUT.large ? "large" : "medium", cols, rows, slots }
}

/** Rows of a box's interior: clipped to `h` (head, or tail for the event stream), padded with blank rows. */
export const visibleRows = (content: PanelContent, inner: number, h: number): ReadonlyArray<Row> => {
  const rs = content.rows
  const shown = rs.length <= h ? rs : content.tail === true ? rs.slice(rs.length - h) : rs.slice(0, h)
  return [...shown, ...Array.from({ length: Math.max(0, h - shown.length) }, (): Row => ({ text: fit("", inner), tone: "normal" }))]
}

/** The title bar of a box, exactly `inner` cells: `-[title]----` when focused, `- title ----` otherwise. */
export const titleBar = (title: string, inner: number, focused: boolean): string => {
  const t = `-${focused ? "[" : " "}${title}${focused ? "]" : " "}`
  const w = displayWidth(t)
  return w >= inner ? fit(t, inner) : fit(t, w) + "-".repeat(inner - w)
}

/** One box as rows (exactly `w` wide, `h` tall): border rows dim (accent when focused), content rows with their tones. */
export const boxRows = (content: PanelContent, w: number, h: number, focused: boolean): ReadonlyArray<Row> => {
  if (h <= 0 || w <= 0) return []
  const inner = Math.max(0, w - LAYOUT.border)
  const edge: Row["tone"] = focused ? "accent" : "dim"
  if (h === 1 || w < LAYOUT.border) return Array.from({ length: h }, (): Row => ({ text: fit(content.title, w), tone: edge }))
  const top: Row = { text: `+${titleBar(content.title, inner, focused)}+`, tone: edge }
  const bottom: Row = { text: `+${"-".repeat(inner)}+`, tone: edge }
  const body = visibleRows({ ...content, rows: content.rows.map((r) => ({ ...r, text: fit(r.text, inner) })) }, inner, h - LAYOUT.border).map(
    (r): Row => ({ text: `|${r.text}|`, tone: r.tone })
  )
  return [top, ...body, bottom]
}

/** One box as text lines. */
export const boxLines = (content: PanelContent, w: number, h: number, focused: boolean): ReadonlyArray<string> => boxRows(content, w, h, focused).map((r) => r.text)

/** Boxes grouped by row band (same `y`), left to right: how both renderers compose a frame. */
export const bands = (layout: Layout): ReadonlyArray<ReadonlyArray<Slot>> => {
  const ys = [...new Set(layout.slots.map((s) => s.y))].sort((a, b) => a - b)
  return ys.map((y) => layout.slots.filter((s) => s.y === y).sort((a, b) => a.x - b.x))
}

/** Is this slot the highlighted one? (Only in grids: a small layout shows just the focused panel.) */
export const isFocused = (layout: Layout, slot: Slot, ui: UiState): boolean => slot.kind === "panel" && slot.key === ui.focus && layout.size !== "small"

/** The content of a slot. */
export const slotContent = (slot: Slot, d: DashboardInput, ui: UiState): PanelContent => {
  const inner = Math.max(0, slot.w - LAYOUT.border)
  return slot.kind === "events" || slot.key === null ? eventPanel(d.events, inner) : panelFor(slot.key, d, ui, inner)
}

/**
 * Render a frame as text: exactly `rows` lines of exactly `cols` cells.
 * Deterministic: the same input gives the same bytes.
 */
export const renderFrame = (d: DashboardInput, ui: UiState, cols: number, rows: number): ReadonlyArray<string> => {
  const layout = layoutFor(cols, rows, ui.focus)
  const screen: Array<string> = Array.from({ length: rows }, () => "")
  screen[0] = header(d, ui, cols).text
  // Compose by bands: boxes in the same row band share y; concatenate left to right.
  for (const slot of bands(layout).flat()) {
    const lines = boxLines(slotContent(slot, d, ui), slot.w, slot.h, isFocused(layout, slot, ui))
    lines.forEach((l, i) => {
      screen[slot.y + i] = (screen[slot.y + i] ?? "") + l
    })
  }
  screen[rows - 1] = footer(cols).text
  // No re-fitting here: a box that is too wide or too narrow must fail the check, not be hidden by padding.
  const out = screen
  assertWidths(out, cols)
  if (out.length !== rows) throw new Error(`frame has ${out.length} rows, expected ${rows}`)
  return out
}
