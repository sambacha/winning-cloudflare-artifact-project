/**
 * The key/tick/resize reducer (`src/app.ts`, rules A1–A4): invariants after
 * every step of random sessions, replay, the review gate, autoplay at any
 * tick size, and the independence of the demo from the rest of the
 * repository.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { type App, bodyMetrics, initial, type Msg, SPEEDS, update } from "../src/app.ts"
import { stateAt, TIMELINE } from "../src/scenario.ts"
import { maxScroll } from "../src/view.tsx"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/app.test.ts")

const KEYS = [" ", "1", "2", "3", "4", "5", "e", "a", "r", "w", "n", "h", "?", "j", "k", "\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "f", "b", "g", "G", "+", "-", "p", "\x1b", "x", "c", "6", "z", "\r", "\t", "l", "\x1b[C", "\x1b[D", "[", "]", "{", "}"] as const

const genResize = (r: Rng): Msg => ({ type: "resize", cols: r.pick([1, 79, 80, 120, 160, 200, r.int(60, 240)]), rows: r.pick([1, 23, 24, 40, 50, 60, r.int(10, 80)]) })

/** Half of the sessions start at the review gate, so that decisions (the rare branch) are exercised. */
const genSession = (r: Rng): { start: App; msgs: Msg[] } => {
  const base = initial({ cols: r.pick([80, 120, 160, 200]), rows: r.pick([24, 40, 50, 60]) })
  const start = r.chance(0.5) ? update(update(base, { type: "key", key: " " }), { type: "tick", dtS: TIMELINE.review + r.pick([-0.5, 0, 0.5, 3]) }) : base
  const msgs = Array.from({ length: r.int(1, 30) }, (): Msg =>
    r.chance(0.5) ? { type: "tick", dtS: r.chance(0.2) ? r.pick([0, 0.1, 5, 20]) : r.next() } : r.chance(0.1) ? genResize(r) : { type: "key", key: r.pick(KEYS) }
  )
  // At the gate, half of the sessions decide first (otherwise a/r are 2 of 28 keys and decisions are rare).
  return { start, msgs: start.t >= 0 && r.chance(0.5) ? [{ type: "key", key: r.pick(["a", "r"]) }, ...msgs] : msgs }
}

const invariant = (app: App): void => {
  const m = bodyMetrics(app)
  assert.ok(app.ui.scroll >= 0 && app.ui.scroll <= maxScroll(m.length, m.rows), `scroll ${app.ui.scroll} outside [0, ${maxScroll(m.length, m.rows)}]`)
  assert.ok(app.ui.focus >= 0 && app.ui.focus <= 6)
  assert.ok((SPEEDS as ReadonlyArray<number>).includes(app.speed))
  if (app.decision !== null) assert.ok(app.decision.at >= TIMELINE.review, "decision taken before the review gate opened")
}

test("A1/A2: after every step of a random session the state is valid (scroll within the body, focus, speed, review gate)", () => {
  law(
    "session invariants",
    50,
    genSession,
    ({ start, msgs }) => {
      let decided = false
      msgs.reduce((app, m) => {
        const next = update(app, m)
        if (next.quit) return next
        invariant(next)
        decided = decided || next.decision !== null
        return next
      }, start)
      return { valid: true, boundary: decided }
    },
    { domain: "half from the review gate (review + {−0.5,0,0.5,3} s); 1–30 messages: ticks (dt ∈ [0,1) ∪ {0,0.1,5,20} s), 28 keys, resizes 1×1–240×80", minValidFraction: 1, minBoundary: 5 }
  )
})

test("A1 rejects a reducer that scrolls without clamping", () => {
  const unclamped = (scroll: number, key: string) => (key === "j" ? scroll + 1 : key === "k" ? scroll - 1 : scroll)
  assert.equal(refutes(300, (r) => Array.from({ length: r.int(1, 40) }, () => r.pick(["j", "k"])), (keys) => keys.reduce((sc, k) => unclamped(sc, k), 0) >= 0), true)
})

test("A4: a resize keeps time, decision, focus, overlay, speed and pause, and clamps the scroll to the new body", () => {
  law(
    "resize preserves state",
    60,
    (r) => ({ s: genSession(r), resize: genResize(r) }),
    ({ s, resize }) => {
      const before = s.msgs.reduce((a, m) => (a.quit ? a : update(a, m)), s.start)
      if (before.quit) return { valid: false, boundary: false }
      const after = update(before, resize)
      assert.equal(after.t, before.t)
      assert.deepEqual(after.decision, before.decision)
      assert.equal(after.ui.focus, before.ui.focus)
      assert.equal(after.ui.overlay, before.ui.overlay)
      assert.equal(after.speed, before.speed)
      assert.equal(after.paused, before.paused)
      assert.deepEqual(after.viewport, { cols: (resize as { cols: number }).cols, rows: (resize as { rows: number }).rows })
      invariant(after)
      // Resizing back restores a valid state too (80×24 → 200×60 → 80×24).
      invariant(update(after, { type: "resize", cols: before.viewport.cols, rows: before.viewport.rows }))
      return { valid: true, boundary: after.ui.scroll < before.ui.scroll }
    },
    { domain: "random session, then a resize to 1×1–240×80 (edges included)", minValidFraction: 0.9, minBoundary: 2 }
  )
})

test("replay: the same session gives the same final state", () => {
  law(
    "session replay",
    30,
    genSession,
    ({ start, msgs }) => {
      const run = () => msgs.reduce(update, start)
      assert.deepEqual(run(), run())
      return { valid: true, boundary: msgs.some((m) => m.type === "key" && (m.key === "a" || m.key === "r")) }
    },
    { domain: "as for the session law", minValidFraction: 1, minBoundary: 3 }
  )
})

test("A2: approve/reject before the gate are no-ops; at or after it they decide; SPACE restarts the run", () => {
  law(
    "review gate",
    100,
    (r) => ({ offset: r.pick([-5, -0.1, 0, 0.1, 3, r.next() * 10 - 5]), key: r.pick(["a", "r"] as const) }),
    ({ offset, key }) => {
      const at = update(update(initial(), { type: "key", key: " " }), { type: "tick", dtS: TIMELINE.review + offset })
      const decided = update(at, { type: "key", key })
      if (at.t < TIMELINE.review) assert.equal(decided.decision, null)
      else assert.deepEqual(decided.decision, { kind: key === "a" ? "approve" : "reject", at: at.t })
      const restarted = update(decided, { type: "key", key: " " })
      assert.equal(restarted.t, 0)
      assert.equal(restarted.decision, null)
      return { valid: true, boundary: offset === 0 }
    },
    { domain: "keys a/r at review + {−5, −0.1, 0, 0.1, 3, random} s", minValidFraction: 1, minBoundary: 5 }
  )
  assert.equal(update(initial(), { type: "key", key: "q" }).quit, true)
  assert.equal(update(initial(), { type: "key", key: "\x03" }).quit, true)
})

test("A3: autoplay triggers after the idle delay and approves the configured delay after the gate opens, at any tick size", () => {
  law(
    "autoplay",
    30,
    // Boundaries (exactly 0.05 or 1) had p = 0.2: P(fewer than 2 in 30) = 1%. 30% of draws now go to them.
    (r) => (r.chance(0.3) ? r.pick([0.05, 1]) : r.pick([0.05, 0.1, 0.25, 0.5, 1]) * (r.chance(0.5) ? 1 : 1 + r.next() * 0.1)),
    (dt) => {
      const horizon = TIMELINE.autoTriggerIdle + TIMELINE.review + TIMELINE.autoApproveDelay + 5
      const steps = Math.ceil(horizon / dt)
      let app = initial({ autoplay: true })
      let triggeredAfter = -1
      for (let i = 0; i < steps; i++) {
        app = update(app, { type: "tick", dtS: dt })
        if (triggeredAfter < 0 && app.t >= 0) triggeredAfter = (i + 1) * dt
      }
      assert.ok(triggeredAfter >= TIMELINE.autoTriggerIdle - 1e-9 && triggeredAfter < TIMELINE.autoTriggerIdle + dt + 1e-9)
      assert.deepEqual(app.decision, { kind: "approve", at: TIMELINE.review + TIMELINE.autoApproveDelay })
      assert.equal(stateAt(app.t, app.decision).finished, true)
      return { valid: true, boundary: dt === 1 || dt === 0.05 }
    },
    { domain: "tick sizes {0.05,0.1,0.25,0.5,1} s, half jittered by up to 10%", minValidFraction: 1, minBoundary: 2 }
  )
})

// ---------------------------------------------------------------------------
// Independence

/** Every import specifier of a source text. */
const imports = (src: string): string[] =>
  [...src.matchAll(/(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!)

const TUI = fileURLToPath(new URL("..", import.meta.url))

/** An import stays inside the demo: a Node built-in, a `#` import of the package, or a relative path that resolves inside tui/src or tui/test. */
const insideDemo = (spec: string, from: string): boolean => {
  if (spec.startsWith("node:") || spec.startsWith("#ink/")) return true
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false
  const target = resolve(dirname(from), spec)
  return target.startsWith(join(TUI, "src") + sep) || target.startsWith(join(TUI, "test") + sep)
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? (f === "golden" || f === "fixtures" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : []
  })

test("independence: the demo imports only its own files and Node built-ins; TypeScript is a dev dependency only", () => {
  const dir = TUI
  const files = [...walk(join(dir, "src")), ...walk(join(dir, "test"))]
  const specs = files.flatMap((f) => imports(readFileSync(f, "utf8")).map((spec) => ({ f, spec })))
  assert.ok(specs.length > 40, "the import scan found too few imports to be meaningful")
  specs.forEach(({ f, spec }) => assert.ok(insideDemo(spec, f), `${f} imports ${spec}`))
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: unknown; devDependencies?: Record<string, string>; packageManager?: string }
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies")
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ["@types/node", "typescript"])
  // The repository uses npm (`ts/package-lock.json`, `npm ci` in CI); no package manager is pinned to pnpm.
  assert.ok(pkg.packageManager === undefined || /^npm@/.test(pkg.packageManager), `unexpected packageManager ${pkg.packageManager}`)
})

test("the independence check rejects imports of the lock, the cache client and npm packages", () => {
  // The bad imports live in a text fixture, so that the scan of the real sources does not see them.
  const fixture = readFileSync(new URL("./fixtures/bad-imports.txt", import.meta.url), "utf8").split("\n").filter((l) => l.trim() !== "")
  assert.ok(fixture.length >= 4)
  for (const bad of fixture) {
    const specs = imports(bad)
    assert.equal(specs.length, 1, bad)
    assert.equal(insideDemo(specs[0]!, join(TUI, "test", "x.test.ts")), false, bad)
  }
})
