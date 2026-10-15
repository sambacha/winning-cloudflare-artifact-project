/**
 * `ensureNodeModules`: restore `node_modules` from the cache, or install it
 * with `npm ci` and publish it.
 *
 * Worker-safe: the project lives behind a {@link NmWorkspace} (a local
 * directory, `localWorkspace.ts`; or a Sandbox SDK sandbox,
 * `../bisect/sandboxWorkspace.ts`), and the cache behind a `BlobStore`. In a
 * sandbox the Worker does all R2 I/O, so the sandbox, which runs untrusted
 * test code, never holds R2 credentials.
 *
 * Hit path: manifest → tarball (digest-checked) → extract over
 * `node_modules` → check `node_modules/.package-lock.json` against the
 * manifest. No install runs.
 *
 * Miss path: `npm ci` (timed on the Effect clock) → deterministic tarball
 * (GNU tar: sorted entries, mtime 0, numeric owner 0; `gzip -n`) → publish.
 *
 * The cache can never fail a build: a store error or a corrupt entry falls
 * back to installing, and a failed publish is reported but not fatal. Only a
 * failing install (or a workspace that cannot run commands) is an error.
 */
import type { BlobStore } from "../cache/blobStore.js"
import { Clock, Data, Effect, Option } from "../fx/index.js"
import { fetchTarball, lookupManifest, type NodeModulesManifest, publishEntry, recordEvent } from "./cache.js"
import { nodeModulesKey, type NodeModulesKeyInput, sha256Hex } from "./key.js"

/** A command run in a workspace exited non-zero (or could not start). */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly exitCode: number | null
  readonly stderrTail: string
}> {}

/** `package-lock.json` is missing or unreadable: there is nothing to key on. */
export class NoLockfile extends Data.TaggedError("NoLockfile")<{ readonly lockfile: string }> {}

/** Result of one command. */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * A project checkout that can be read, written and run in. Paths are
 * relative to the project root; commands run with the root as working
 * directory. `exec` succeeds with any exit code (a non-zero exit is data);
 * its error channel is only for "could not run at all".
 */
export interface NmWorkspace {
  readonly readFile: (rel: string) => Effect.Effect<Uint8Array | null, CommandFailed>
  readonly writeFile: (rel: string, bytes: Uint8Array) => Effect.Effect<void, CommandFailed>
  readonly exec: (argv: ReadonlyArray<string>) => Effect.Effect<ExecResult, CommandFailed>
  /** `process.versions.modules`, `process.platform`, `process.arch`, `process.version` of the workspace's Node. */
  readonly runtime: Effect.Effect<{ readonly abi: string; readonly platform: string; readonly arch: string; readonly nodeVersion: string }, CommandFailed>
}

/** Run a command and fail with {@link CommandFailed} on a non-zero exit. */
export const execOk = (ws: NmWorkspace, argv: ReadonlyArray<string>): Effect.Effect<ExecResult, CommandFailed> =>
  Effect.flatMap(ws.exec(argv), (r) =>
    r.exitCode === 0 ? Effect.succeed(r) : Effect.fail(new CommandFailed({ command: argv.join(" "), exitCode: r.exitCode, stderrTail: r.stderr.slice(-4000) }))
  )

/** Scratch directory inside the workspace (ignored by `git clean`? no: removed after use). */
const SCRATCH = ".nm-cache"

/** Key input of the project in `ws`. */
export const workspaceKeyInput = (ws: NmWorkspace): Effect.Effect<NodeModulesKeyInput & { readonly nodeVersion: string }, NoLockfile | CommandFailed> =>
  Effect.gen(function* () {
    const bytes = yield* ws.readFile("package-lock.json")
    if (bytes === null) return yield* Effect.fail(new NoLockfile({ lockfile: "package-lock.json" }))
    const lockfileSha256 = yield* Effect.promise(() => sha256Hex(bytes))
    const rt = yield* ws.runtime
    return { lockfileSha256, abi: rt.abi, platform: rt.platform, arch: rt.arch, nodeVersion: rt.nodeVersion }
  })

/** SHA-256 of `node_modules/.package-lock.json` (npm's record of the installed tree), or `null`. */
export const installedLockDigest = (ws: NmWorkspace): Effect.Effect<string | null, CommandFailed> =>
  Effect.flatMap(ws.readFile("node_modules/.package-lock.json"), (b) => (b === null ? Effect.succeed(null) : Effect.promise(() => sha256Hex(b))))

/** Deterministic `.tgz` of `node_modules` (GNU tar), as bytes. */
export const packNodeModules = (ws: NmWorkspace): Effect.Effect<Uint8Array, CommandFailed> =>
  Effect.gen(function* () {
    const out = `${SCRATCH}/node_modules.tgz`
    yield* execOk(ws, ["mkdir", "-p", SCRATCH])
    yield* execOk(ws, ["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--use-compress-program=gzip -n -1", "-cf", out, "node_modules"])
    const bytes = yield* ws.readFile(out)
    yield* execOk(ws, ["rm", "-rf", SCRATCH])
    if (bytes === null) return yield* Effect.fail(new CommandFailed({ command: "tar", exitCode: null, stderrTail: "tarball not written" }))
    return bytes
  })

/** Replace `node_modules` with the contents of a tarball. */
export const unpackNodeModules = (ws: NmWorkspace, tarball: Uint8Array): Effect.Effect<void, CommandFailed> =>
  Effect.gen(function* () {
    const file = `${SCRATCH}/node_modules.tgz`
    yield* execOk(ws, ["mkdir", "-p", SCRATCH])
    yield* ws.writeFile(file, tarball)
    yield* execOk(ws, ["rm", "-rf", "node_modules"])
    yield* execOk(ws, ["tar", "-xzf", file])
    yield* execOk(ws, ["rm", "-rf", SCRATCH])
  })

/** Options of {@link ensureNodeModules}. */
export interface EnsureOptions {
  readonly workspace: NmWorkspace
  readonly store: BlobStore
  /** Unique id of this run (names its report). */
  readonly runId: string
  /** The cold install (default `npm ci --no-audit --no-fund`). */
  readonly install?: ReadonlyArray<string>
  /** Reported in the manifest (default: `npm --version` in the workspace, or "unknown"). */
  readonly npmVersion?: string
  /** Called with human-readable progress lines. */
  readonly log?: (line: string) => void
}

/** Why a hit was not possible. */
export type MissReason = "absent" | "tarball-missing" | "corrupt" | "store-error" | "verify-failed"

/** What happened. */
export interface EnsureResult {
  readonly key: string
  readonly outcome: "hit" | "miss"
  /** Hit: restore time. Miss: install time. */
  readonly durationMs: number
  /** Miss only: whether this run committed the entry (`exists` if another did first; `failed` if publishing failed). */
  readonly publish: "published" | "exists" | "failed" | null
  readonly missReason: MissReason | null
  readonly manifest: NodeModulesManifest | null
}

/** The default cold install. */
export const DEFAULT_INSTALL: ReadonlyArray<string> = ["npm", "ci", "--no-audit", "--no-fund"]

/**
 * Restore `node_modules` in the workspace from the cache, or install and publish it.
 *
 * @param opts - Workspace, store, run id and install command.
 * @returns What happened; fails only if the install fails, there is no lockfile, or the workspace cannot run commands.
 */
export const ensureNodeModules = (opts: EnsureOptions): Effect.Effect<EnsureResult, CommandFailed | NoLockfile> =>
  Effect.gen(function* () {
    const ws = opts.workspace
    const log = opts.log ?? (() => undefined)
    const input = yield* workspaceKeyInput(ws)
    const keyInput: NodeModulesKeyInput = { lockfileSha256: input.lockfileSha256, abi: input.abi, platform: input.platform, arch: input.arch }
    const key = nodeModulesKey(keyInput)
    const t0 = yield* Clock.currentTimeMillis

    // --- Hit path. Any failure here is a miss with a reason, never an error.
    type Probe = { readonly hit: NodeModulesManifest } | { readonly miss: MissReason }
    const probe: Probe = yield* Effect.gen(function* () {
      const m = yield* lookupManifest(opts.store, keyInput)
      if (Option.isNone(m)) return { miss: "absent" } as const
      const tar = yield* fetchTarball(opts.store, m.value)
      if (Option.isNone(tar)) return { miss: "tarball-missing" } as const
      yield* unpackNodeModules(ws, tar.value)
      const installed = yield* installedLockDigest(ws)
      if (installed !== m.value.installedLockSha256) return { miss: "verify-failed" } as const
      return { hit: m.value } as const
    }).pipe(
      Effect.catchTag("NodeModulesCacheCorrupt", () => Effect.succeed<Probe>({ miss: "corrupt" })),
      Effect.catch(() => Effect.succeed<Probe>({ miss: "store-error" }))
    )

    if ("hit" in probe) {
      const durationMs = (yield* Clock.currentTimeMillis) - t0
      log(`[node_modules] hit ${key} (${probe.hit.tarballBytes} bytes) restored in ${durationMs} ms`)
      yield* recordEvent(opts.store, {
        version: 1,
        runId: opts.runId,
        key,
        outcome: "hit",
        durationMs,
        avoidedMs: probe.hit.coldInstallMs,
        tarballBytes: probe.hit.tarballBytes,
        at: t0
      }).pipe(Effect.catch(() => Effect.void))
      return { key, outcome: "hit", durationMs, publish: null, missReason: null, manifest: probe.hit }
    }

    // --- Miss path.
    log(`[node_modules] miss ${key} (${probe.miss}); installing`)
    yield* execOk(ws, ["rm", "-rf", "node_modules"])
    const install = opts.install ?? DEFAULT_INSTALL
    const i0 = yield* Clock.currentTimeMillis
    yield* execOk(ws, install)
    const coldInstallMs = (yield* Clock.currentTimeMillis) - i0
    const npmVersion =
      opts.npmVersion ??
      (yield* ws.exec(["npm", "--version"]).pipe(
        Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : "unknown")),
        Effect.catch(() => Effect.succeed("unknown"))
      ))
    const installedLockSha256 = (yield* installedLockDigest(ws)) ?? ""
    // A corrupt manifest cannot be replaced (create-only): install without publishing.
    const published =
      probe.miss === "corrupt" || installedLockSha256 === ""
        ? { outcome: "failed" as const, manifest: null }
        : yield* Effect.gen(function* () {
            const tarball = yield* packNodeModules(ws)
            return yield* publishEntry(opts.store, keyInput, tarball, {
              nodeVersion: input.nodeVersion,
              npmVersion,
              installedLockSha256,
              coldInstallMs,
              createdAt: yield* Clock.currentTimeMillis
            })
          }).pipe(Effect.catch(() => Effect.succeed({ outcome: "failed" as const, manifest: null })))
    log(`[node_modules] installed in ${coldInstallMs} ms; publish: ${published.outcome}`)
    yield* recordEvent(opts.store, {
      version: 1,
      runId: opts.runId,
      key,
      outcome: "miss",
      durationMs: coldInstallMs,
      avoidedMs: 0,
      tarballBytes: published.manifest?.tarballBytes ?? 0,
      at: t0
    }).pipe(Effect.catch(() => Effect.void))
    return { key, outcome: "miss", durationMs: coldInstallMs, publish: published.outcome, missReason: probe.miss, manifest: published.manifest }
  })
