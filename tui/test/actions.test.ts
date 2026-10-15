/**
 * The simulated Cloudflare actions (src/actions.ts, SA1-SA6), the permanent
 * SIMULATED ACTIONS strip (L5), the overview (L6), the Cloudflare URIs panel
 * (key u) and the clean run's strip, plus a headless replay of the demo tape.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ACTIONS } from "../src/actions.ts"
import { plain } from "../src/ansi.ts"
import { initial, update, type App } from "../src/app.ts"
import { cleanActions } from "../src/clean/actions.ts"
import { parseBisectStatus } from "../src/clean/bisectStatus.ts"
import { fixtureStatusBodies } from "../src/clean/figures.ts"
import { CLEAN_STRIP } from "../src/clean/layout.ts"
import { AUTOPLAY_END, AUTOPLAY_SCRIPT, stateAt as cleanStateAt } from "../src/clean/model.ts"
import { cleanFrame } from "../src/clean/view.tsx"
import { BREAKPOINTS } from "../src/layout.ts"
import { visibleEvents } from "../src/panels/CleanPanels.tsx"
import { partsText, stateAt, TIMELINE, type Decision } from "../src/scenario.ts"
import { lockKey } from "../src/uris.ts"
import { frame, type Overlay } from "../src/view.tsx"
import { announce, law } from "./prop.ts"

announce("test/actions.test.ts")

const END = TIMELINE.review + TIMELINE.autoApproveDelay + 1
const decisions: ReadonlyArray<Decision> = [null, { kind: "approve", at: TIMELINE.review }, { kind: "reject", at: TIMELINE.review }]
const screen = (lines: ReadonlyArray<ReadonlyArray<{ readonly text: string }>>): string => lines.map((l) => plain(l)).join("\n")

test("SA1: every lock write of the timeline is one R2 PUT on its lock key, at its time, naming its ETag", () => {
  const all = ACTIONS.actionsAt(END, null)
  for (const w of TIMELINE.writes) {
    const hits = all.filter((a) => a.channel === "R2" && a.verb === "PUT" && a.t === w.t && a.target === lockKey(w.op) && partsText(a.detail).includes(w.etag))
    assert.equal(hits.length, 1, `${w.op} ${w.etag} at ${w.t}`)
    const text = partsText(hits[0]!.detail)
    assert.ok(w.ifMatch === null ? text.includes("If-None-Match: *") : text.includes(`If-Match: ${w.ifMatch}`), text)
  }
})

test("SA2: one FORK and one TOKEN per fork, one PUSH per pushed fork; approval merges, rejection closes the PR", () => {
  const st = stateAt(END, null)
  const all = ACTIONS.actionsAt(END, null)
  assert.equal(all.filter((a) => a.verb === "FORK").length, st.forks.length)
  assert.equal(all.filter((a) => a.verb === "TOKEN").length, st.forks.length)
  assert.equal(all.filter((a) => a.verb === "PUSH").length, st.forks.filter((f) => f.commit !== null).length)
  assert.equal(all.filter((a) => a.verb === "MERGE").length, 0)
  const approved = ACTIONS.actionsAt(END, { kind: "approve", at: TIMELINE.review })
  assert.equal(approved.filter((a) => a.verb === "MERGE").length, 1)
  const rejected = ACTIONS.actionsAt(END, { kind: "reject", at: TIMELINE.review })
  assert.equal(rejected.filter((a) => a.verb === "MERGE").length, 0)
  assert.ok(rejected.some((a) => a.verb === "PR" && a.status === "fail"))
})

test("SA3: the cold lookup misses, the publish uploads blobs then the manifest, the takeover hits and downloads", () => {
  const all = ACTIONS.actionsAt(END, null)
  const r2 = all.filter((a) => a.channel === "R2" && a.target.startsWith("v1/") && !a.target.startsWith("v1/lock/"))
  const kinds = r2.map((a) => `${a.verb}:${a.status}`)
  assert.deepEqual(kinds, ["GET:miss", "PUT:ok", "PUT:ok", "GET:ok", "GET:ok"])
  assert.ok(partsText(r2[1]!.detail).includes("uploaded") && partsText(r2[2]!.detail).includes("manifest"))
})

test("SA4: actionsAt is empty before the trigger, ordered by time, and a prefix of any later list", () => {
  const times = [-1, 0, ...TIMELINE.instants, END]
  law(
    "actions prefix",
    200,
    (r) => {
      const a = r.chance(0.5) ? r.pick(times) : r.next() * END
      const b = a + r.next() * END
      return { a, b, d: r.pick(decisions) }
    },
    ({ a, b, d }) => {
      const xa = ACTIONS.actionsAt(a, d)
      const xb = ACTIONS.actionsAt(b, d)
      if (a < 0) assert.equal(xa.length, 0)
      assert.deepEqual(xb.slice(0, xa.length), xa)
      for (let i = 1; i < xb.length; i++) assert.ok(xb[i - 1]!.t <= xb[i]!.t)
      assert.ok(xb.every((x) => x.t <= b))
      return { valid: true, boundary: a < 0 || times.includes(a) }
    },
    { domain: "times: idle, every instant, random; any decision", minValidFraction: 1, minBoundary: 20 }
  )
})

test("SA5: transfer progress is in [0, 1], monotone, 0 before the start and 1 after the end", () => {
  assert.ok(ACTIONS.transfers.length >= 2)
  for (const x of ACTIONS.transfers) {
    assert.equal(ACTIONS.transferProgress(x, x.from - 0.01), 0)
    assert.equal(ACTIONS.transferProgress(x, x.to), 1)
    let last = 0
    for (let t = x.from - 1; t <= x.to + 1; t += 0.05) {
      const f = ACTIONS.transferProgress(x, t)
      assert.ok(f >= 0 && f <= 1 && f >= last)
      last = f
    }
  }
})

test("SA6: one task per fork with progress in [0, 1]; a merged fork is at 1", () => {
  for (const t of [-1, ...TIMELINE.instants, END]) {
    for (const d of decisions) {
      const st = stateAt(t, d)
      const tasks = ACTIONS.tasksAt(st)
      assert.deepEqual(
        tasks.map((x) => x.fork),
        st.forks.map((f) => f.fork)
      )
      for (const x of tasks) assert.ok(x.progress >= 0 && x.progress <= 1)
      for (const f of st.forks.filter((f) => f.merged)) assert.equal(tasks.find((x) => x.fork === f.fork)!.progress, 1)
    }
  }
})

const VIEWS: ReadonlyArray<Overlay> = [null, "overview", "charts", "git", "notes", "help"]

test("L5: the SIMULATED ACTIONS strip is on screen in every view, at every breakpoint, whatever the scroll", () => {
  law(
    "strip everywhere",
    80,
    (r) => {
      const bp = r.pick(BREAKPOINTS)
      return { cols: bp.cols + r.int(0, 30), rows: bp.rows + r.int(0, 10), overlay: r.pick(VIEWS), t: r.pick([-1, ...TIMELINE.instants, END]), scroll: r.int(0, 200), focus: r.int(0, 7) }
    },
    ({ cols, rows, overlay, t, scroll, focus }) => {
      const f = frame(stateAt(t, null), { focus, scroll, overlay, tick: 0 }, cols, rows)
      assert.equal(f.lines.length, rows)
      const text = screen(f.lines)
      assert.ok(text.includes("SIMULATED ACTIONS"), `${cols}x${rows} ${overlay}`)
      return { valid: true, boundary: overlay === "overview" }
    },
    { domain: "sizes at and above the 4 breakpoints, every view, every instant, any scroll and focus", minValidFraction: 1, minBoundary: 5 }
  )
})

const TILE_TITLES = ["Monthly CI Cost Comparison", "Per-Run Cost Breakdown", "BUILD & AUDIT PROGRESS", "R2: LEASE LOCKS", "ARTIFACTS: Agent Forks", "CLOUDFLARE URIs", "EVENT STREAM", "R2 BUILD CACHE", "LEAN CI METRICS"]

test("L6: at 140x40 and larger the overview shows every panel's tile on one screen, without scrolling", () => {
  for (const [cols, rows] of [
    [140, 40],
    [160, 50],
    [200, 60]
  ] as const) {
    for (const t of [-1, 23, END]) {
      const f = frame(stateAt(t, { kind: "approve", at: TIMELINE.review }), { focus: 0, scroll: 0, overlay: "overview", tick: 0 }, cols, rows)
      const text = screen(f.lines)
      for (const title of TILE_TITLES) assert.ok(text.includes(title), `${title} at ${cols}x${rows}, t=${t}`)
      assert.ok(f.bodyLength <= f.bodyRows, `the overview scrolls at ${cols}x${rows}`)
    }
  }
})

test("keys: o toggles the overview, u (and 7) open the URIs panel, a panel key leaves the overview", () => {
  const key = (a: App, k: string) => update(a, { type: "key", key: k })
  let a = initial({ cols: 140, rows: 40 })
  a = key(a, "o")
  assert.equal(a.ui.overlay, "overview")
  a = key(a, "o")
  assert.equal(a.ui.overlay, null)
  a = key(key(a, "o"), "u")
  assert.equal(a.ui.overlay, null)
  assert.equal(a.ui.focus, 7)
  const f = frame(stateAt(30, null), a.ui, 140, 40)
  assert.ok(screen(f.lines).includes("CLOUDFLARE URIs: R2 + Artifacts"))
  assert.equal(key(initial({ cols: 140, rows: 40 }), "7").ui.focus, 7)
})

test("URIs panel: the bucket endpoint, every lock key, the trunk and one remote per fork", () => {
  const st = stateAt(END, { kind: "approve", at: TIMELINE.review })
  const a = update(initial({ cols: 200, rows: 60 }), { type: "key", key: "u" })
  const lines: string[] = []
  for (let scroll = 0; scroll < 200; scroll += 10) lines.push(screen(frame(st, { ...a.ui, scroll }, 200, 60).lines))
  const text = lines.join("\n")
  assert.ok(text.includes("r2.cloudflarestorage.com/cobuilds-demo"))
  for (const l of st.locks) assert.ok(text.includes(`r2://cobuilds-demo/${lockKey(l.op)}`), l.op)
  assert.ok(text.includes("artifacts.cloudflare.net/git/default/fame-xga.git"))
  for (const f of st.forks) assert.ok(text.includes(`fame-xga-${f.fork}.git`), f.fork)
})

const STATUSES = fixtureStatusBodies().map(parseBisectStatus)
/** The literals the demo tape waits for in the clean act (I2). */
const ANCHORS = [
  "FAME-XGA READY",
  "ENVIRONMENT STATUS",
  "DEPENDENCIES: NODE_MODULES CACHE",
  "STATE: RESTORING",
  "STATE: HIT",
  "INCREMENTAL BUILD",
  "BUILD: REBUILDING",
  "BAYESIAN BISECT",
  "BISECT: CONVERGED",
  "COORDINATION: LEASE",
  "HEARTBEAT: ALL AGENTS FRESH",
  "EVENT STREAM: CLEAN RUN",
  "awaiting approval",
  "APPROVAL GATE: press a",
  "REVIEW APPROVED",
  "GIT NOTE WRITTEN",
  "clean run complete"
]

test("clean strip: shown from CLEAN_STRIP.minRows rows, grows with the run, and never shows a tape anchor", () => {
  const clock = { kind: "fixed", ms: 0 } as const
  const times = [0, ...AUTOPLAY_SCRIPT.flatMap((k) => [k.at, k.at + 0.7, k.at + 2]), AUTOPLAY_END]
  let last = 0
  for (const t of times) {
    const st = cleanStateAt(t, STATUSES)
    const n = cleanActions(visibleEvents(st, STATUSES)).length
    assert.ok(n >= last)
    last = n
    const big = cleanFrame(st, STATUSES, 140, 40, clock)
    const small = cleanFrame(st, STATUSES, 140, CLEAN_STRIP.minRows - 1, clock)
    assert.equal(big.length, 40)
    assert.ok(screen(big).includes("SIMULATED ACTIONS"))
    assert.ok(!screen(small).includes("SIMULATED ACTIONS"))
    const strip = screen(big.slice(big.length - 3 - CLEAN_STRIP.rows, big.length - 3))
    for (const a of ANCHORS) assert.ok(!strip.includes(a), `${a} in the strip at t=${t}`)
  }
  assert.ok(last > 0)
})

test("demo tape: the headless preflight replays all three acts (dashboard, clean run, dashboard) without a failed checkpoint", () => {
  const tui = fileURLToPath(new URL("..", import.meta.url))
  const out = execFileSync(process.execPath, ["--import", "./src/ink/register.ts", "scripts/vhs-demo-preflight.ts", "tape/demo.tape", "--lag-runs", "3"], { cwd: tui, encoding: "utf8" })
  assert.match(out, /^OK /)
})
