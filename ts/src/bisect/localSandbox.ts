/**
 * A {@link SandboxLike} on the local machine (Node): commands run with
 * `bash -c` in a process group, files are plain files, `destroy` removes the
 * sandbox's scratch directory. Used by the local bisect driver and by tests,
 * so the same predicate step runs against a real Git repository and real
 * `npm` without a Cloudflare account. It is **not** an isolation boundary.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "../fx/index.js"
import { spawnCollect } from "../nodeModules/localWorkspace.js"
import type { SandboxLike } from "./sandbox.js"

/** Options of {@link makeLocalSandbox}. */
export interface LocalSandboxOptions {
  /** Directory removed by `destroy` (the step's workdir lives below it). */
  readonly scratch: string
  /** Base environment of commands (default: `PATH`, `HOME`, `LANG` of this process). */
  readonly baseEnv?: Record<string, string>
  /** Called with every command line (for logs and tests). */
  readonly onExec?: (command: string) => void
}

/**
 * A local sandbox.
 *
 * @param opts - Scratch directory, environment and an exec hook.
 */
export const makeLocalSandbox = (opts: LocalSandboxOptions): SandboxLike => {
  const base: Record<string, string> =
    opts.baseEnv ??
    Object.fromEntries(
      (["PATH", "HOME", "LANG", "TMPDIR", "npm_config_cache"] as const).flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : []))
    )
  let destroyed = false
  const alive = () => {
    if (destroyed) throw new Error("sandbox used after destroy")
  }
  return {
    exec: async (command, options) => {
      alive()
      opts.onExec?.(command)
      const cwd = options?.cwd ?? opts.scratch
      await mkdir(cwd, { recursive: true })
      return Effect.runPromise(
        spawnCollect(["bash", "-c", command], cwd, { env: { ...base, ...(options?.env ?? {}) }, ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}) })
      )
    },
    writeFile: async (file, content, options) => {
      alive()
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, options?.encoding === "base64" ? Buffer.from(content, "base64") : content)
    },
    readFile: async (file, options) => {
      alive()
      const b = await readFile(file)
      return { content: options?.encoding === "base64" ? b.toString("base64") : b.toString("utf8") }
    },
    destroy: async () => {
      destroyed = true
      await rm(opts.scratch, { recursive: true, force: true })
    }
  }
}
