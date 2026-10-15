#!/usr/bin/env node
/**
 * FAME-XGA Cobuilds TUI demo. Standalone: no runtime dependencies, and no
 * imports from the cobuild lock, cache client or Lean code of this repository.
 *
 *   node src/main.ts                       interactive (needs a TTY, at least 80×24)
 *   node src/main.ts --autoplay            plays the recording script by itself
 *   node src/main.ts --snapshot 52 --seed 7 [--cols 120 --rows 40 --no-color --ascii --scroll N
 *                                           --focus 1-7 --approve 55 --reject 55 --overlay notes|git|help|charts|overview --tick N
 *                                           --chart 1-6 --zoom]
 *                                          prints one frame at script time 52 s and exits
 *                                          (byte-identical for the same arguments)
 *   node src/main.ts --charts              interactive, opening on the charts view (graphs of the run; key c toggles it)
 *   node src/main.ts --overview            interactive, opening on the overview (every panel as a tile; key o toggles it)
 *   node src/main.ts --notes               the brief's figures against the derived ones
 *   node src/main.ts --narration           the demo script (docs/demo-script.md)
 *
 * Output policy: `--no-color`, a non-empty `NO_COLOR`, or `TERM=dumb` turn
 * colours off; `--ascii` or `TERM=dumb` use the ASCII glyph fallbacks;
 * `--no-anim`, `CI` or `TERM=dumb` turn blinking off.
 *
 * Live mode (Option A+): every panel title carries its provenance, [LIVE]
 * (data from the Worker in this session), [MEASURED] (read from a real
 * measurement) or [DEMO] (illustrative):
 *   COBUILDS_API_TOKEN=… node src/main.ts --live https://<worker> --context <ctx>
 *       [--artifacts-repo <name>] [--lean-audit <lake build log>]
 *     polls /api/locks (lock rows, and events derived from consecutive polls),
 *     /api/cache (cache summary) and /api/artifacts (the run's repository)
 *   node src/main.ts --snapshot 52 --locks-json response.json [--now-ms <ms>]
 *       [--prev-locks-json earlier.json] [--cache-json c.json] [--artifacts-json a.json] [--lean-audit log]
 *     the same frame from saved Worker responses (reproducible)
 */
import { register } from "node:module"
import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import { pathToFileURL } from "node:url"
import { parseFixedTime } from "./clean/clock.ts"

register("./ink/hooks.ts", import.meta.url)

export interface Args {
  readonly snapshot: number | null
  readonly seed: number | null
  readonly cols: number | null
  readonly rows: number | null
  readonly color: boolean
  readonly ascii: boolean
  readonly anim: boolean
  readonly autoplay: boolean
  readonly speed: number
  /** `--scroll N`; null when absent (a snapshot with `--focus N` then scrolls to panel N). */
  readonly scroll: number | null
  readonly focus: number
  readonly tick: number | null
  readonly approve: number | null
  readonly reject: number | null
  readonly overlay: null | "git" | "notes" | "help" | "charts" | "overview"
  /** Charts view: selected tile (`--chart N`) and zoom (`--zoom`). `--charts` is `--overlay charts`. */
  readonly chart: number
  readonly zoom: boolean
  readonly notes: boolean
  readonly narration: boolean
  readonly live: string | null
  readonly context: string | null
  readonly locksJson: string | null
  readonly nowMs: number | null
  readonly prevLocksJson: string | null
  readonly cacheJson: string | null
  readonly artifactsJson: string | null
  readonly artifactsRepo: string | null
  readonly leanAudit: string | null
  /** `failure` (default): the crash / takeover script. `clean`: the build-pipeline run of the storyboard. */
  readonly scenario: "failure" | "clean"
  /** `--fixed-time <iso8601>` in ms since the epoch: pins the status-bar clock. */
  readonly fixedTime: number | null
  /** `--session <id>`: the bisect session the clean scenario's live mode reads from the status route. */
  readonly session: string | null
}

const value = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const numArg = (argv: ReadonlyArray<string>, name: string): number | null => {
  const v = value(argv, name)
  if (v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} expects a number, got ${JSON.stringify(v)}`)
  return n
}

const truthy = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"

/** Parse the command line together with the environment's output policy. */
export const parseArgs = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>> = process.env): Args => {
  const dumb = env["TERM"] === "dumb"
  const overlay = value(argv, "--overlay") ?? (argv.includes("--charts") ? "charts" : argv.includes("--overview") ? "overview" : undefined)
  if (overlay !== undefined && overlay !== "git" && overlay !== "notes" && overlay !== "help" && overlay !== "charts" && overlay !== "overview")
    throw new Error(`--overlay expects git, notes, help, charts or overview, got ${JSON.stringify(overlay)}`)
  const scenario = value(argv, "--scenario") ?? "failure"
  if (scenario !== "failure" && scenario !== "clean") throw new Error(`--scenario expects failure or clean, got ${JSON.stringify(scenario)}`)
  const fixedIso = value(argv, "--fixed-time")
  const fixedTime = fixedIso === undefined ? null : parseFixedTime(fixedIso)
  const seed = numArg(argv, "--seed")
  if (seed !== null && !Number.isSafeInteger(seed)) throw new Error("--seed expects an integer")
  return {
    snapshot: numArg(argv, "--snapshot"),
    seed: seed === null ? null : seed >>> 0,
    cols: numArg(argv, "--cols"),
    rows: numArg(argv, "--rows"),
    color: !argv.includes("--no-color") && !(env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") && !dumb,
    ascii: argv.includes("--ascii") || dumb,
    anim: !argv.includes("--no-anim") && !truthy(env["CI"]) && !dumb,
    autoplay: argv.includes("--autoplay"),
    speed: numArg(argv, "--speed") ?? 1,
    scroll: numArg(argv, "--scroll"),
    focus: numArg(argv, "--focus") ?? 0,
    tick: numArg(argv, "--tick"),
    approve: numArg(argv, "--approve"),
    reject: numArg(argv, "--reject"),
    overlay: overlay ?? null,
    chart: numArg(argv, "--chart") ?? 1,
    zoom: argv.includes("--zoom"),
    notes: argv.includes("--notes"),
    narration: argv.includes("--narration"),
    live: value(argv, "--live") ?? null,
    context: value(argv, "--context") ?? null,
    locksJson: value(argv, "--locks-json") ?? null,
    prevLocksJson: value(argv, "--prev-locks-json") ?? null,
    cacheJson: value(argv, "--cache-json") ?? null,
    artifactsJson: value(argv, "--artifacts-json") ?? null,
    artifactsRepo: value(argv, "--artifacts-repo") ?? null,
    leanAudit: value(argv, "--lean-audit") ?? null,
    nowMs: numArg(argv, "--now-ms") ?? fixedTime,
    scenario,
    fixedTime,
    session: value(argv, "--session") ?? null
  }
}

/** Seed used when none is given: fixed for snapshots (reproducible), fresh for interactive runs (shown in the header). */
export const SNAPSHOT_DEFAULT_SEED = 1

const freshSeed = (): number => webcrypto.getRandomValues(new Uint32Array(1))[0]!

/** Escape sequences that restore the terminal: reset, show cursor, leave the alternate screen. */
export const RESTORE = "\x1b[0m\x1b[?25h\x1b[?1049l"
export const ENTER = "\x1b[?1049h\x1b[?25l\x1b[2J"

const main = async (): Promise<void> => {
  const a = parseArgs(process.argv.slice(2))
  const { render } = await import("./ansi.ts")
  const { INPUTS } = await import("./data.ts")
  const { dataNotes, format } = await import("./derive.ts")
  const { FIGURES, SCENARIO, stateAt } = await import("./scenario.ts")
  const { frame } = await import("./view.tsx")
  const { TICKS_PER_S } = await import("./layout.ts")
  const live = await import("./live.ts")
  const { W } = await import("./layout.ts")
  const W_EVENTS = W.events
  type LiveLockRow = import("./live.ts").LiveLock
  const mode = { color: a.color, ascii: a.ascii }

  if (a.notes) {
    const ns = dataNotes(INPUTS, FIGURES)
    const stated = (n: (typeof ns)[number]) => ("ref" in n.stated ? n.stated.ref : format(n.stated))
    process.stdout.write(
      ns.map((n) => `${n.verdict.padEnd(18)}  ${n.figure}: brief ${stated(n)}; derived ${n.derived === null ? "—" : format(n.derived)}. ${n.decision}`).join("\n") +
        `\n${ns.filter((n) => n.verdict !== "agrees").length} of ${ns.length} figures of the brief do not follow from its inputs; the panels show the derived values.\n`
    )
    return
  }
  if (a.narration) {
    const { narration } = await import("./narration.ts")
    process.stdout.write(narration(INPUTS, FIGURES, SCENARIO))
    return
  }

  if (a.scenario === "clean") {
    await cleanMain(a, mode)
    return
  }

  const decisionOf = (args: Args) =>
    args.approve !== null ? { kind: "approve" as const, at: args.approve } : args.reject !== null ? { kind: "reject" as const, at: args.reject } : null
  type LiveRows = ReturnType<typeof live.toLiveRows>
  const stateWith = (t: number, decision: ReturnType<typeof decisionOf>, rows: LiveRows | null) => (rows === null ? stateAt(t, decision) : live.withLiveLocks(stateAt(t, decision), rows))

  if (a.snapshot !== null) {
    const t = a.snapshot
    const feedLib = await import("./liveFeed.ts")
    const readJson = (f: string): unknown => JSON.parse(readFileSync(f, "utf8"))
    const decodable = (l: ReturnType<typeof live.parseLiveLocks>) => l.locks.filter((x): x is LiveLockRow => !("error" in x))
    let rows: LiveRows | null = null
    let events: ReturnType<typeof feedLib.diffLocks> = []
    if (a.locksJson !== null) {
      const parsed = live.parseLiveLocks(readJson(a.locksJson))
      for (const e of live.liveErrors(parsed)) process.stderr.write(`undecodable lock object: ${e}\n`)
      rows = live.toLiveRows(parsed, a.nowMs ?? Date.now(), t)
      const prev = a.prevLocksJson === null ? [] : decodable(live.parseLiveLocks(readJson(a.prevLocksJson)))
      events = feedLib.diffLocks(prev, decodable(parsed))
    }
    const anyFeed = a.locksJson !== null || a.cacheJson !== null || a.artifactsJson !== null || a.leanAudit !== null
    const feed = anyFeed
      ? feedLib.feedView({
          locksSeen: a.locksJson !== null,
          cache: a.cacheJson === null ? null : feedLib.parseLiveCache(readJson(a.cacheJson)),
          artifacts: a.artifactsJson === null ? null : feedLib.parseLiveArtifacts(readJson(a.artifactsJson)),
          leanAudit: a.leanAudit === null ? null : feedLib.parseLeanAudit(readFileSync(a.leanAudit, "utf8")),
          events: feedLib.appendEvents([], events, t, W_EVENTS)
        })
      : null
    const base = stateWith(t, decisionOf(a), rows)
    const st = feed === null ? base : feedLib.withLiveFeed(base, feed)
    const ui = { focus: a.focus, scroll: a.scroll ?? 0, overlay: a.overlay, tick: a.tick ?? Math.floor(t * TICKS_PER_S), chart: a.chart, zoom: a.zoom }
    const view = { seed: a.seed ?? SNAPSHOT_DEFAULT_SEED, anim: a.anim }
    // `--focus N` without `--scroll` scrolls to panel N, as pressing its key does.
    const anchor = a.focus >= 1 && a.scroll === null ? (frame(st, ui, a.cols ?? 120, a.rows ?? 40, view).anchors as Readonly<Record<number, number>>)[a.focus] ?? -1 : -1
    const f = frame(st, anchor >= 0 ? { ...ui, scroll: anchor } : ui, a.cols ?? 120, a.rows ?? 40, view)
    process.stdout.write(f.lines.map((l) => render(l, mode)).join("\n") + "\n")
    return
  }

  if (a.live !== null && (a.context === null || process.env["COBUILDS_API_TOKEN"] === undefined)) {
    process.stderr.write("--live needs --context <ctx> and the COBUILDS_API_TOKEN environment variable.\n")
    process.exit(2)
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("This demo needs an interactive terminal. Use --snapshot <seconds> for a single frame.\n")
    process.exit(2)
  }
  if (process.env["TERM"] === "dumb") {
    process.stderr.write("TERM=dumb has no cursor addressing, so the interactive dashboard cannot run. Use --snapshot <seconds> (plain text).\n")
    process.exit(2)
  }
  await interactive(a, mode)
}

const interactive = async (a: Args, mode: { readonly color: boolean; readonly ascii: boolean }): Promise<void> => {
  const { createElement, render } = await import("./ink/index.ts")
  const { initial, update } = await import("./app.ts")
  const { Dashboard } = await import("./Dashboard.tsx")
  const { stateAt } = await import("./scenario.ts")
  const { frame } = await import("./view.tsx")
  const live = await import("./live.ts")
  const feedLib = await import("./liveFeed.ts")
  const { W } = await import("./layout.ts")

  const out = process.stdout
  const seed = a.seed ?? freshSeed()
  const size = () => ({ cols: a.cols ?? out.columns ?? 80, rows: a.rows ?? out.rows ?? 24 })
  let liveRows: ReturnType<typeof live.toLiveRows> | null = null
  // Live feed state: what actually arrived from the Worker (provenance is derived from it).
  let locksSeen = false
  let prevLocks: ReadonlyArray<import("./liveFeed.ts").LockSnapshotEntry> = []
  let feedEvents: ReadonlyArray<import("./liveFeed.ts").FeedEvent> = []
  let liveCache: import("./liveFeed.ts").LiveCache | null = null
  let liveArtifacts: import("./liveFeed.ts").LiveArtifacts | null = null
  const leanAudit = a.leanAudit === null ? null : feedLib.parseLeanAudit(readFileSync(a.leanAudit, "utf8"))
  const start = size()
  let app = initial({ autoplay: a.autoplay, speed: a.speed, cols: start.cols, rows: start.rows, view: { seed, anim: a.anim }, ui: { overlay: a.overlay, chart: a.chart, zoom: a.zoom } })

  const tree = () => {
    const { cols, rows } = size()
    const base = liveRows === null ? stateAt(app.t, app.decision) : live.withLiveLocks(stateAt(app.t, app.decision), liveRows)
    const st =
      a.live === null && leanAudit === null
        ? base
        : feedLib.withLiveFeed(base, feedLib.feedView({ locksSeen, cache: liveCache, artifacts: liveArtifacts, leanAudit, events: feedEvents }))
    return createElement(Dashboard, { lines: frame(st, app.ui, cols, rows, app.view).lines, onKey })
  }
  let done = false
  const cleanup = (code: number, message?: string): never => {
    if (!done) {
      done = true
      clearInterval(timer)
      if (poller !== undefined) clearInterval(poller)
      instance.unmount()
      out.write(RESTORE)
      if (message !== undefined) process.stderr.write(message + "\n")
    }
    process.exit(code)
  }
  const onKey = (raw: string) => {
    app = update(app, { type: "key", key: raw })
    if (app.quit) cleanup(0)
    instance.rerender(tree())
  }

  out.write(ENTER)
  // Registered before `render`, so that the shim's own resize redraw (clear + draw) uses the reflowed tree.
  out.on("resize", () => {
    const { cols, rows } = size()
    app = update(app, { type: "resize", cols, rows })
    instance.rerender(tree())
  })
  const instance = render(tree(), { stdout: out, stdin: process.stdin, exitOnCtrlC: false, mode })
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    app = update(app, { type: "tick", dtS: (now - last) / 1000 })
    last = now
    instance.rerender(tree())
  }, 100)
  let poller: ReturnType<typeof setInterval> | undefined
  if (a.live !== null) {
    const url = a.live
    const token = process.env["COBUILDS_API_TOKEN"] ?? ""
    const context = a.context ?? ""
    const poll = () => {
      const tAtPoll = app.t
      const msAtPoll = Date.now()
      live
        .fetchLiveLocks(url, token, context)
        .then((l) => {
          liveRows = live.toLiveRows(l, msAtPoll, tAtPoll)
          const current = l.locks.filter((x): x is import("./live.ts").LiveLock => !("error" in x))
          feedEvents = feedLib.appendEvents(feedEvents, feedLib.diffLocks(prevLocks, current), tAtPoll, W.events)
          prevLocks = current
          locksSeen = true
        })
        .catch(() => {
          // Keep the last rows; a failed poll must not crash the dashboard.
        })
      feedLib
        .fetchLiveCache(url, token)
        .then((c) => {
          liveCache = c
        })
        .catch(() => {})
      if (a.artifactsRepo !== null) {
        feedLib
          .fetchLiveArtifacts(url, token, a.artifactsRepo)
          .then((r) => {
            liveArtifacts = r
          })
          .catch(() => {})
      }
    }
    poll()
    poller = setInterval(poll, 2000)
  }
  // Signals and crashes restore the terminal before exiting (128 + signal number, as shells report).
  process.on("SIGINT", () => cleanup(130))
  process.on("SIGTERM", () => cleanup(143))
  process.on("SIGHUP", () => cleanup(129))
  process.on("uncaughtException", (e) => cleanup(1, `fatal: ${e.stack ?? String(e)}`))
  process.on("unhandledRejection", (e) => cleanup(1, `fatal: ${String(e)}`))
}

/**
 * The clean build-pipeline scenario (`--scenario clean`):
 * - `--snapshot T`: the frame at script time T of the autoplay script;
 * - `--autoplay` with stdout not a terminal: the headless transcript (frames at
 *   fixed script times, then exit 0), which two runs with the same
 *   `--fixed-time` reproduce byte for byte;
 * - otherwise the interactive dashboard (keys 1-6, 7 or c for the charts, a, n, q / Ctrl-Q / Ctrl-C).
 */
const cleanMain = async (a: Args, mode: { readonly color: boolean; readonly ascii: boolean }): Promise<void> => {
  const { render } = await import("./ansi.ts")
  const { loadBisectStatus } = await import("./clean/bisectStatus.ts")
  const { fixtureStatusBodies } = await import("./clean/figures.ts")
  const model = await import("./clean/model.ts")
  const { cleanFrame } = await import("./clean/view.tsx")
  const token = process.env["COBUILDS_API_TOKEN"]
  if (a.live !== null && (a.session === null || token === undefined)) {
    process.stderr.write("--scenario clean --live needs --session <id> and the COBUILDS_API_TOKEN environment variable.\n")
    process.exit(2)
  }
  const statuses = await loadBisectStatus(
    a.live !== null && a.session !== null && token !== undefined
      ? { kind: "live", url: a.live, token, session: a.session }
      : { kind: "fixture", bodies: fixtureStatusBodies() }
  )
  const clock = a.fixedTime !== null ? ({ kind: "fixed", ms: a.fixedTime } as const) : ({ kind: "wall", startMs: Date.now() } as const)
  const print = (st: import("./clean/model.ts").CleanState, cols: number, rows: number) =>
    process.stdout.write(cleanFrame(st, statuses, cols, rows, clock).map((l) => render(l, mode)).join("\n") + "\n")

  if (a.snapshot !== null) {
    // `--focus N` (or `--charts`) opens panel N at the snapshot time, on top of the scripted keys.
    const base = model.stateAt(a.snapshot, statuses)
    const open = a.overlay === "charts" ? 7 : a.focus
    print(open >= 1 ? model.pressKey(base, String(open), statuses) : base, a.cols ?? 140, a.rows ?? 40)
    return
  }
  if (a.autoplay && !process.stdout.isTTY) {
    for (const t of headlessTimes(model.AUTOPLAY_SCRIPT, model.AUTOPLAY_END)) {
      const st = model.stateAt(t, statuses)
      process.stdout.write(`--- t=${t.toFixed(1)}s panel=${st.focus} ---\n`)
      print(st, a.cols ?? 140, a.rows ?? 40)
    }
    process.stdout.write("--- transcript end ---\n")
    return
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("This demo needs an interactive terminal. Use --snapshot <seconds>, or --autoplay with output redirected for the transcript.\n")
    process.exit(2)
  }
  const { createElement, render: inkRender } = await import("./ink/index.ts")
  const { Dashboard } = await import("./Dashboard.tsx")
  const out = process.stdout
  const size = () => ({ cols: a.cols ?? out.columns ?? 80, rows: a.rows ?? out.rows ?? 24 })
  // `--charts` (or `--focus N`) opens that panel at launch; the keys work as usual from there.
  const launchPanel = a.overlay === "charts" ? 7 : a.focus
  let app = model.initialApp(a.autoplay)
  if (launchPanel >= 1) app = { ...app, st: model.pressKey(app.st, String(launchPanel), statuses) }
  const tree = () => {
    const { cols, rows } = size()
    return createElement(Dashboard, { lines: cleanFrame(app.st, statuses, cols, rows, clock), onKey })
  }
  let done = false
  const cleanup = (code: number, message?: string): never => {
    if (!done) {
      done = true
      clearInterval(timer)
      instance.unmount()
      out.write(RESTORE)
      if (message !== undefined) process.stderr.write(message + "\n")
    }
    process.exit(code)
  }
  const onKey = (raw: string) => {
    app = model.onKey(app, raw, statuses)
    if (app.quit) cleanup(0)
    instance.rerender(tree())
  }
  out.write(ENTER)
  out.on("resize", () => instance.rerender(tree()))
  const instance = inkRender(tree(), { stdout: out, stdin: process.stdin, exitOnCtrlC: false, mode })
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    app = model.onTick(app, (now - last) / 1000, statuses)
    last = now
    instance.rerender(tree())
  }, 100)
  process.on("SIGINT", () => cleanup(130))
  process.on("SIGTERM", () => cleanup(143))
  process.on("SIGHUP", () => cleanup(129))
  process.on("uncaughtException", (e) => cleanup(1, `fatal: ${e.stack ?? String(e)}`))
  process.on("unhandledRejection", (e) => cleanup(1, `fatal: ${String(e)}`))
}

/**
 * Script times of the headless transcript: just before the first key, then
 * for each scripted key half a second after it (intermediate states such as
 * RESTORING) and just before the next one (settled states), and the end.
 */
export const headlessTimes = (script: ReadonlyArray<{ readonly at: number }>, end: number): number[] => {
  const ts: number[] = [Math.max(0, (script[0]?.at ?? end) - 0.1)]
  script.forEach((k, i) => {
    const nextAt = script[i + 1]?.at ?? end
    ts.push(k.at + 0.5, nextAt - 0.1)
  })
  ts.push(end)
  return ts
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  })
}
