/**
 * The charts view: the plot primitives (`src/charts/plot.ts`, P1–P4), the
 * run's series (`series.ts`, C1–C4), the layout rules (`layout.ts`, K1–K3),
 * the keys of the charts view (`app.ts`, A5–A6), exact frames with the
 * charts open, and the clean scenario's charts panel (`clean.ts`, CC1–CC3).
 * Each law has a broken variant that it refutes (the check is not vacuous).
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { lineWidth, plain } from "../src/ansi.ts"
import { initial, onKey, update, type App } from "../src/app.ts"
import { confidencePlot, probeRows, probes, shownStatuses } from "../src/charts/clean.ts"
import { clampTile, nextTile, prevTile, RUN_TILES, tileRows, plotRows, CH } from "../src/charts/layout.ts"
import { columnOf, hbar, lineChart, logFraction, niceMax, resampleMax, sparkline, spreadBars, vbars, type Cell } from "../src/charts/plot.ts"
import { timeline } from "../src/charts/run.ts"
import { CHART_SPAN_S, histogram, reveal, runSeries } from "../src/charts/series.ts"
import { parseBisectStatus } from "../src/clean/bisectStatus.ts"
import { BISECT } from "../src/clean/fixture.ts"
import { fixtureStatusBodies } from "../src/clean/figures.ts"
import { pressKey, stateAt as cleanStateAt, START } from "../src/clean/model.ts"
import { cleanFrame } from "../src/clean/view.tsx"
import { INPUTS } from "../src/data.ts"
import { ALLOWED, GLYPHS } from "../src/glyphs.ts"
import { stateAt, TIMELINE } from "../src/scenario.ts"
import { frame } from "../src/view.tsx"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/charts.test.ts")

const weird = (r: Rng): number | null =>
  r.chance(0.15) ? r.pick([Number.NaN, Infinity, -Infinity, -1, 0, null]) : r.chance(0.5) ? r.int(0, 100) : r.next() * r.int(1, 1000)

const genSeries = (r: Rng): Array<number | null> => Array.from({ length: r.int(0, 40) }, () => weird(r))

const closed = (cells: ReadonlyArray<Cell>): boolean => cells.every((c) => c.ch === " " || ALLOWED.has(c.ch))

test("P1/P2: every primitive returns exactly the requested size, drawn from the closed glyph set", () => {
  law(
    "plot sizes",
    300,
    (r) => ({ series: Array.from({ length: r.int(0, 3) }, () => genSeries(r)), w: r.pick([0, 1, 2, r.int(0, 120), Number.NaN, -3]), h: r.pick([0, 1, r.int(0, 20)]), lo: r.pick([0, -5, 10]), hi: r.pick([0, 1, 100, Number.NaN]) }),
    ({ series, w, h, lo, hi }) => {
      const cw = Number.isFinite(w) ? Math.max(0, Math.floor(w)) : 0
      const rows = lineChart(series, w, h, lo, hi)
      assert.equal(rows.length, h)
      for (const row of rows) {
        assert.equal(row.length, cw)
        assert.ok(closed(row))
      }
      const bars = vbars(series[0] ?? [], h, hi)
      assert.equal(bars.length, h)
      for (const row of bars) {
        assert.equal(row.length, (series[0] ?? []).length)
        assert.ok(closed(row))
      }
      const hb = hbar(series[0]?.[0] ?? Number.NaN, w)
      assert.equal([...hb].length, cw)
      assert.ok([...hb].every((c) => c === " " || ALLOWED.has(c)))
      assert.equal(resampleMax(series[0] ?? [], w).length, cw)
      assert.equal(spreadBars(series[0] ?? [], w).length, cw)
      assert.ok(closed(sparkline(series[0] ?? [], hi)))
      return { valid: true, boundary: cw === 0 || h === 0 || series.length === 0 }
    },
    { domain: "0–3 series of 0–40 values with NaN/±∞/negatives/null; sizes 0–120 × 0–20 and invalid sizes", minValidFraction: 1, minBoundary: 10 }
  )
})

const filled = (s: string): number => [...s].reduce((n, c) => n + (c === GLYPHS.barOn.char ? 8 : c === " " ? 0 : 1 + "▏▎▍▌▋▊▉".indexOf(c)), 0)

test("P3: bars are monotone in the value", () => {
  law(
    "hbar monotone",
    300,
    (r) => ({ a: r.next() * 1.2 - 0.1, b: r.next() * 1.2 - 0.1, w: r.int(1, 80) }),
    ({ a, b, w }) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      assert.ok(filled(hbar(lo, w)) <= filled(hbar(hi, w)), `${lo} ${hi} ${w}`)
      return { valid: true, boundary: lo <= 0 || hi >= 1 }
    },
    { domain: "fractions in [-0.1, 1.1], widths 1–80", minValidFraction: 1, minBoundary: 10 }
  )
  // Broken variant: a bar drawn for the complement of the fraction is refuted.
  assert.ok(refutes(200, (r) => ({ a: r.next(), b: r.next(), w: r.int(2, 40) }), ({ a, b, w }) => filled(hbar(1 - Math.min(a, b), w)) <= filled(hbar(1 - Math.max(a, b), w))))
})

test("P3: a larger value never draws a lower line dot", () => {
  const top = (rows: ReadonlyArray<ReadonlyArray<Cell>>): number => rows.findIndex((r) => r.some((c) => c.k >= 0))
  law(
    "line monotone",
    200,
    // Equal values (the boundary) are drawn directly a fifth of the time; uniform draws hit them with p = 1/101.
    (r) => {
      const a = r.int(0, 100)
      return { a, b: r.chance(0.2) ? a : r.int(0, 100), h: r.int(1, 12) }
    },
    ({ a, b, h }) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      assert.ok(top(lineChart([[hi]], 1, h, 0, 100)) <= top(lineChart([[lo]], 1, h, 0, 100)))
      return { valid: true, boundary: lo === hi }
    },
    { domain: "values 0–100, heights 1–12", minValidFraction: 1, minBoundary: 1 }
  )
})

test("P4/C2: nothing after the script time is drawn", () => {
  const s = runSeries()
  law(
    "reveal",
    80,
    (r) => ({ t: r.pick([-1, 0, TIMELINE.review, CHART_SPAN_S, r.next() * CHART_SPAN_S]), w: r.int(CH.minPlotCols, 140) }),
    ({ t, w }) => {
      const shown = reveal(s.cost, s.times, t)
      shown.forEach((v, i) => assert.equal(v === null, t < 0 || s.times[i]! > t + 1e-9))
      const tl = timeline(stateAt(t, null), INPUTS, w)
      const last = columnOf(Math.max(0, t), CHART_SPAN_S, w)
      for (const lane of tl.lanes)
        lane.cells.forEach((c, i) => {
          if (t < 0 || (last !== null && i > last + 1)) assert.equal(c.ch, " ", `lane ${lane.op} col ${i} at t=${t}`)
        })
      return { valid: true, boundary: t < 0 || t >= CHART_SPAN_S }
    },
    { domain: "idle, the start, the gate, the end and random times; widths 12–140", minValidFraction: 1, minBoundary: 5 }
  )
})

test("C1/C3: the series cover the axis and the lanes are the scenario's locks in order", () => {
  const s = runSeries()
  assert.equal(s.times[0], 0)
  assert.equal(s.times[s.times.length - 1], CHART_SPAN_S)
  assert.deepEqual(
    s.lanes.map((l) => l.op),
    stateAt(CHART_SPAN_S, null).locks.map((l) => l.op)
  )
  s.lanes.forEach((lane) =>
    lane.samples.forEach((x, i) => {
      const l = stateAt(s.times[i]!, null).locks.find((y) => y.op === lane.op)!
      assert.equal(x.state, l.state)
      assert.equal(x.holder, l.holder)
    })
  )
  // The Cobuilds cost never exceeds the GitHub Actions equivalent (the chart's message), and both only grow.
  s.cost.forEach((c, i) => {
    assert.ok(c <= s.gha[i]! + 1e-12)
    if (i > 0) assert.ok(c >= s.cost[i - 1]! - 1e-12 && s.gha[i]! >= s.gha[i - 1]! - 1e-12)
  })
})

test("C4: histogram buckets count exactly the times at or before t", () => {
  law(
    "histogram",
    200,
    (r) => ({ ts: Array.from({ length: r.int(0, 30) }, () => r.next() * CHART_SPAN_S), t: r.pick([-1, 0, r.next() * CHART_SPAN_S, CHART_SPAN_S]) }),
    ({ ts, t }) => {
      const h = histogram(ts, t)
      const total = h.reduce<number>((a, v) => a + (v ?? 0), 0)
      assert.equal(total, ts.filter((x) => x <= t).length)
      return { valid: true, boundary: t < 0 || ts.length === 0 }
    },
    { domain: "0–30 times on the axis; t idle, 0, random, end", minValidFraction: 1, minBoundary: 5 }
  )
})

test("niceMax is a ceiling within 1.5× (and logFraction is monotone)", () => {
  law(
    "nice",
    300,
    (r) => ({ v: r.next() * Math.pow(10, r.int(-4, 6)), a: r.next() * 100 + 1, b: r.next() * 100 + 1 }),
    ({ v, a, b }) => {
      const m = niceMax(v)
      assert.ok(m >= v && m <= v * 1.5 + 1e-12, `${v} → ${m}`)
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      assert.ok(logFraction(lo, 1, 101) <= logFraction(hi, 1, 101))
      return { valid: true, boundary: v === 0 }
    },
    { domain: "magnitudes 1e-4..1e6", minValidFraction: 1, minBoundary: 0 }
  )
  assert.equal(niceMax(0), 0)
  assert.equal(niceMax(-3), 0)
})

test("K1/K2: tile selection cycles within 1..n and tiles always get the minimum plot", () => {
  const n = RUN_TILES.length
  for (let i = -2; i <= n + 2; i++) {
    const c = clampTile(i, n)
    assert.ok(c >= 1 && c <= n)
    assert.equal(prevTile(nextTile(c, n), n), c)
  }
  let k = 1
  for (let i = 0; i < n; i++) k = nextTile(k, n)
  assert.equal(k, 1)
  for (const rows of [0, 10, 31, 60]) for (const paired of [true, false]) assert.ok(plotRows(tileRows(rows, n, paired)) >= CH.minPlotRows)
})

const genApp = (r: Rng): App => {
  const base = initial({ cols: r.pick([80, 120, 140, 160, 200]), rows: r.pick([24, 40, 44, 50, 60]) })
  return r.chance(0.5) ? update(update(base, { type: "key", key: " " }), { type: "tick", dtS: r.next() * CHART_SPAN_S }) : base
}

const CHART_KEYS = ["c", "1", "2", "3", "4", "5", "6", "\t", "\x1b[C", "\x1b[D", "l", "z", "\r", "[", "]", "{", "}", "j", "k", "G", "g", "\x1b", "p", "h"] as const

test("A5/A6: in any key sequence the selected tile stays in range, scrubbing keeps t on the axis and pauses, and frames stay exact", () => {
  law(
    "charts keys",
    120,
    (r) => ({ app: genApp(r), keys: Array.from({ length: r.int(1, 25) }, () => r.pick(CHART_KEYS)) }),
    ({ app, keys }) => {
      let a = onKey(app, "c")
      assert.equal(a.ui.overlay, "charts")
      for (const k of keys) {
        const before = a
        a = onKey(a, k)
        assert.ok((a.ui.chart ?? 1) >= 1 && (a.ui.chart ?? 1) <= RUN_TILES.length)
        if ("[]{}".includes(k)) {
          assert.ok(a.paused && a.t >= 0 && a.t <= CHART_SPAN_S)
          assert.ok(k === "[" || k === "{" ? a.t <= Math.max(0, before.t) : a.t >= before.t)
        }
      }
      const f = frame(stateAt(a.t, a.decision), a.ui, a.viewport.cols, a.viewport.rows, a.view)
      assert.equal(f.lines.length, a.viewport.rows)
      for (const l of f.lines) assert.equal(lineWidth(l), a.viewport.cols)
      return { valid: true, boundary: a.ui.zoom === true }
    },
    { domain: "random runs × 1–25 charts keys; 5 terminal sizes", minValidFraction: 1, minBoundary: 10 }
  )
})

test("A5: digits select tiles inside the charts view, and leaving and re-entering keeps the selection", () => {
  let a = onKey(initial({ cols: 140, rows: 44 }), "c")
  a = onKey(a, "4")
  assert.equal(a.ui.chart, 4)
  assert.equal(a.ui.overlay, "charts")
  a = onKey(onKey(a, "c"), "c")
  assert.equal(a.ui.chart, 4)
  a = onKey(a, "z")
  assert.equal(a.ui.zoom, true)
  const f = frame(stateAt(30, null), a.ui, 140, 44)
  assert.ok(f.lines.some((l) => plain(l).includes("ACTIVITY  (zoomed)")))
  assert.ok(!f.lines.some((l) => plain(l).includes("LEASE TIMELINE")))
  a = onKey(a, "\x1b")
  assert.equal(a.ui.overlay, null)
})

test("the charts frame is exact at every breakpoint, for every tile, zoomed or not", () => {
  law(
    "charts frame",
    80,
    // A fifth of the draws are below the minimum terminal (the "too small" frame): P(fewer than 3 in 80) < 1e-4.
    (r) => ({ cols: r.chance(0.2) ? r.int(1, 79) : r.pick([80, 100, 120, 140, 160, 200, r.int(80, 240)]), rows: r.pick([24, 30, 40, 50, 60, r.int(24, 80)]), chart: r.int(0, 8), zoom: r.chance(0.4), t: r.pick([-1, ...TIMELINE.instants, CHART_SPAN_S]), scroll: r.int(0, 100) }),
    ({ cols, rows, chart, zoom, t, scroll }) => {
      const f = frame(stateAt(t, null), { focus: 0, scroll, overlay: "charts", tick: 0, chart, zoom }, cols, rows)
      assert.equal(f.lines.length, Math.max(0, rows))
      for (const l of f.lines) assert.equal(lineWidth(l), cols)
      for (const l of f.lines) for (const ch of plain(l)) assert.ok(ch.codePointAt(0)! < 0x80 || ALLOWED.has(ch), `glyph ${ch}`)
      return { valid: true, boundary: f.breakpoint === null }
    },
    { domain: "terminals 60–240 × 10–80 (some below the minimum), tiles 0–8, zoom on/off, idle to end, scroll", minValidFraction: 1, minBoundary: 3 }
  )
})

const STATUSES = fixtureStatusBodies().map(parseBisectStatus)

test("clean scenario: 7 and c open the charts panel, and its frame is exact", () => {
  for (const k of ["7", "c"]) assert.equal(pressKey(START, k, STATUSES).focus, 7)
  law(
    "clean charts frame",
    40,
    (r) => ({ t: r.chance(0.3) ? 0 : r.pick([10, 20, 24, 30, 44]), cols: r.pick([80, 120, 140, 200, r.int(80, 240)]), rows: r.pick([24, 40, 60, r.int(24, 80)]) }),
    ({ t, cols, rows }) => {
      const st = pressKey(cleanStateAt(t, STATUSES), "7", STATUSES)
      const lines = cleanFrame(st, STATUSES, cols, rows, { kind: "fixed", ms: 0 })
      assert.equal(lines.length, rows)
      for (const l of lines) assert.equal(lineWidth(l), cols)
      return { valid: true, boundary: t === 0 }
    },
    { domain: "scripted instants; terminals 80–240 × 24–80", minValidFraction: 1, minBoundary: 2 }
  )
})

test("CC1: before the Bisect panel is opened the bisect charts are empty; then they grow one step at a time", () => {
  assert.equal(shownStatuses(START, STATUSES).length, 0)
  assert.equal(confidencePlot(START, STATUSES, 40, 6).started, false)
  assert.equal(probeRows(START, STATUSES, 40).length, 0)
  const opened = pressKey({ ...START, t: 1 }, "4", STATUSES)
  let prev = -1
  for (let k = 0; k <= BISECT.observations.length + 2; k++) {
    const st = { ...opened, t: 1 + (k * BISECT.stepMs) / 1000 }
    const n = shownStatuses(st, STATUSES).length
    assert.ok(n >= prev && n <= STATUSES.length)
    prev = n
  }
  assert.equal(prev, STATUSES.length)
})

test("CC2: the probes read from the route's tallies are the observations of the run", () => {
  const ps = probes(STATUSES).slice(1)
  assert.deepEqual(
    ps.map((p) => (p === null ? null : { n: p.n, failed: p.failed })),
    BISECT.observations.map((o) => ({ n: o.commit, failed: o.failed }))
  )
})
