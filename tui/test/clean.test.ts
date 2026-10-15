/**
 * The clean build-pipeline scenario (`--scenario clean`) and its recording.
 *
 * - W1 / I4. Every frame is exactly `rows` lines of exactly `cols` columns at
 *   80x24, 120x40, 140x40 and 200x60. So no line exceeds 140 columns at 140x40.
 * - G. Every frame draws only ASCII, box-drawing borders and the block logo:
 *   no status glyph (no check mark, bullet, diamond, arrow or ellipsis), no
 *   emoji and no wide character.
 * - I1. Two headless `--autoplay --fixed-time` runs are byte-identical, and
 *   the headless transcript exits 0. No `Math.random` anywhere in `src/`.
 * - I2. Every Wait+Screen literal of `tape/demo.tape` occurs exactly once in
 *   `src/`. Replaying the tape against the state machine, with random
 *   reaction delays, every wait is satisfied within its timeout, and no
 *   pattern is already on screen just before the key that should produce it.
 * - I3. After Ctrl+Q, a Sleep precedes any further Wait+Screen.
 * - I6. The final event stream has 25 rows of the allowed kinds, with no
 *   ERROR, FAILED or expired row, and its last row is the run-complete line.
 * - D. Keys 1-6 (and e) select the panels; q, Ctrl-Q and Ctrl-C quit; `a` and
 *   `n` are gated (M2).
 * - B. The Bisect panel shows the status bodies' figures unchanged: the
 *   displayed confidence is the body's confidence, so the panel computes no
 *   posterior.
 * - E. Build durations come from the lookup table only.
 * - Every `<Box>` opened in the clean components is closed.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { lineWidth, plain } from "../src/ansi.ts"
import { BOX, displayWidth } from "../src/glyphs.ts"
import { parseBisectStatus } from "../src/clean/bisectStatus.ts"
import { clockLabel, parseFixedTime } from "../src/clean/clock.ts"
import { bisectFigures, cleanEvents, fixtureStatusBodies, rebuildInputSet, rebuildMs } from "../src/clean/figures.ts"
import { BUILD_DURATIONS_MS } from "../src/clean/fixture.ts"
import { AUTOPLAY_END, AUTOPLAY_SCRIPT, initialApp, isQuitKey, onKey, onTick, pressKey, START, stateAt } from "../src/clean/model.ts"
import { cleanFrame } from "../src/clean/view.tsx"
import { visibleEvents } from "../src/panels/CleanPanels.tsx"
import { announce, law } from "./prop.ts"

announce("test/clean.test.ts")

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const SRC = join(ROOT, "src")
const STATUSES = fixtureStatusBodies().map(parseBisectStatus)
const FIXED = { kind: "fixed", ms: parseFixedTime("2026-10-14T12:00:00Z") } as const
const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
  { cols: 140, rows: 40 },
  { cols: 200, rows: 60 }
] as const

const screen = (st: ReturnType<typeof stateAt>, cols = 140, rows = 40): string => cleanFrame(st, STATUSES, cols, rows, FIXED).map(plain).join("\n")

const instants = (): number[] => {
  const ts: number[] = [0, 0.5, 1, 2]
  for (const k of AUTOPLAY_SCRIPT) ts.push(k.at, k.at + 0.3, k.at + 0.9, k.at + 1.5, k.at + 2.1, k.at + 3, k.at + 4.5)
  ts.push(AUTOPLAY_END)
  return ts
}

test("W1/I4: every frame is exactly rows x cols at 80x24, 120x40, 140x40 and 200x60", () => {
  for (const size of SIZES) {
    for (const t of instants()) {
      const lines = cleanFrame(stateAt(t, STATUSES), STATUSES, size.cols, size.rows, FIXED)
      assert.equal(lines.length, size.rows, `rows at t=${t} ${size.cols}x${size.rows}`)
      for (const [i, l] of lines.entries()) {
        assert.equal(lineWidth(l), size.cols, `line ${i} at t=${t} ${size.cols}x${size.rows}`)
        assert.equal(displayWidth(plain(l)), size.cols)
      }
    }
  }
  // Below the minimum: a message of the same exact size.
  const small = cleanFrame(START, STATUSES, 60, 20, FIXED)
  assert.equal(small.length, 20)
  for (const l of small) assert.equal(lineWidth(l), 60)
})

test("G: frames use only ASCII, box-drawing borders and the block logo (no status glyphs)", () => {
  const allowed = new Set([...Object.keys(BOX), "█", "┌", "┐", "└", "┘", "─", "│"])
  for (const t of instants()) {
    for (const ch of screen(stateAt(t, STATUSES))) {
      if (ch.codePointAt(0)! < 0x80) continue
      assert.ok(allowed.has(ch), `unexpected character ${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16)}) at t=${t}`)
    }
  }
})

test("I1: two headless autoplay runs with --fixed-time are byte-identical and exit 0", () => {
  const run = () =>
    execFileSync(process.execPath, ["src/main.ts", "--scenario", "clean", "--autoplay", "--fixed-time", "2026-10-14T12:00:00Z", "--no-color"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "" }
    })
  const a = run()
  const b = run()
  assert.equal(a, b)
  assert.ok(a.includes("2026-10-14T12:00:00Z"))
  assert.ok(a.includes("clean run complete"))
})

test("I1: the status-bar clock is pinned by --fixed-time and follows the wall clock without it", () => {
  assert.equal(clockLabel(FIXED, 0), "2026-10-14T12:00:00Z")
  assert.equal(clockLabel(FIXED, 30), "2026-10-14T12:00:00Z")
  const wall = { kind: "wall", startMs: FIXED.ms } as const
  assert.equal(clockLabel(wall, 61.9), "2026-10-14T12:01:01Z")
  assert.throws(() => parseFixedTime("yesterday"))
  assert.throws(() => parseFixedTime("2026-13-45T99:00:00Z"))
})

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })

test("E: no Math.random anywhere in src/ (the render path is deterministic)", () => {
  const offenders = sourceFiles(SRC).filter((f) => readFileSync(f, "utf8").includes("Math.random"))
  assert.deepEqual(offenders, [])
})

// ---------------------------------------------------------------------------
// The tape

type Cmd =
  | { readonly k: "type"; readonly text: string }
  | { readonly k: "sleep"; readonly s: number }
  | { readonly k: "wait"; readonly s: number; readonly pattern: string }
  | { readonly k: "enter" }
  | { readonly k: "ctrlq" }
  | { readonly k: "other"; readonly line: string }

const parseTape = (text: string): Cmd[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l): Cmd => {
      let m = /^Type "(.*)"$/.exec(l)
      if (m) return { k: "type", text: m[1]! }
      m = /^Sleep (\d+(?:\.\d+)?)s$/.exec(l)
      if (m) return { k: "sleep", s: Number(m[1]) }
      m = /^Wait\+Screen(?:@(\d+)s)? \/(.*)\/$/.exec(l)
      if (m) return { k: "wait", s: m[1] === undefined ? 30 : Number(m[1]), pattern: m[2]! }
      if (l === "Enter") return { k: "enter" }
      if (l === "Ctrl+Q") return { k: "ctrlq" }
      return { k: "other", line: l }
    })

const TAPE = parseTape(readFileSync(join(ROOT, "tape/demo.tape"), "utf8"))
const LAUNCH = TAPE.findIndex((c) => c.k === "type" && c.text.startsWith("node src/main.ts --scenario clean"))
/** The first Ctrl+Q after the clean launch (the tape also records the dashboard before and after it). */
const QUIT = TAPE.findIndex((c, i) => i > LAUNCH && c.k === "ctrlq")
/** The waits that run while the TUI is on screen (between launch and Ctrl+Q). */
const TUI_WAITS = TAPE.slice(LAUNCH, QUIT).flatMap((c) => (c.k === "wait" ? [c.pattern] : []))

test("I2: the tape launches the clean scenario with --fixed-time, quits with Ctrl+Q and has the storyboard's stops", () => {
  assert.ok(LAUNCH > 0 && QUIT > LAUNCH)
  const launch = TAPE[LAUNCH] as { text: string }
  assert.match(launch.text, /--fixed-time 2026-10-14T12:00:00Z/)
  assert.match(launch.text, /--autoplay/)
  const keys = TAPE.slice(LAUNCH + 1, QUIT).flatMap((c) => (c.k === "type" ? [c.text] : []))
  assert.deepEqual(keys, ["1", "2", "3", "4", "5", "6", "4", "a", "n", "6"])
  assert.equal(TUI_WAITS.length, 17)
})

test("I2: every Wait+Screen literal of the tape occurs exactly once in src/", () => {
  const files = sourceFiles(SRC).map((f) => ({ f, text: readFileSync(f, "utf8") }))
  for (const pattern of TUI_WAITS) {
    assert.ok(!/[\\^$.*+?()[\]{}|]/.test(pattern), `${pattern} is not a plain literal`)
    const hits = files.flatMap(({ f, text }) => text.split(pattern).length - 1 > 0 ? [`${f.slice(SRC.length)} x${text.split(pattern).length - 1}`] : [])
    const total = files.reduce((n, { text }) => n + text.split(pattern).length - 1, 0)
    assert.equal(total, 1, `${JSON.stringify(pattern)} occurs ${total} times: ${hits.join(", ")}`)
  }
})

const DT = 0.1
const POLL_S = 0.3

/**
 * Replay the tape against the state machine. `lag(i)` is an extra delay
 * (seconds) before command i, which models a slow recorder (capped at the
 * polling interval before a wait). Returns a list of
 * problems (empty = the tape works).
 */
const replay = (lag: (i: number) => number, cols = 140, rows = 40): string[] => {
  const problems: string[] = []
  let app = initialApp(true)
  const tick = (s: number) => {
    for (let i = 0; i < Math.round(s / DT); i++) app = onTick(app, DT, STATUSES)
  }
  const shown = () => screen(app.st, cols, rows)
  let beforeLastKey = ""
  for (let i = LAUNCH + 2; i < QUIT; i++) {
    const c = TAPE[i]!
    // A recorder may be late to send a key or start a sleep; between two
    // consecutive waits only its screen-polling interval (at most 0.3 s) passes.
    tick(c.k === "wait" ? Math.min(lag(i), POLL_S) : lag(i))
    if (c.k === "type") {
      beforeLastKey = shown()
      app = onKey(app, c.text, STATUSES)
    } else if (c.k === "sleep") {
      tick(c.s)
    } else if (c.k === "wait") {
      if (beforeLastKey.includes(c.pattern)) problems.push(`${c.pattern}: already on screen before the key that should produce it`)
      let waited = 0
      while (!shown().includes(c.pattern) && waited < c.s) {
        tick(DT)
        waited += DT
      }
      if (!shown().includes(c.pattern)) problems.push(`${c.pattern}: not on screen within ${c.s}s (t=${app.st.t.toFixed(1)}, panel ${app.st.focus})`)
    }
  }
  if (!isQuitKey("\x11")) problems.push("Ctrl+Q does not quit")
  return problems
}

test("I2: replaying the tape, every wait succeeds in time and no anchor fires early (no lag)", () => {
  assert.deepEqual(replay(() => 0), [])
  assert.deepEqual(replay(() => 0, 80, 24), [])
})

test("I2: the tape is robust to recorder lag (random delays of 0-1.5 s before each key and sleep)", () => {
  law(
    "tape replay with lag",
    40,
    (r) => ({ seed: r.int(0, 2 ** 31), max: r.pick([0.3, 0.8, 1.5]) }),
    ({ seed, max }) => {
      let a = seed >>> 0
      const lag = () => {
        a = (Math.imul(a, 1664525) + 1013904223) >>> 0
        return Math.round(((a / 2 ** 32) * max) / DT) * DT
      }
      assert.deepEqual(replay(lag), [])
      return { valid: true, boundary: max === 1.5 }
    },
    { domain: "lag 0-0.3/0.8/1.5 s per tape command", minValidFraction: 1, minBoundary: 3 }
  )
})

test("I2 catches a non-unique or early anchor (the check is not vacuous)", () => {
  // The footer always shows "approve": as an anchor it would already be on screen.
  const st = stateAt(29, STATUSES)
  assert.ok(screen(st).includes("approve"))
  // The header literal is on every frame after launch, including before key 1.
  assert.ok(screen(stateAt(2.9, STATUSES)).includes("FAME-XGA READY"))
  assert.ok(!screen(stateAt(2.9, STATUSES)).includes("ENVIRONMENT STATUS"))
})

test("I3: after Ctrl+Q a Sleep precedes any further Wait+Screen", () => {
  const after = TAPE.slice(QUIT + 1)
  const firstWait = after.findIndex((c) => c.k === "wait")
  assert.ok(firstWait > 0, "a wait for the shell prompt follows Ctrl+Q")
  assert.ok(after.slice(0, firstWait).some((c) => c.k === "sleep"), "Sleep between Ctrl+Q and the next Wait+Screen")
})

// ---------------------------------------------------------------------------
// Event stream, keys, bisect, durations

const ALLOWED_KINDS = new Set(["SYSTEM", "ENV", "ARTIFACT", "DEPS", "BUILD", "BISECT", "REVIEW", "NOTES", "COST"])

test("I6: the final event stream is 25 clean rows of the allowed kinds, ending with the run-complete line", () => {
  const st = stateAt(AUTOPLAY_END, STATUSES)
  const rows = visibleEvents(st, STATUSES)
  assert.equal(rows.length, 25)
  assert.equal(cleanEvents().length, 25)
  for (const e of rows) assert.ok(ALLOWED_KINDS.has(e.kind), e.kind)
  const text = screen(st, 140, 40)
  assert.ok(!/ERROR|FAILED|expired/.test(text))
  const eventLines = text.split("\n").filter((l) => /T\+\d/.test(l))
  assert.equal(eventLines.length, 25)
  assert.match(eventLines[eventLines.length - 1]!, /COST\s+clean run complete: \$0\.033 \(vs \$1\.32 GitHub Actions\)/)
  // Run-time labels never decrease.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.at.value >= rows[i - 1]!.at.value)
})

test("D: keys 1-6 and e select panels; q, Ctrl-Q and Ctrl-C quit; a and n are gated", () => {
  for (const k of ["1", "2", "3", "4", "5", "6"]) assert.equal(pressKey(START, k, STATUSES).focus, Number(k))
  assert.equal(pressKey(START, "e", STATUSES).focus, 6)
  for (const k of ["q", "\x11", "\x03"]) assert.ok(onKey(initialApp(false), k, STATUSES).quit)
  // `a` before convergence does nothing; `n` before approval does nothing.
  const early = pressKey({ ...START, t: 1 }, "4", STATUSES)
  assert.equal(pressKey(early, "a", STATUSES).approvedAt, null)
  assert.equal(pressKey(early, "n", STATUSES).noteAt, null)
  const converged = { ...early, t: early.t + 10 }
  const approved = pressKey(converged, "a", STATUSES)
  assert.equal(approved.approvedAt, converged.t)
  const noted = pressKey({ ...approved, t: approved.t + 1 }, "n", STATUSES)
  assert.equal(noted.noteAt, approved.t + 1)
  assert.equal(pressKey({ ...noted, t: noted.t + 5 }, "n", STATUSES).noteAt, noted.noteAt)
})

test("M3: autoplay presses the scripted keys until the keyboard takes over", () => {
  let app = initialApp(true)
  for (let i = 0; i < 120; i++) app = onTick(app, DT, STATUSES)
  assert.equal(app.st.focus, 2)
  app = onKey(app, "5", STATUSES)
  for (let i = 0; i < 200; i++) app = onTick(app, DT, STATUSES)
  assert.equal(app.st.focus, 5)
})

test("B: the Bisect panel displays the status body's figures unchanged", () => {
  for (const body of STATUSES) {
    const f = bisectFigures(body)
    assert.equal(f.confidence.value, body.status.confidence)
    assert.equal(f.steps.value, body.status.observations)
    assert.equal(f.range.value, body.candidates)
  }
  const last = STATUSES[STATUSES.length - 1]!
  assert.ok(bisectFigures(last).converged)
  assert.equal(bisectFigures(last).culprit, "#34")
  assert.match(screen(stateAt(24, STATUSES)), /confidence:\s+0\.962/)
  assert.throws(() => parseBisectStatus({ ...(fixtureStatusBodies()[0] as object), status: { done: "yes" } }))
})

test("E: build durations come from the constant lookup table keyed on the input set", () => {
  assert.equal(rebuildInputSet(), "src/core/graph.ts,src/core/scheduler.ts")
  assert.equal(rebuildMs(), BUILD_DURATIONS_MS["src/core/graph.ts,src/core/scheduler.ts"])
  assert.throws(() => rebuildMs("src/unknown.ts"), RangeError)
})

test("every <Box> opened in the clean components is closed", () => {
  for (const f of ["src/panels/CleanPanels.tsx", "src/clean/view.tsx"]) {
    const text = readFileSync(join(ROOT, f), "utf8")
    const opened = (text.match(/<Box\b[^>]*[^/]>/g) ?? []).length + (text.match(/<Box>/g) ?? []).length
    const closed = (text.match(/<\/Box>/g) ?? []).length
    assert.equal(opened, closed, `${f}: ${opened} <Box> opened, ${closed} closed`)
  }
})
