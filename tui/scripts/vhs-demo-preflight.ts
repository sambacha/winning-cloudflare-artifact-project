/**
 * Headless preflight of a VHS tape (default: tape/demo-mp4.tape), run before
 * anything is recorded:
 *
 *   node --import ./src/ink/register.ts scripts/vhs-demo-preflight.ts [tape] [--lag-runs N] [--duration]
 *
 * It replays the tape against the TUI's pure state machines (src/app.ts for
 * the dashboard, src/clean/model.ts for the clean run): `Type` of a
 * `node src/main.ts ...` line followed by `Enter` launches that program with
 * the same arguments, the other `Type` characters are keys, `Sleep` advances
 * the clock in 100 ms ticks as the real program does, and `Ctrl+Q` quits.
 * At every `# expect: A | B | ...` comment the current frame must contain each
 * literal. The replay runs once without lag and `--lag-runs` times (default 20)
 * with a random recorder delay of 0-1.5 s before every command, which is how a
 * loaded machine running VHS behaves.
 *
 * `Wait+Screen[@T] /pattern/` waits, like VHS, until the pattern is on the
 * running program's screen, for at most T (default 30 s); a wait that would
 * time out is reported (VHS would abort the recording there). Waits while no
 * program runs (the shell prompt, SETUP COMPLETE) are taken as satisfied.
 * `Screenshot` and `Wait` (prompt) lines are accepted and need no model.
 *
 * `--frames DIR` writes the screen of every checkpoint of the lag-free replay
 * to DIR/NN-line-L.txt (plain text), so the storyboard can be read without
 * recording anything.
 *
 * `--duration` prints the expected length in seconds of the visible part of
 * the recording (Sleeps and typing after `Show`) and exits. `--timeline`
 * prints, for every checkpoint, the time in the recording at which it is on
 * screen, its tape line and its literals (tab-separated), and exits.
 *
 * Exit status: 0 if every expectation holds in every run, 1 otherwise.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "../src/main.ts"
import { initial, update, type App } from "../src/app.ts"
import { stateAt } from "../src/scenario.ts"
import { frame } from "../src/view.tsx"
import { render } from "../src/ansi.ts"
import * as clean from "../src/clean/model.ts"
import { cleanFrame } from "../src/clean/view.tsx"
import { loadBisectStatus } from "../src/clean/bisectStatus.ts"
import { fixtureStatusBodies } from "../src/clean/figures.ts"

type Cmd =
  | { readonly kind: "type"; readonly text: string; readonly line: number }
  | { readonly kind: "enter"; readonly line: number }
  | { readonly kind: "sleep"; readonly s: number; readonly line: number }
  | { readonly kind: "quit"; readonly line: number }
  | { readonly kind: "show" | "hide"; readonly line: number }
  | { readonly kind: "expect"; readonly literals: ReadonlyArray<string>; readonly line: number }
  | { readonly kind: "wait"; readonly pattern: string; readonly s: number; readonly line: number }

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const tapePath = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && (argv[i - 1] === "--lag-runs" || argv[i - 1] === "--frames"))) ?? "tape/demo-mp4.tape"
const framesDir = flag("--frames") ?? null
const lagRuns = Number(flag("--lag-runs") ?? "20")

const seconds = (v: string): number => {
  const m = /^([0-9.]+)(ms|s|m)?$/.exec(v)
  if (m === null) throw new Error(`cannot read the duration ${v}`)
  const n = Number(m[1])
  return m[2] === "ms" ? n / 1000 : m[2] === "m" ? n * 60 : n
}

const unquote = (s: string): string => {
  const q = s[0]
  if ((q === '"' || q === "'" || q === "`") && s.endsWith(q!)) return s.slice(1, -1)
  throw new Error(`cannot read the string ${s}`)
}

/** Parse the commands this preflight understands; any other command makes it fail (it would not know what VHS does). */
const parseTape = (text: string): { readonly cmds: ReadonlyArray<Cmd>; readonly typingS: number } => {
  const cmds: Cmd[] = []
  let typingS = 0.04
  text.split("\n").forEach((raw, i) => {
    const line = i + 1
    const s = raw.trim()
    const ex = /^#\s*expect:\s*(.*)$/.exec(s)
    if (ex !== null) {
      cmds.push({ kind: "expect", literals: ex[1]!.split("|").map((x) => x.trim()).filter((x) => x !== ""), line })
      return
    }
    if (s === "" || s.startsWith("#") || s.startsWith("Output ") || s.startsWith("Source ") || s.startsWith("Require ")) return
    if (s.startsWith("Set ")) {
      const m = /^Set TypingSpeed (\S+)$/.exec(s)
      if (m !== null) typingS = seconds(m[1]!)
      return
    }
    const ty = /^Type(@\S+)? (.*)$/.exec(s)
    if (ty !== null) return void cmds.push({ kind: "type", text: unquote(ty[2]!), line })
    const sl = /^Sleep (\S+)$/.exec(s)
    if (sl !== null) return void cmds.push({ kind: "sleep", s: seconds(sl[1]!), line })
    if (s === "Enter") return void cmds.push({ kind: "enter", line })
    if (s === "Ctrl+Q") return void cmds.push({ kind: "quit", line })
    if (s === "Show") return void cmds.push({ kind: "show", line })
    if (s === "Hide") return void cmds.push({ kind: "hide", line })
    const wt = /^Wait\+Screen(?:@(\S+))? \/(.*)\/$/.exec(s)
    if (wt !== null) return void cmds.push({ kind: "wait", pattern: wt[2]!, s: wt[1] === undefined ? 30 : seconds(wt[1]), line })
    if (s === "Wait" || s.startsWith("Screenshot ")) return
    throw new Error(`${tapePath}:${line}: the preflight does not model "${s}"`)
  })
  // Source "tape/common.tape" sets TypingSpeed; read it from there when the tape itself does not.
  const src = /^Source "(.*)"$/m.exec(text)
  if (src !== null && !/^Set TypingSpeed/m.test(text)) {
    const m = /^Set TypingSpeed (\S+)$/m.exec(readFileSync(src[1]!, "utf8"))
    if (m !== null) typingS = seconds(m[1]!)
  }
  return { cmds, typingS }
}

const { cmds, typingS } = parseTape(readFileSync(tapePath, "utf8"))

if (argv.includes("--duration") || argv.includes("--timeline")) {
  let shown = false
  let total = 0
  const marks: string[] = []
  for (const c of cmds) {
    if (c.kind === "show") shown = true
    if (c.kind === "hide") shown = false
    if (!shown) continue
    if (c.kind === "sleep") total += c.s
    if (c.kind === "type") total += c.text.length * typingS
    if (c.kind === "enter" || c.kind === "quit") total += typingS
    // A checkpoint is still on screen half a second before it is checked.
    if (c.kind === "expect") marks.push(`${Math.max(0, total - 0.5).toFixed(1)}\t${c.line}\t${c.literals.join(" | ")}`)
  }
  process.stdout.write(argv.includes("--timeline") ? marks.join("\n") + "\n" : `${total.toFixed(1)}\n`)
  process.exit(0)
}

const statuses = await loadBisectStatus({ kind: "fixture", bodies: fixtureStatusBodies() })
const MODE = { color: false, ascii: false }

/** A running program of the replay: keys and ticks in, the current screen out. */
interface Program {
  key(k: string): void
  tick(dtS: number): void
  screen(): string
  readonly quit: boolean
}

const launch = (commandLine: string): Program => {
  const words = commandLine.trim().split(/\s+/)
  if (words[0] !== "node" || words[1] !== "src/main.ts") throw new Error(`not a TUI command: ${commandLine}`)
  const a = parseArgs(words.slice(2), { TERM: "xterm-256color" })
  const cols = a.cols ?? 140
  const rows = a.rows ?? 40
  if (a.scenario === "clean") {
    const clock = a.fixedTime !== null ? ({ kind: "fixed", ms: a.fixedTime } as const) : ({ kind: "wall", startMs: 0 } as const)
    let app = clean.initialApp(a.autoplay)
    const launchPanel = a.overlay === "charts" ? 7 : a.focus
    if (launchPanel >= 1) app = { ...app, st: clean.pressKey(app.st, String(launchPanel), statuses) }
    return {
      key: (k) => void (app = clean.onKey(app, k, statuses)),
      tick: (dt) => void (app = clean.onTick(app, dt, statuses)),
      screen: () => cleanFrame(app.st, statuses, cols, rows, clock).map((l) => render(l, MODE)).join("\n"),
      get quit() {
        return app.quit
      }
    }
  }
  let app: App = initial({
    autoplay: a.autoplay,
    speed: a.speed,
    cols,
    rows,
    view: { seed: a.seed ?? 1, anim: false },
    ui: { overlay: a.overlay, chart: a.chart, zoom: a.zoom }
  })
  return {
    key: (k) => void (app = update(app, { type: "key", key: k })),
    tick: (dt) => void (app = update(app, { type: "tick", dtS: dt })),
    screen: () =>
      frame(stateAt(app.t, app.decision), app.ui, cols, rows, app.view)
        .lines.map((l) => render(l, MODE))
        .join("\n"),
    get quit() {
      return app.quit
    }
  }
}

/** Replay the tape once; `lag()` is the recorder's extra delay before a command. Returns the failed expectations. */
const replay = (lag: () => number, frames: string[] | null = null): string[] => {
  const problems: string[] = []
  let prog: Program | null = null
  let typed = ""
  const advance = (s: number) => {
    // The real program ticks every 100 ms of wall time.
    let left = s
    while (left > 1e-9) {
      const dt = Math.min(0.1, left)
      prog?.tick(dt)
      left -= dt
    }
  }
  for (const c of cmds) {
    if (c.kind === "expect") {
      if (prog === null) {
        problems.push(`${tapePath}:${c.line}: expect with no program running`)
        continue
      }
      const sc = prog.screen()
      frames?.push(`${String(frames.length + 1).padStart(2, "0")}-line-${c.line}.txt\n${sc}`)
      for (const lit of c.literals) if (!sc.includes(lit)) problems.push(`${tapePath}:${c.line}: "${lit}" is not on screen`)
      continue
    }
    if (c.kind === "wait") {
      if (prog === null) continue
      const re = /[\\^$.*+?()[\]{}|]/.test(c.pattern) ? new RegExp(c.pattern, "m") : null
      const seen = () => (re === null ? prog!.screen().includes(c.pattern) : re.test(prog!.screen()))
      let waited = 0
      while (!seen() && waited < c.s) {
        advance(0.1)
        waited += 0.1
      }
      if (!seen()) problems.push(`${tapePath}:${c.line}: Wait+Screen /${c.pattern}/ would time out after ${c.s} s`)
      continue
    }
    if (c.kind === "show" || c.kind === "hide") continue
    advance(lag())
    switch (c.kind) {
      case "type":
        for (const ch of c.text) {
          if (prog !== null) prog.key(ch)
          else typed += ch
          advance(typingS)
          if (prog?.quit === true) prog = null
        }
        break
      case "enter":
        if (prog === null && /^node src\/main\.ts /.test(typed)) prog = launch(typed)
        else if (prog !== null) prog.key("\r")
        typed = ""
        break
      case "quit":
        if (prog !== null) {
          prog.key("\x11")
          if (!prog.quit) problems.push(`${tapePath}:${c.line}: Ctrl+Q did not quit`)
          prog = null
        }
        break
      case "sleep":
        advance(c.s)
        break
    }
  }
  if (prog !== null) problems.push(`${tapePath}: the tape ends with the TUI still running (add Ctrl+Q)`)
  return problems
}

const expects = cmds.filter((c) => c.kind === "expect")
const literals = expects.reduce((n, c) => n + (c.kind === "expect" ? c.literals.length : 0), 0)
if (expects.length === 0) {
  process.stdout.write(`FAIL ${tapePath} has no "# expect:" comments, so nothing would be checked\n`)
  process.exit(1)
}

let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) >>> 0
  return seed / 2 ** 32
}

const failures: string[] = []
const shots: string[] | null = framesDir === null ? null : []
const base = replay(() => 0, shots)
if (framesDir !== null && shots !== null) {
  mkdirSync(framesDir, { recursive: true })
  for (const f of shots) {
    const nl = f.indexOf("\n")
    writeFileSync(join(framesDir, f.slice(0, nl)), f.slice(nl + 1) + "\n")
  }
}
for (const p of base) failures.push(`no lag: ${p}`)
for (let r = 0; r < lagRuns; r++) {
  const max = [0.3, 0.8, 1.5][r % 3]!
  for (const p of replay(() => rand() * max)) failures.push(`lag 0-${max} s (run ${r + 1}): ${p}`)
}
if (failures.length > 0) {
  for (const f of [...new Set(failures)].slice(0, 30)) process.stdout.write(`FAIL ${f}\n`)
  process.exit(1)
}
process.stdout.write(`OK ${expects.length} checkpoints (${literals} on-screen literals) of ${tapePath} hold in the headless replay, without lag and in ${lagRuns} runs with recorder lag up to 1.5 s per command\n`)
