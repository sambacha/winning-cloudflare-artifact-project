/**
 * The part of a Cloudflare Sandbox SDK sandbox (`getSandbox(env.Sandbox, id)`)
 * that bisection uses, and a {@link NmWorkspace} over it.
 *
 * Declared structurally instead of importing `@cloudflare/sandbox`, like
 * `../worker/r2Bucket.ts` does for R2: the edge module
 * (`../workers/edge.ts`) passes the real sandbox, which satisfies this shape.
 * **Unverified against the SDK from this repository** (no account, no
 * network): the option names `env`, `cwd` and `timeout` of `exec`, and the
 * `{ content }` result of `readFile(path, { encoding: "base64" })`. The
 * adapter is the only place to change if they differ.
 */
import { Effect } from "../fx/index.js"
import { CommandFailed, type ExecResult, type NmWorkspace } from "../nodeModules/ensure.js"

/** One `exec` call's options. */
export interface SandboxExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  /** Milliseconds. */
  readonly timeout?: number
}

/** A sandbox: run shell commands, read and write files, and be destroyed. */
export interface SandboxLike {
  readonly exec: (command: string, options?: SandboxExecOptions) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>
  readonly writeFile: (path: string, content: string, options?: { readonly encoding?: "base64" | "utf-8" }) => Promise<unknown>
  readonly readFile: (path: string, options?: { readonly encoding?: "base64" | "utf-8" }) => Promise<{ readonly content: string }>
  readonly destroy: () => Promise<unknown>
}

/** Opens a fresh sandbox per id (the edge passes `getSandbox(env.Sandbox, id)`). */
export type SandboxFactory = (id: string) => SandboxLike

/** POSIX shell quoting of one argument. */
export const shq = (arg: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`)

/** A command line from an argument vector. */
export const shellLine = (argv: ReadonlyArray<string>): string => argv.map(shq).join(" ")

const b64encode = (bytes: Uint8Array): string => {
  let s = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

const b64decode = (text: string): Uint8Array => {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Lift a sandbox call; a rejected promise means the sandbox could not run it. */
export const sandboxCall = <A>(what: string, f: () => Promise<A>): Effect.Effect<A, CommandFailed> =>
  Effect.tryPromise({ try: f, catch: (e) => new CommandFailed({ command: what, exitCode: null, stderrTail: String(e) }) })

/**
 * A workspace rooted at `root` inside a sandbox. `env` is passed to every
 * command (credentials go here, never into the command line).
 */
export const makeSandboxWorkspace = (sandbox: SandboxLike, root: string, env: Record<string, string> = {}): NmWorkspace => {
  const abs = (rel: string) => `${root}/${rel}`
  const exec = (argv: ReadonlyArray<string>): Effect.Effect<ExecResult, CommandFailed> =>
    sandboxCall(shellLine(argv), () => sandbox.exec(shellLine(argv), { cwd: root, env })).pipe(
      Effect.map((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }))
    )
  return {
    exec,
    readFile: (rel) =>
      sandboxCall(`readFile ${rel}`, async () => {
        const probe = await sandbox.exec(shellLine(["test", "-f", abs(rel)]))
        if (probe.exitCode !== 0) return null
        return b64decode((await sandbox.readFile(abs(rel), { encoding: "base64" })).content)
      }),
    writeFile: (rel, bytes) => sandboxCall(`writeFile ${rel}`, () => sandbox.writeFile(abs(rel), b64encode(bytes), { encoding: "base64" })).pipe(Effect.asVoid),
    runtime: Effect.flatMap(exec(["node", "-p", "JSON.stringify([process.versions.modules, process.platform, process.arch, process.version])"]), (r) => {
      try {
        const [abi, platform, arch, nodeVersion] = JSON.parse(r.stdout) as [string, string, string, string]
        return r.exitCode === 0 ? Effect.succeed({ abi, platform, arch, nodeVersion }) : Effect.fail(new CommandFailed({ command: "node -p", exitCode: r.exitCode, stderrTail: r.stderr }))
      } catch {
        return Effect.fail(new CommandFailed({ command: "node -p", exitCode: r.exitCode, stderrTail: `unexpected output: ${r.stdout.slice(0, 200)}` }))
      }
    })
  }
}
