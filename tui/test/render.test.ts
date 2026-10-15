/**
 * Render laws of the dashboard (`src/view.tsx`), stated without reference
 * to any particular frame:
 *
 * - V1 (geometry / width invariant). For every terminal size, script time,
 *   decision, focus, scroll, overlay, tick and mode, `frame` returns exactly
 *   `rows` lines, and every line is exactly `cols` columns wide as measured
 *   by an independent width oracle (`test/gen.ts`), which also rejects any
 *   character whose width terminals disagree on (emoji, ZWJ sequences,
 *   variation selectors, combining marks, controls).
 * - V2 (fuzz). The same holds when untrusted text — live lock rows from R2
 *   and event payloads — contains emoji, CJK, ZWJ families, flags, combining
 *   marks, controls, bidi overrides and ANSI escapes; and no control
 *   character or escape from that text reaches the terminal.
 * - V3 (output modes). Without colour no escape sequence is written; in
 *   ASCII mode only printable ASCII is written, at the same widths.
 * - V4 (determinism). A frame is a function of its arguments; the seed only
 *   changes the latency figure; with motion off the tick changes nothing.
 * - V5 (fixed chrome). The top and bottom borders and the rules around the
 *   body are always at the same rows for a breakpoint, whatever the scroll.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { type Line, plain, render } from "../src/ansi.ts"
import { type LiveRow, withLiveLocks } from "../src/live.ts"
import { LOGO_ROWS } from "../src/logo.ts"
import { type Decision, type Event, type State, stateAt, TIMELINE } from "../src/scenario.ts"
import { breakpointFor, chromeRows, frame, MIN_COLS, MIN_ROWS, type Overlay, type Ui } from "../src/view.tsx"
import { genHostile, oracleWidth } from "./gen.ts"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/render.test.ts")

const OVERLAYS: ReadonlyArray<Overlay> = [null, null, null, "git", "notes", "help", "overview"]
const EDGE_COLS = [1, MIN_COLS - 1, MIN_COLS, 119, 120, 159, 160, 199, 200, 260]
const EDGE_ROWS = [1, MIN_ROWS - 1, MIN_ROWS, 39, 40, 49, 50, 59, 60, 90]

interface Case {
  readonly cols: number
  readonly rows: number
  readonly t: number
  readonly decision: Decision
  readonly ui: Ui
  readonly anim: boolean
  readonly seed: number
}

const genTime = (r: Rng): number => (r.chance(0.6) ? r.pick(TIMELINE.instants) + r.pick([-0.01, 0, 0.01]) : r.next() * (TIMELINE.review + 20) - 2)

const genDecision = (r: Rng): Decision =>
  r.chance(0.5) ? null : { kind: r.pick(["approve", "reject"] as const), at: TIMELINE.review + r.pick([-1, 0, 0.5, 4]) }

const genCase = (r: Rng): Case => ({
  cols: r.chance(0.4) ? r.pick(EDGE_COLS) : r.int(1, 260),
  rows: r.chance(0.4) ? r.pick(EDGE_ROWS) : r.int(1, 90),
  t: genTime(r),
  decision: genDecision(r),
  ui: { focus: r.int(0, 7), scroll: r.chance(0.3) ? 0 : r.int(0, 300), overlay: r.pick(OVERLAYS), tick: r.int(0, 1000) },
  anim: r.chance(0.5),
  seed: r.int(0, 2 ** 32 - 1)
})

const ESC = "\x1b"

/** V1 for one frame: rows × cols by the oracle. */
const assertGeometry = (lines: ReadonlyArray<Line>, cols: number, rows: number): void => {
  assert.equal(lines.length, Math.max(0, rows), `expected ${rows} lines, got ${lines.length}`)
  lines.forEach((l, i) => {
    const text = plain(l)
    assert.ok(!/[\x00-\x1f\x7f]/.test(text), `line ${i} contains a control character: ${JSON.stringify(text)}`)
    assert.equal(oracleWidth(text), cols, `line ${i} is ${oracleWidth(text)} columns, not ${cols}: ${JSON.stringify(text)}`)
  })
}

test("V1: every frame is exactly rows × cols, measured by an independent width oracle, at every size and state", () => {
  law(
    "frame geometry",
    160,
    genCase,
    (c) => {
      const f = frame(stateAt(c.t, c.decision), c.ui, c.cols, c.rows, { seed: c.seed, anim: c.anim })
      assertGeometry(f.lines, c.cols, c.rows)
      const small = c.cols < MIN_COLS || c.rows < MIN_ROWS
      assert.equal(f.breakpoint === null, small)
      return { valid: true, boundary: small || EDGE_COLS.includes(c.cols) || EDGE_ROWS.includes(c.rows) }
    },
    { domain: "cols 1–260, rows 1–90 (40% at breakpoint edges ±1), t at every instant ±0.01 s or random, decisions around the gate, focus 0–7, scroll 0–300, overlays, ticks, motion on/off, any seed", minValidFraction: 1, minBoundary: 40 }
  )
})

test("V1 rejects a renderer that pads by code points instead of columns", () => {
  // Broken variant: a line padded to `cols` code points; a wide character makes it too wide.
  const padByCodePoints = (s: string, cols: number) => s + " ".repeat(Math.max(0, cols - [...s].length))
  assert.ok(refutes(100, (r) => ({ s: r.pick(["漢字", "abc", "한국"]) + r.pick(["", "x"]), cols: r.int(10, 30) }), ({ s, cols }) => oracleWidth(padByCodePoints(s, cols)) === cols))
})

const hostileRow = (r: Rng, i: number, t: number): LiveRow => {
  const state = r.pick(["BUILDING", "SUCCEEDED", "FAILED"] as const)
  return {
    op: `${genHostile(r)}${i}`,
    holder: genHostile(r),
    state,
    progress: state === "BUILDING" ? 0 : 1,
    lastWrite: t - r.next() * 40,
    expiresAt: state === "BUILDING" ? t + r.next() * 60 - 10 : null,
    etag: genHostile(r),
    via: genHostile(r),
    prev: null,
    result: state === "BUILDING" ? null : genHostile(r),
    key: genHostile(r),
    live: true
  }
}

const hostileEvent = (r: Rng, t: number): Event => ({ t, kind: r.pick(["LOCK", "CACHE", "HB", "LEAN"] as const), parts: [genHostile(r), { ref: genHostile(r) }, genHostile(r)] })

test("V2: untrusted text (live R2 rows, event payloads) with emoji, CJK, ZWJ, marks, controls and escapes never breaks the geometry", () => {
  law(
    "hostile text",
    120,
    (r) => {
      const c = genCase(r)
      const rows = Array.from({ length: r.int(0, 5) }, (_, i) => hostileRow(r, i, c.t))
      return { c: { ...c, cols: Math.max(MIN_COLS, c.cols), rows: Math.max(MIN_ROWS, c.rows) }, rows, events: Array.from({ length: r.int(0, 4) }, () => hostileEvent(r, Math.max(0, c.t))) }
    },
    ({ c, rows, events }) => {
      const base = stateAt(c.t, c.decision)
      const st: State = { ...withLiveLocks(base, rows), events: [...base.events, ...events] }
      const ui = { ...c.ui, focus: r6(c.ui.focus) }
      const f = frame(st, ui, c.cols, c.rows, { seed: c.seed, anim: c.anim })
      assertGeometry(f.lines, c.cols, c.rows)
      for (const l of f.lines) {
        const out = render(l, { color: true, ascii: false })
        // The only escapes are the renderer's own SGR sequences.
        assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(out), `foreign escape in ${JSON.stringify(out)}`)
      }
      return { valid: true, boundary: rows.length > 0 && events.length > 0 }
    },
    { domain: "as V1 at ≥ 80×24, with 0–5 live rows and 0–4 events whose every text field is hostile Unicode", minValidFraction: 1, minBoundary: 20 }
  )
})

/** Focus on the lock or event panel, where the hostile text is. */
const r6 = (focus: number): number => (focus === 2 || focus === 6 ? focus : 2)

test("V3: without colour no escape is written; in ASCII mode only printable ASCII, at the same widths", () => {
  law(
    "output modes",
    80,
    genCase,
    (c) => {
      const f = frame(stateAt(c.t, c.decision), c.ui, c.cols, c.rows, { seed: c.seed, anim: c.anim })
      for (const l of f.lines) {
        const mono = render(l, false)
        assert.ok(!mono.includes(ESC), "escape without colour")
        assert.equal(mono, plain(l))
        const ascii = render(l, { color: false, ascii: true })
        assert.match(ascii, /^[\x20-\x7e]*$/, `non-ASCII in ASCII mode: ${JSON.stringify(ascii)}`)
        assert.equal(ascii.length, c.cols)
        const colourAscii = render(l, { color: true, ascii: true })
        assert.equal(colourAscii.replace(/\x1b\[[0-9;]*m/g, ""), ascii)
      }
      return { valid: true, boundary: c.ui.overlay !== null }
    },
    { domain: "as V1", minValidFraction: 1, minBoundary: 10 }
  )
})

test("V4: frames are deterministic; the seed changes only the latency figure; with motion off the tick changes nothing", () => {
  law(
    "determinism",
    60,
    (r) => ({ c: genCase(r), seed2: r.int(0, 2 ** 32 - 1), tick2: r.int(0, 1000) }),
    ({ c, seed2, tick2 }) => {
      const cols = Math.max(MIN_COLS, c.cols)
      const rows = Math.max(MIN_ROWS, c.rows)
      const st = stateAt(c.t, c.decision)
      const a = frame(st, c.ui, cols, rows, { seed: c.seed, anim: c.anim }).lines.map(plain)
      const b = frame(stateAt(c.t, c.decision), { ...c.ui }, cols, rows, { seed: c.seed, anim: c.anim }).lines.map(plain)
      assert.deepEqual(a, b)
      const other = frame(st, c.ui, cols, rows, { seed: seed2, anim: c.anim }).lines.map(plain)
      a.forEach((line, i) => {
        if (line !== other[i]) assert.match(line, /ms latency|seed/, `seed changed row ${i}: ${line}`)
      })
      const still1 = frame(st, c.ui, cols, rows, { seed: c.seed, anim: false }).lines.map(plain)
      const still2 = frame(st, { ...c.ui, tick: tick2 }, cols, rows, { seed: c.seed, anim: false }).lines.map(plain)
      assert.deepEqual(still1, still2)
      return { valid: true, boundary: c.ui.overlay === null && st.triggered }
    },
    { domain: "as V1 at ≥ 80×24, second seed and tick random", minValidFraction: 1, minBoundary: 10 }
  )
})

test("V5: borders and rules are at fixed rows for a breakpoint, whatever the scroll; the footer is never pushed off", () => {
  law(
    "fixed chrome",
    80,
    genCase,
    (c) => {
      const cols = Math.max(MIN_COLS, c.cols)
      const rows = Math.max(MIN_ROWS, c.rows)
      const bp = breakpointFor(cols, rows)!
      const f = frame(stateAt(c.t, c.decision), c.ui, cols, rows, { seed: c.seed, anim: c.anim })
      const text = f.lines.map(plain)
      const head = 1 + bp.headerRows + (bp.logo ? LOGO_ROWS : 0)
      assert.match(text[0]!, /^╔═+╗$/)
      assert.match(text[head]!, /^╠═+╣$/)
      assert.match(text[rows - 2 - bp.footerRows]!, /^╠═+╣$/)
      assert.match(text[rows - 1]!, /^╚═+╝$/)
      assert.equal(f.bodyRows, rows - chromeRows(bp))
      assert.ok(f.scroll >= 0 && f.scroll <= Math.max(0, f.bodyLength - f.bodyRows))
      return { valid: true, boundary: c.ui.scroll > f.scroll }
    },
    { domain: "as V1 at ≥ 80×24", minValidFraction: 1, minBoundary: 10 }
  )
})
