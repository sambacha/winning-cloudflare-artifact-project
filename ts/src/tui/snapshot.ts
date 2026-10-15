/**
 * `--snapshot <sec> --seed <n>`: one frame of the scenario as plain text,
 * with no terminal and no wall clock. The same arguments always produce
 * the same bytes.
 */
import { renderFrame } from "./frame.js"
import { initialUi, type PanelKey, type UiState } from "./model.js"
import { scenarioInput } from "./scenario.js"

/** Options of a snapshot. */
export interface SnapshotOptions {
  readonly sec: number
  readonly seed: string
  readonly cols: number
  readonly rows: number
  readonly focus?: PanelKey
  readonly notes?: boolean
}

/** The frame text (lines joined with `\n`, trailing newline). */
export const snapshotText = (o: SnapshotOptions): string => {
  const ui: UiState = { ...initialUi, ...(o.focus !== undefined ? { focus: o.focus } : {}), ...(o.notes === true ? { notes: true } : {}) }
  return renderFrame(scenarioInput(o.seed, o.sec), ui, o.cols, o.rows).join("\n") + "\n"
}

/** Parse the command line; `null` when not a snapshot invocation. Throws on malformed values. */
export const parseSnapshotArgs = (argv: ReadonlyArray<string>, defaults: { readonly cols: number; readonly rows: number }): SnapshotOptions | null => {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const sec = get("--snapshot")
  if (sec === undefined) return null
  const num = (name: string, v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`${name} expects a non-negative number, got ${JSON.stringify(v)}`)
    return n
  }
  const focus = get("--panel")
  const f = focus === undefined ? undefined : num("--panel", focus, 0)
  if (f !== undefined && ![1, 2, 3, 4, 5].includes(f)) throw new RangeError("--panel expects 1-5")
  return {
    sec: num("--snapshot", sec, 0),
    seed: get("--seed") ?? "1",
    cols: Math.floor(num("--cols", get("--cols"), defaults.cols)),
    rows: Math.floor(num("--rows", get("--rows"), defaults.rows)),
    ...(f !== undefined ? { focus: f as PanelKey } : {}),
    ...(argv.includes("--notes") ? { notes: true } : {})
  }
}
