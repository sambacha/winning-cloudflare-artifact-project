/**
 * {@link NmWorkspace} over a local directory (Node: `fs` and `spawn`).
 * Used by the `nm-cache` CLI, the local bisect driver and the tests.
 */
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "../fx/index.js"
import { CommandFailed, type ExecResult, type NmWorkspace } from "./ensure.js"

/** Options of {@link makeLocalWorkspace}. */
export interface LocalWorkspaceOptions {
  /** Environment of spawned commands (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv
  /** Kill a command after this many milliseconds (exit code 124, like GNU `timeout`). */
  readonly timeoutMs?: number
}

/** Run `argv` in `cwd`; resolves with any exit code. */
export const spawnCollect = (argv: ReadonlyArray<string>, cwd: string, opts: LocalWorkspaceOptions = {}): Effect.Effect<ExecResult, CommandFailed> =>
  Effect.callback<ExecResult, CommandFailed>((resume) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) {
      resume(Effect.fail(new CommandFailed({ command: "", exitCode: null, stderrTail: "empty command" })))
      return
    }
    const child = spawn(cmd, args, { cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            try {
              process.kill(-child.pid!, "SIGKILL")
            } catch {
              child.kill("SIGKILL")
            }
          }, opts.timeoutMs)
    child.stdout.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-1_000_000)
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-100_000)
    })
    child.on("error", (e) => {
      if (timer) clearTimeout(timer)
      resume(Effect.fail(new CommandFailed({ command: argv.join(" "), exitCode: null, stderrTail: String(e) })))
    })
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer)
      resume(Effect.succeed({ exitCode: timedOut ? 124 : (code ?? (signal ? 128 : 1)), stdout, stderr }))
    })
    return Effect.sync(() => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // already exited
      }
    })
  })

/**
 * A workspace rooted at `dir`.
 *
 * @param dir - Project root.
 * @param opts - Environment and per-command timeout.
 */
export const makeLocalWorkspace = (dir: string, opts: LocalWorkspaceOptions = {}): NmWorkspace => ({
  readFile: (rel) =>
    Effect.promise(async () => {
      try {
        return new Uint8Array(await readFile(path.join(dir, rel)))
      } catch {
        return null
      }
    }),
  writeFile: (rel, bytes) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
        await writeFile(path.join(dir, rel), bytes)
      },
      catch: (e) => new CommandFailed({ command: `write ${rel}`, exitCode: null, stderrTail: String(e) })
    }),
  exec: (argv) => spawnCollect(argv, dir, opts),
  runtime: Effect.succeed({ abi: process.versions.modules, platform: process.platform, arch: process.arch, nodeVersion: process.version })
})
