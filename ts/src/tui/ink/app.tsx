/**
 * The live dashboard (Ink). Polls the Worker every `POLL_MS` while watching,
 * folds each poll into the pure live state (`../live.ts`), and renders the
 * same frame model as `--snapshot`.
 *
 *   cobuild-tui --url <worker> [--repo <name>]... [--context <ctx>] [--session <id>]
 *               [--principal <name>] [--comment <text>] [--title <text>]
 *   COBUILD_API_TOKEN    read token (required)
 *   COBUILD_WRITE_TOKEN  write token for drive / approve / reject (optional)
 *
 * The clock is injected (`now` prop); `main` passes the wall clock, the only
 * place it is read.
 */
import { render, useApp, useInput, useStdout } from "ink"
import { useEffect, useRef, useState } from "react"
import { POLL_MS, SUPPORTED_SIZES } from "../constants.js"
import { applyLocal, keyAction } from "../keys.js"
import { approve, drive, initialLive, type LiveConfig, liveInput, type LiveState, noteAction, poll, reject, step } from "../live.js"
import { initialUi, type UiState } from "../model.js"
import { Dashboard } from "./Dashboard.js"

/** Props of the app. */
export interface AppProps {
  readonly cfg: LiveConfig
  readonly now: () => number
  readonly title: string
  readonly comment: string
}

const terminalSize = (stdout: NodeJS.WriteStream): { readonly cols: number; readonly rows: number } => ({
  cols: stdout.columns ?? SUPPORTED_SIZES[0].cols,
  rows: stdout.rows ?? SUPPORTED_SIZES[0].rows
})

export const App = ({ cfg, now, title, comment }: AppProps) => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [ui, setUi] = useState<UiState>(initialUi)
  const [live, setLive] = useState<LiveState>(initialLive)
  const [size, setSize] = useState(() => terminalSize(stdout))
  const [tick, setTick] = useState(now())
  const watching = useRef(ui.watch)
  watching.current = ui.watch

  useEffect(() => {
    const onResize = () => setSize(terminalSize(stdout))
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      if (watching.current) {
        const snap = await poll(cfg)
        if (stopped) return
        setLive((st) => step(st, snap, now()))
      }
      setTick(now())
      if (!stopped) timer = setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [cfg, now])

  useInput((input, key) => {
    const a = keyAction(input, key.ctrl && input === "c")
    if (a.kind === "quit") {
      exit()
      return
    }
    setUi((u) => applyLocal(u, a))
    const remote = a.kind === "drive" ? drive(cfg) : a.kind === "approve" ? approve(cfg, comment) : a.kind === "reject" ? reject(cfg, comment) : null
    if (remote !== null) {
      void remote.then((o) => {
        setLive((st) => noteAction(st, o, now()))
        setUi((u) => ({ ...u, status: o.text }))
      })
    }
  })

  return <Dashboard input={liveInput(live, tick, title)} ui={ui} cols={size.cols} rows={size.rows} />
}

/** Parse the live command line. Throws with a usage message on bad input. */
export const parseLiveArgs = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>): Omit<AppProps, "now"> => {
  const all = (name: string): ReadonlyArray<string> => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]!] : []))
  const one = (name: string): string | undefined => all(name).at(-1)
  const url = one("--url")
  const token = env["COBUILD_API_TOKEN"]
  if (url === undefined) throw new Error("usage: cobuild-tui --url <worker> [--repo <name>]... [--context <ctx>] [--session <id>]   (or --snapshot <sec> --seed <n>)")
  if (token === undefined || token.length === 0) throw new Error("COBUILD_API_TOKEN is not set")
  const writeToken = env["COBUILD_WRITE_TOKEN"]
  return {
    cfg: {
      url,
      token,
      ...(writeToken !== undefined && writeToken.length > 0 ? { writeToken } : {}),
      repos: all("--repo"),
      context: one("--context") ?? null,
      session: one("--session") ?? null,
      principal: one("--principal") ?? env["USER"] ?? "dashboard",
      fetch: (input, init) => fetch(input, init)
    },
    title: one("--title") ?? "cobuilds",
    comment: one("--comment") ?? "reviewed in the cobuilds dashboard"
  }
}

/** Entry point of the live dashboard. */
export const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const props = parseLiveArgs(argv, process.env)
  const instance = render(<App {...props} now={() => Date.now()} />)
  await instance.waitUntilExit()
}
