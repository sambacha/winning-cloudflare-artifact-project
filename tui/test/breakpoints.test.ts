/**
 * Breakpoint and panel-selection laws (rules L1–L4 of `src/view.tsx`):
 *
 * - L1. The breakpoint is the largest one whose size fits the terminal.
 * - L3. The visible panels are a greedy prefix of the priority order (the
 *   focused panel first): at least one panel; the sum of their `minHeight`
 *   fits the body unless only one is shown; the next panel in that order
 *   would not fit (or `maxPanels` is reached); `full` shows every panel.
 *   Hidden panels are announced in the footer as "+N panels".
 * - Coverage. Each visible panel's title is drawn in the body and no hidden
 *   panel's title is; a panel focused with its key is on screen with at
 *   least `min(minHeight, body rows)` of its rows, at every breakpoint.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { plain } from "../src/ansi.ts"
import { initial, update } from "../src/app.ts"
import { BREAKPOINTS, PANELS, type PanelId } from "../src/layout.ts"
import { stateAt, TIMELINE } from "../src/scenario.ts"
import { body, breakpointFor, choosePanels, frame, viewportFor } from "../src/view.tsx"
import { announce, law } from "./prop.ts"

announce("test/breakpoints.test.ts")

const KEY: Readonly<Record<PanelId, string>> = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "e", 7: "u" }
/** A panel's title row ends with its key binding, e.g. "[3] │" (the footer's "[1-5]" and "[e]vents" do not match). */
const TITLE = (id: PanelId): RegExp => new RegExp(`\\[${KEY[id]}\\] [│┃]`)
const minHeight = (id: PanelId) => PANELS.find((p) => p.id === id)!.minHeight

const genSize = (r: { int: (a: number, b: number) => number; chance: (p: number) => boolean; pick: <T>(x: ReadonlyArray<T>) => T }) => {
  const bp = r.pick(BREAKPOINTS)
  return r.chance(0.4) ? { cols: bp.cols + r.pick([0, 1]), rows: bp.rows + r.pick([0, 1]) } : { cols: r.int(BREAKPOINTS[0]!.cols, 240), rows: r.int(BREAKPOINTS[0]!.rows, 80) }
}

test("L1: the breakpoint is the largest that fits", () => {
  law(
    "breakpoint choice",
    500,
    (r) => ({ cols: r.int(1, 260), rows: r.int(1, 90) }),
    ({ cols, rows }) => {
      const bp = breakpointFor(cols, rows)
      const fitting = BREAKPOINTS.filter((b) => b.cols <= cols && b.rows <= rows)
      if (fitting.length === 0) assert.equal(bp, null)
      else {
        assert.ok(bp !== null && bp.cols <= cols && bp.rows <= rows)
        for (const b of fitting) assert.ok(b.cols * b.rows <= bp.cols * bp.rows)
      }
      return { valid: true, boundary: BREAKPOINTS.some((b) => b.cols === cols || b.rows === rows) || bp === null }
    },
    { domain: "cols 1–260, rows 1–90", minValidFraction: 1, minBoundary: 30 }
  )
})

test("L3: visible panels are a maximal greedy prefix of the priority order, focused panel first", () => {
  law(
    "panel choice",
    600,
    (r) => ({ bp: r.pick(BREAKPOINTS), bodyRows: r.int(1, 80), focus: r.int(0, 7) }),
    ({ bp, bodyRows, focus }) => {
      const { visible, hidden } = choosePanels(bp, bodyRows, focus)
      assert.deepEqual([...visible, ...hidden].sort(), PANELS.map((p) => p.id).sort())
      assert.ok(visible.length >= 1)
      if (bp.allPanels) {
        assert.equal(hidden.length, 0)
        return { valid: true, boundary: true }
      }
      if (focus >= 1 && focus <= 7) assert.ok(visible.includes(focus as PanelId), "the focused panel is shown")
      const order = [...PANELS].sort((a, b) => a.priority - b.priority).map((p) => p.id)
      const ordered = focus >= 1 && focus <= 7 ? [focus as PanelId, ...order.filter((id) => id !== focus)] : order
      const prefix = ordered.slice(0, visible.length)
      assert.deepEqual([...prefix].sort(), [...visible].sort(), "visible panels are a prefix of the order")
      const used = visible.reduce((a, id) => a + minHeight(id), 0)
      if (visible.length > 1) assert.ok(used <= bodyRows, `${used} rows of panels in a ${bodyRows}-row body`)
      const next = ordered[visible.length]
      if (next !== undefined) assert.ok(visible.length >= bp.maxPanels || used + minHeight(next) > bodyRows, "a further panel would have fit")
      return { valid: true, boundary: hidden.length === 0 || visible.length === 1 }
    },
    { domain: "4 breakpoints, body 1–80 rows, focus 0–7", minValidFraction: 1, minBoundary: 100 }
  )
})

test("coverage: visible panels are drawn and hidden ones are not; the footer counts the hidden ones", () => {
  law(
    "panels drawn",
    // Boundary (nothing hidden) has p ≈ 0.18: with 60 cases P(fewer than 5) was 1%; with 120 it is ~1e-5.
    120,
    (r) => ({ ...genSize(r), t: r.pick(TIMELINE.instants), focus: r.int(0, 7) }),
    ({ cols, rows, t, focus }) => {
      const vp = viewportFor(cols, rows)!
      const st = stateAt(t, null)
      const b = body(st, { focus, scroll: 0, overlay: null, tick: 0 }, vp)
      const text = b.lines.map(plain).join("\n")
      for (const id of b.visible) assert.match(text, TITLE(id), `panel ${id} is visible but not drawn`)
      for (const id of b.hidden) assert.doesNotMatch(text, TITLE(id), `panel ${id} is hidden but drawn`)
      const f = frame(st, { focus, scroll: 0, overlay: null, tick: 0 }, cols, rows)
      const foot = f.lines.slice(rows - 1 - vp.bp.footerRows).map(plain).join("\n")
      if (b.hidden.length > 0) assert.match(foot, new RegExp(`\\+${b.hidden.length} panels`))
      else assert.doesNotMatch(foot, /\+\d+ panels/)
      return { valid: true, boundary: b.hidden.length === 0 }
    },
    { domain: "sizes at and between the breakpoints, script instants, focus 0–7", minValidFraction: 1, minBoundary: 5 }
  )
})

test("coverage: a panel focused with its key is on screen with at least min(minHeight, body) of its rows, at every breakpoint", () => {
  law(
    "focus shows the panel",
    60,
    (r) => ({ ...genSize(r), t: r.pick(TIMELINE.instants), id: r.pick(PANELS).id }),
    ({ cols, rows, t, id }) => {
      let app = update(initial({ cols, rows }), { type: "key", key: " " })
      app = update(app, { type: "tick", dtS: t })
      app = update(app, { type: "key", key: KEY[id] })
      const f = frame(stateAt(app.t, app.decision), app.ui, cols, rows, app.view)
      assert.ok(f.visible.includes(id))
      const anchor = f.anchors[id]
      const shown = Math.min(f.scroll + f.bodyRows, f.bodyLength) - anchor // rows from the panel's title to the end of the viewport
      assert.ok(anchor >= f.scroll && anchor < f.scroll + f.bodyRows, `panel ${id} starts at body line ${anchor}, viewport ${f.scroll}–${f.scroll + f.bodyRows}`)
      assert.ok(shown >= Math.min(minHeight(id), f.bodyRows, f.bodyLength - anchor), `only ${shown} rows of panel ${id} visible`)
      const head = f.lines.map(plain).join("\n")
      assert.match(head, TITLE(id))
      return { valid: true, boundary: f.scroll > 0 }
    },
    { domain: "sizes at and between the breakpoints, script instants, every panel", minValidFraction: 1, minBoundary: 3 }
  )
})
