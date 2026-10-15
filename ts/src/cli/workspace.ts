/**
 * Real operations for the cobuild runner: a plan file of shell commands with
 * declared inputs and outputs, hashed, executed and restored on disk.
 *
 * Plan file (`cobuild.json`):
 *
 *     {
 *       "flushSalt": "1",                     // change to invalidate every entry
 *       "toolchain": "node22",                // optional extra fingerprint
 *       "operations": [
 *         { "name": "build-core", "deps": ["codegen"],
 *           "command": "npm run build -w core",
 *           "inputs": ["packages/core/src", "packages/core/package.json"],
 *           "outputs": ["packages/core/dist"] }
 *       ]
 *     }
 *
 * - The lookup digest (= lock key = cache key) of an operation covers its
 *   command, the content of every input file (directories are walked), the
 *   toolchain fingerprint and its dependencies' digests (`computeLookupDigests`),
 *   so changing any of them gives a new key in the same cobuild context.
 * - A build runs `sh -c <command>` in the workspace, in its own process
 *   group, without the job's credentials in its environment
 *   (`buildCommandEnv`); exit status 0 is success. An optional `timeoutMs`
 *   per operation (or `--op-timeout-ms`) bounds it: the process group is
 *   killed and the operation fails. Every declared output must exist afterwards, and all files under
 *   the outputs are uploaded.
 * - A restore stages the entry in `.cobuild/` and then swaps each declared
 *   output path into place (`makeWorkspaceStaging`).
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { Cache, Duration, Effect, Option, Result, runPromiseOrThrow, Schema, Stream } from "../fx/index.js"
import type { BlobStore } from "../cache/blobStore.js"
import { type Digest, digestBytes, formatDigest } from "../cache/digest.js"
import { encodeKey } from "../cache/keyEncoding.js"
import { computeLookupDigests, type InputFile, type KeyEnvironment, type PackageInputs } from "../cache/lookupKey.js"
import { isSafeRelativePath } from "../cache/manifest.js"
import type { OutputFile } from "../cache/publish.js"
import type { Staging, StagingSession } from "../cache/staging.js"
import { BuildFailure, type DemoOperation, InvalidPlan, type RunnerHooks } from "../demo/runner.js"
import { bump, inputFilesHashed } from "../metrics.js"
import { StoreFailure } from "../store.js"

const PlanOperation = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/))),
  deps: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  inputs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  outputs: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Time limit of the command in milliseconds (overrides `--op-timeout-ms`). */
  timeoutMs: Schema.optional(Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))))
})
export type PlanOperation = typeof PlanOperation.Type

export const Plan = Schema.Struct({
  flushSalt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("1"))),
  toolchain: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  operations: Schema.Array(PlanOperation).pipe(Schema.check(Schema.isMinLength(1)))
})
export type Plan = typeof Plan.Type

/** Parse and check a plan: schema, safe relative paths, no output inside another output. */
export const parsePlan = (json: unknown): Plan => {
  const decoded = Schema.decodeUnknownResult(Plan)(json)
  if (Result.isFailure(decoded)) throw new InvalidPlan(`invalid plan: ${String(decoded.failure.message)}`)
  const plan = decoded.success
  const outputs: Array<[string, string]> = []
  for (const op of plan.operations) {
    for (const p of [...op.inputs, ...op.outputs]) {
      if (!isSafeRelativePath(p)) throw new InvalidPlan(`${op.name}: path ${JSON.stringify(p)} must be relative, '/'-separated, without '..'`)
    }
    for (const o of op.outputs) outputs.push([op.name, o])
  }
  // Compare every pair of declared outputs by position, so a path listed twice is caught too.
  for (let i = 0; i < outputs.length; i++) {
    for (let j = 0; j < outputs.length; j++) {
      const [a, pa] = outputs[i]!
      const [b, pb] = outputs[j]!
      if (i !== j && (pa === pb || pb.startsWith(`${pa}/`))) throw new InvalidPlan(`outputs overlap: ${a}:${pa} and ${b}:${pb}`)
    }
  }
  return plan
}

/** Plan operations in the runner's shape (`inputs`/`buildMs` are unused by the real hooks). */
export const toRunnerOps = (plan: Plan): Array<DemoOperation> =>
  plan.operations.map((op) => ({ name: op.name, deps: op.deps, buildMs: 0, inputs: op.command }))

/** Every file under `rel` (a file or a directory), as workspace-relative paths, sorted. */
export const listFiles = async (workdir: string, rel: string): Promise<Array<string>> => {
  const abs = path.join(workdir, ...rel.split("/"))
  const st = await fs.lstat(abs)
  if (st.isSymbolicLink()) throw new InvalidPlan(`${rel}: symbolic links are not supported in inputs or outputs`)
  if (st.isFile()) return [rel]
  if (!st.isDirectory()) return []
  const out: Array<string> = []
  for (const name of (await fs.readdir(abs)).sort()) out.push(...(await listFiles(workdir, `${rel}/${name}`)))
  return out
}

/** Reads one workspace file (injectable so tests can count reads). */
export type ReadWorkspaceFile = (absolutePath: string) => Promise<Uint8Array>

const defaultRead: ReadWorkspaceFile = async (p) => new Uint8Array(await fs.readFile(p))

/** A cache from workspace-relative file path to content digest. */
export type FileDigestCache = Cache.Cache<string, Digest, unknown>

/**
 * A cache of input-file digests for one run.
 *
 * @remarks
 * Operations often share inputs (a root `package.json`, a shared
 * `tsconfig.json`, a generated schema). Without the cache every operation
 * that lists a file reads and hashes it again. This is the duplicate-work
 * case the Effect `Cache` exists for
 * ({@link https://effect.website/docs/v4/caching/cache}): concurrent and
 * repeated lookups of one path run the lookup once. The time to live is
 * infinite because the cache only lives for one `planDigests` call, during
 * which inputs are not expected to change (a build has not started yet). A
 * failed read is cached too, and every operation listing that file fails
 * with the same error.
 *
 * @param workdir - Workspace root.
 * @param read - File reader (default: `fs.readFile`).
 * @param capacity - Maximum number of cached digests (least recently used are evicted first).
 * @returns An effect producing the cache.
 */
export const makeFileDigestCache = (
  workdir: string,
  read: ReadWorkspaceFile = defaultRead,
  capacity = 1_000_000
): Effect.Effect<FileDigestCache> =>
  Cache.make({
    capacity,
    timeToLive: Duration.infinity,
    lookup: (rel: string) =>
      Effect.tryPromise({
        try: () => read(path.join(workdir, ...rel.split("/"))),
        catch: (e: unknown) => e
      }).pipe(
        Effect.map(digestBytes),
        Effect.tap(() => bump(inputFilesHashed))
      )
  })

/** Runs a promise-returning step, keeping whatever it threw as the typed failure. */
const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> => Effect.tryPromise({ try: f, catch: (e: unknown) => e })

/**
 * Content digests of an operation's inputs, plus its command as a pseudo-input.
 *
 * @param workdir - Workspace root.
 * @param op - The plan operation.
 * @param digests - The run's digest cache (see {@link makeFileDigestCache}).
 * @returns The input files in listing order, each file once. Fails with
 * `InvalidPlan` when an input does not exist, or with the read error.
 */
export const hashInputsEffect = (
  workdir: string,
  op: PlanOperation,
  digests: FileDigestCache
): Effect.Effect<Array<InputFile>, unknown> =>
  Effect.gen(function* () {
    const files: Array<InputFile> = [{ path: ":command", digest: digestBytes(new TextEncoder().encode(op.command)) }]
    const seen = new Set<string>()
    for (const rel of op.inputs) {
      const list = yield* attempt(() => listFiles(workdir, rel)).pipe(
        Effect.mapError((e) =>
          (e as NodeJS.ErrnoException).code === "ENOENT" ? new InvalidPlan(`${op.name}: input ${rel} does not exist`) : e
        )
      )
      for (const f of list) {
        if (seen.has(f)) continue
        seen.add(f)
        files.push({ path: f, digest: yield* Cache.get(digests, f) })
      }
    }
    return files
  })

/**
 * Lookup digests of every plan operation (reads the input files once each).
 *
 * @param workdir - Workspace root.
 * @param plan - The parsed plan.
 * @param env - Key environment (flush salt, toolchain).
 * @param options - `read` replaces the file reader; `concurrency` bounds how many operations are hashed at once (default 8).
 * @returns Operation name to lookup digest. Fails with `InvalidPlan` for a
 * duplicate operation, a missing input or a bad dependency graph.
 */
export const planDigestsEffect = (
  workdir: string,
  plan: Plan,
  env: KeyEnvironment,
  options: { readonly read?: ReadWorkspaceFile; readonly concurrency?: number } = {}
): Effect.Effect<Map<string, Digest>, unknown> =>
  Effect.gen(function* () {
    const names = new Set<string>()
    for (const op of plan.operations) {
      if (names.has(op.name)) return yield* Effect.fail(new InvalidPlan(`duplicate operation ${op.name}`))
      names.add(op.name)
    }
    const cache = yield* makeFileDigestCache(workdir, options.read)
    const inputs = yield* Effect.forEach(plan.operations, (op) => hashInputsEffect(workdir, op, cache), {
      concurrency: options.concurrency ?? 8
    })
    const graph = new Map<string, PackageInputs>()
    plan.operations.forEach((op, i) => graph.set(op.name, { inputs: inputs[i]!, deps: op.deps }))
    return yield* Effect.try({
      try: () => computeLookupDigests(env, graph),
      catch: (e: unknown) => new InvalidPlan(`invalid dependency graph: ${String((e as { _tag?: string })._tag ?? e)}`)
    })
  })

/** Runs an effect and rethrows its failure value unchanged (keeps `instanceof InvalidPlan` checks working). */
const runRethrowing = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => runPromiseOrThrow(eff)

/**
 * Promise form of {@link hashInputsEffect} with a fresh digest cache.
 *
 * @param workdir - Workspace root.
 * @param op - The plan operation.
 * @returns The input files.
 */
export const hashInputs = (workdir: string, op: PlanOperation): Promise<Array<InputFile>> =>
  runRethrowing(Effect.flatMap(makeFileDigestCache(workdir), (cache) => hashInputsEffect(workdir, op, cache)))

/**
 * Promise form of {@link planDigestsEffect}.
 *
 * @param workdir - Workspace root.
 * @param plan - The parsed plan.
 * @param env - Key environment.
 * @param options - See {@link planDigestsEffect}.
 * @returns Operation name to lookup digest.
 */
export const planDigests = (
  workdir: string,
  plan: Plan,
  env: KeyEnvironment,
  options: { readonly read?: ReadWorkspaceFile; readonly concurrency?: number } = {}
): Promise<Map<string, Digest>> => runRethrowing(planDigestsEffect(workdir, plan, env, options))

/** Keep the last `max` characters of a log. */
const tail = (s: string, max = 64 * 1024) => (s.length <= max ? s : `…(truncated)…\n${s.slice(s.length - max)}`)

/**
 * Environment variables that are never passed to build commands: storage and
 * API credentials used by `cobuild` itself. Build scripts (and every
 * dependency's install or test script) run with the job's other variables.
 */
const SECRET_ENV_PREFIXES = ["R2_", "CLOUDFLARE_", "AWS_"] as const
const SECRET_ENV_NAMES = new Set(["COBUILDS_API_TOKEN", "BAYESECT_API_TOKEN", "API_TOKEN", "ARTIFACTS_API_TOKEN"])

/** Is `name` a credential that must not reach a build command? `extra` adds names (`COBUILD_STRIP_ENV`). */
export const isSecretEnvName = (name: string, extra: ReadonlySet<string> = new Set()): boolean => {
  const n = name.toUpperCase()
  return SECRET_ENV_NAMES.has(n) || extra.has(n) || SECRET_ENV_PREFIXES.some((p) => n.startsWith(p))
}

/**
 * The environment of a build command: `base` without credentials
 * (`isSecretEnvName`, plus the comma-separated names in `COBUILD_STRIP_ENV`),
 * then `extra` on top (the `COBUILD_*` operation variables).
 */
export const buildCommandEnv = (base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> => {
  const strip = new Set(
    (base["COBUILD_STRIP_ENV"] ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0)
  )
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !isSecretEnvName(k, strip)) out[k] = v
  return { ...out, ...extra }
}

export interface RunCommandOptions {
  /** Raw output callback. */
  readonly echo?: (chunk: string) => void
  /** Kill the command (its whole process group) after this long (non-positive: no limit). */
  readonly timeout?: Duration.Duration
  /** Base environment (default `process.env`); credentials are removed (`buildCommandEnv`). */
  readonly baseEnv?: Record<string, string | undefined>
}

/** Send `signal` to the process group of `child` (falling back to the child alone). */
const killTree = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals) => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Run `sh -c command` in `workdir`, in its own process group, with
 * credentials removed from its environment. Output is captured (and echoed
 * to `echo`, if given). Interrupting the effect (e.g. the lease was lost or
 * the CLI got SIGTERM) or exceeding `timeout` terminates the whole process
 * group: SIGTERM, then SIGKILL after 5 s.
 */
export const runCommand = (
  workdir: string,
  command: string,
  env: Record<string, string>,
  echoOrOptions?: ((chunk: string) => void) | RunCommandOptions
): Effect.Effect<{ readonly code: number | null; readonly signal: string | null; readonly log: string; readonly timedOut: boolean }> =>
  Effect.callback((resume) => {
    const opts: RunCommandOptions = typeof echoOrOptions === "function" ? { echo: echoOrOptions } : (echoOrOptions ?? {})
    const child = spawn("sh", ["-c", command], {
      cwd: workdir,
      env: buildCommandEnv(opts.baseEnv ?? process.env, env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    })
    let log = ""
    let timedOut = false
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      killTree(child, "SIGTERM")
      hardKill ??= setTimeout(() => killTree(child, "SIGKILL"), 5000)
      hardKill.unref?.()
    }
    const timer =
      opts.timeout !== undefined && Duration.toMillis(opts.timeout) > 0
        ? setTimeout(() => {
            timedOut = true
            terminate()
          }, Duration.toMillis(opts.timeout))
        : undefined
    const onData = (d: Buffer) => {
      const s = d.toString("utf8")
      log = tail(log + s)
      opts.echo?.(s)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const finish = (r: { code: number | null; signal: string | null; log: string }) => {
      if (timer !== undefined) clearTimeout(timer)
      if (hardKill !== undefined) clearTimeout(hardKill)
      resume(Effect.succeed({ ...r, timedOut }))
    }
    child.on("error", (e) => finish({ code: null, signal: null, log: `${log}\nspawn failed: ${String(e)}` }))
    child.on("exit", () => {
      // The shell is gone; make sure nothing it started outlives it.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // the group is already empty
        }
      }
    })
    child.on("close", (code, signal) => finish({ code, signal, log }))
    return Effect.sync(() => {
      if (timer !== undefined) clearTimeout(timer)
      terminate()
    })
  })

/** Collect the declared outputs of `op` after a successful command. */
export const collectOutputs = async (workdir: string, op: PlanOperation): Promise<Array<OutputFile>> => {
  const files: Array<OutputFile> = []
  for (const rel of op.outputs) {
    let list: Array<string>
    try {
      list = await listFiles(workdir, rel)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new BuildFailure(`declared output ${rel} was not produced`)
      throw e
    }
    for (const f of list) files.push({ path: f, bytes: new Uint8Array(await fs.readFile(path.join(workdir, ...f.split("/")))) })
  }
  return files
}

const fsFail = (key: string) => (cause: unknown) => new StoreFailure({ key, cause })

/**
 * Staging for a restore into the workspace: files are written under
 * `<workdir>/.cobuild/restore-<uuid>/`; on commit each declared output root
 * is replaced by its staged copy with `rename` (an output root absent from the
 * entry is replaced by an empty directory). Files outside the declared roots
 * are refused, so a cache entry cannot write anywhere else in the workspace.
 */
export const makeWorkspaceStaging = (workdir: string, outputRoots: ReadonlyArray<string>): Staging => ({
  begin: Effect.gen(function* () {
    const stage = path.join(workdir, ".cobuild", `restore-${randomUUID()}`)
    yield* Effect.tryPromise({ try: () => fs.mkdir(stage, { recursive: true }), catch: fsFail(stage) })
    let open = true
    const inRoots = (rel: string) => outputRoots.some((r) => rel === r || rel.startsWith(`${r}/`))
    const session: StagingSession = {
      write: (rel, chunk) =>
        Effect.suspend(() => {
          if (!open) return Effect.fail(new StoreFailure({ key: rel, cause: "session closed" }))
          if (!isSafeRelativePath(rel) || !inRoots(rel)) {
            return Effect.fail(new StoreFailure({ key: rel, cause: "path outside the declared outputs" }))
          }
          const target = path.join(stage, ...rel.split("/"))
          return Effect.tryPromise({
            try: async () => {
              await fs.mkdir(path.dirname(target), { recursive: true })
              await fs.appendFile(target, chunk)
            },
            catch: fsFail(target)
          })
        }),
      commit: Effect.suspend(() => {
        if (!open) return Effect.fail(new StoreFailure({ key: workdir, cause: "session closed" }))
        open = false
        return Effect.tryPromise({
          try: async () => {
            for (const root of outputRoots) {
              const staged = path.join(stage, ...root.split("/"))
              const dest = path.join(workdir, ...root.split("/"))
              await fs.rm(dest, { recursive: true, force: true })
              await fs.mkdir(path.dirname(dest), { recursive: true })
              try {
                await fs.rename(staged, dest)
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
                await fs.mkdir(dest, { recursive: true })
              }
            }
            await fs.rm(stage, { recursive: true, force: true })
          },
          catch: fsFail(workdir)
        })
      }),
      abort: Effect.suspend(() => {
        if (!open) return Effect.void
        open = false
        return Effect.promise(() => fs.rm(stage, { recursive: true, force: true }).catch(() => undefined))
      })
    }
    return session
  })
})

/** Key of a failure log: `v1/<scope>/log/<lookup>/<uuid>/`. */
export const failureLogKey = (scope: string, lookup: Digest) => encodeKey([scope, "log", formatDigest(lookup), randomUUID()])

/** Read a failure log written by another job (`null` if absent or unreadable). */
export const readFailureLog = (store: BlobStore, key: string): Effect.Effect<string | null> =>
  store.getStream(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(null as string | null),
        onSome: (s) =>
          Stream.runCollect(s).pipe(
            Effect.map((chunks) => {
              const parts = [...chunks]
              const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
              let off = 0
              for (const p of parts) {
                out.set(p, off)
                off += p.length
              }
              return new TextDecoder().decode(out) as string | null
            })
          )
      })
    ),
    Effect.catch(() => Effect.succeed(null))
  )

export interface WorkspaceHooksConfig {
  readonly workdir: string
  readonly plan: Plan
  readonly digests: Map<string, Digest>
  readonly blobStore: BlobStore
  readonly scope: string
  /** Echo command output (e.g. to stderr with a prefix). */
  readonly echo?: (op: string, chunk: string) => void
  /** Default time limit of every command (an operation's `timeoutMs` in the plan overrides it). */
  readonly opTimeout?: Duration.Duration
  /** Environment the commands start from (default `process.env`), before credentials are removed. */
  readonly baseEnv?: Record<string, string | undefined>
}

/** Runner hooks that run real commands in `workdir`. */
export const workspaceHooks = (cfg: WorkspaceHooksConfig): RunnerHooks => {
  const byName = new Map(cfg.plan.operations.map((o) => [o.name, o]))
  const opOf = (name: string) => {
    const op = byName.get(name)
    if (op === undefined) throw new InvalidPlan(`unknown operation ${name}`)
    return op
  }
  return {
    digests: () => cfg.digests,
    build: (runnerOp, lookup) =>
      Effect.gen(function* () {
        const op = opOf(runnerOp.name)
        // The plan file stores milliseconds (wire format); the runner works with a Duration.
        const timeout = op.timeoutMs !== undefined ? Duration.millis(op.timeoutMs) : cfg.opTimeout
        const r = yield* runCommand(
          cfg.workdir,
          op.command,
          { COBUILD_OPERATION: op.name, COBUILD_LOOKUP: formatDigest(lookup) },
          {
            ...(cfg.echo === undefined ? {} : { echo: (c: string) => cfg.echo!(op.name, c) }),
            ...(timeout !== undefined ? { timeout } : {}),
            ...(cfg.baseEnv !== undefined ? { baseEnv: cfg.baseEnv } : {})
          }
        )
        if (r.timedOut) {
          return yield* Effect.fail(new BuildFailure(`${r.log}\n[cobuild] ${op.name}: command timed out after ${timeout === undefined ? "?" : Duration.format(timeout)} (process group killed)`))
        }
        if (r.code !== 0) {
          return yield* Effect.fail(new BuildFailure(`${r.log}\n[cobuild] ${op.name}: command exited with ${r.code ?? `signal ${r.signal}`}`))
        }
        return yield* Effect.tryPromise({
          try: () => collectOutputs(cfg.workdir, op),
          catch: (e) => (e instanceof BuildFailure ? e : new BuildFailure(`collecting outputs failed: ${String(e)}`))
        })
      }),
    staging: (runnerOp) => makeWorkspaceStaging(cfg.workdir, opOf(runnerOp.name).outputs),
    uploadFailureLog: (runnerOp, lookup, log) => {
      const key = failureLogKey(cfg.scope, lookup)
      return cfg.blobStore.putIfNoneMatch(key, new TextEncoder().encode(`[${runnerOp.name}]\n${log}`)).pipe(
        Effect.as(key as string | null),
        Effect.catch(() => Effect.succeed(null))
      )
    }
  }
}
