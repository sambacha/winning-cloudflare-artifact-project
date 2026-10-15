/**
 * End to end: the `cobuild` CLI as separate OS processes ("CI jobs") sharing
 * one bucket, running real shell commands in separate workspaces. The bucket
 * is the directory-backed store (`fsBucket.ts`, R2 request semantics
 * including the 1 write / key / s limit); with `R2_*` set the same commands
 * run against R2 (`--store r2`), which this repository could not do (no
 * credentials or network here).
 *
 * Checked, mirroring the Rush proposal's scenarios:
 * - 3 jobs, diamond graph: every operation's command runs exactly once over
 *   all jobs, every workspace ends with identical, complete outputs, every
 *   job exits 0, and `cobuild status` reports one succeeded lock per
 *   operation (the JSON the Worker serves and the TUI reads);
 * - crash and takeover: the holder is killed with SIGKILL mid-build; another
 *   job takes over after the lease expires and finishes;
 * - a failing operation: its command runs once, the failure marker makes the
 *   other jobs fail fast with the uploaded log (no rebuild, the proposal's
 *   "10-minute worst case"), dependents are skipped, every job exits 1;
 * - a later run in a new context restores everything from the cache;
 * - `cache save` / `cache restore` (the GitHub-cache-style commands);
 * - `runMain` (the facade's process runner used by both entry points):
 *   exit statuses, finalizers on SIGINT, and graceful teardown of an
 *   abortable Promise-based main on SIGTERM.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { main } from "../../src/cli/main.js"
import { fetchLiveLocks, toLiveRows } from "../../../tui/src/live.js"

const TS_DIR = resolve(__dirname, "../..")
const BIN = join(TS_DIR, "dist/cli/bin.js")
const roots: Array<string> = []

beforeAll(() => {
  execFileSync(process.execPath, [join(TS_DIR, "node_modules/typescript/bin/tsc"), "-p", join(TS_DIR, "tsconfig.build.json")], { stdio: "inherit" })
}, 180_000)
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const workspaceRoot = (plan: unknown, files: Record<string, string>, jobs: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "cobuild-e2e-"))
  roots.push(root)
  const template = join(root, "template")
  mkdirSync(template)
  writeFileSync(join(template, "cobuild.json"), JSON.stringify(plan))
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(template, p, ".."), { recursive: true })
    writeFileSync(join(template, p), c)
  }
  for (const j of jobs) cpSync(template, join(root, j), { recursive: true })
  return root
}

interface Done {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

const startJob = (root: string, job: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const child: ChildProcess = spawn(process.execPath, [BIN, "run", "--job", job, "--store", `fs:${join(root, "bucket")}`, "--quiet", ...args], {
    cwd: join(root, job),
    env: { ...process.env, COBUILD_SCOPE: "trusted", RUSH_COBUILD_ENABLED: "1", BUILD_LOG: join(root, "build.log"), JOB: job, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()))
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()))
  const done = new Promise<Done>((res) => child.on("close", (code, signal) => res({ code, signal, stdout, stderr })))
  return { child, done }
}

const buildLog = (root: string) => (existsSync(join(root, "build.log")) ? readFileSync(join(root, "build.log"), "utf8").trim().split("\n") : [])

const DIAMOND = {
  operations: [
    { name: "gen", command: "sleep 1; mkdir -p out/gen && cp src/a.txt out/gen/a.txt && echo gen >> \"$BUILD_LOG\"", inputs: ["src"], outputs: ["out/gen"] },
    { name: "core", deps: ["gen"], command: "sleep 1; mkdir -p out/core && (cat out/gen/a.txt; echo core) > out/core/c.txt && echo core >> \"$BUILD_LOG\"", outputs: ["out/core"] },
    { name: "ui", deps: ["gen"], command: "sleep 1; mkdir -p out/ui/assets && echo ui > out/ui/assets/u.txt && echo ui >> \"$BUILD_LOG\"", outputs: ["out/ui"] },
    { name: "test", deps: ["core", "ui"], command: "mkdir -p out/test && cat out/core/c.txt out/ui/assets/u.txt > out/test/report.txt && echo test >> \"$BUILD_LOG\"", outputs: ["out/test"] }
  ]
}
const JOBS = ["primary", "extra1", "extra2"]
const FAST = ["--poll-ms", "300"]

const cliDeps = (cwd: string, env: Record<string, string>) => {
  const out: Array<string> = []
  const err: Array<string> = []
  return { out, err, deps: { env: { COBUILD_SCOPE: "trusted", ...env }, out: (l: string) => void out.push(l), err: (l: string) => void err.push(l), echo: () => undefined, cwd } }
}

describe("cobuild CLI, several processes on one bucket", () => {
  it("three jobs: every command runs exactly once, every workspace is complete, status shows the published locks", async () => {
    const root = workspaceRoot(DIAMOND, { "src/a.txt": "hello\n" }, JOBS)
    const results = await Promise.all(JOBS.map((j) => startJob(root, j, ["--context", "run-1", ...FAST]).done))
    for (const [i, r] of results.entries()) expect(r.code, `${JOBS[i]}: ${r.stderr}`).toBe(0)
    expect(buildLog(root).sort()).toEqual(["core", "gen", "test", "ui"])
    for (const j of JOBS) {
      expect(readFileSync(join(root, j, "out/test/report.txt"), "utf8")).toBe("hello\ncore\nui\n")
      expect(readFileSync(join(root, j, "out/ui/assets/u.txt"), "utf8")).toBe("ui\n")
    }
    const reports = results.map((r) => JSON.parse(r.stdout) as { operations: Array<{ name: string; outcome: string }> })
    const built = reports.flatMap((r) => r.operations.filter((o) => o.outcome === "built").map((o) => o.name)).sort()
    expect(built).toEqual(["core", "gen", "test", "ui"])

    const st = cliDeps(root, {})
    expect(await main(["status", "--context", "run-1", "--store", `fs:${join(root, "bucket")}`], st.deps)).toBe(0)
    const status = JSON.parse(st.out.join("")) as { locks: Array<{ status: string; owner: string }> }
    expect(status.locks).toHaveLength(4)
    expect(status.locks.every((l) => l.status === "succeeded" && JOBS.includes(l.owner))).toBe(true)

    // `cobuild serve` (the Worker's state API, run locally) as the dashboard's --live source.
    const port = 20000 + Math.floor(Math.random() * 20000)
    const server = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--store", `fs:${join(root, "bucket")}`], {
      env: { ...process.env, COBUILD_SCOPE: "trusted", COBUILDS_API_TOKEN: "dash-token" },
      stdio: ["ignore", "ignore", "pipe"]
    })
    try {
      await new Promise<void>((res) => server.stderr!.on("data", (d: Buffer) => (d.toString().includes("state API") ? res() : undefined)))
      const live = await fetchLiveLocks(`http://127.0.0.1:${port}`, "dash-token", "run-1")
      const rows = toLiveRows(live, Date.now(), 0)
      expect(rows).toHaveLength(4)
      expect(rows.every((r) => "state" in r && r.state === "SUCCEEDED")).toBe(true)
      await expect(fetchLiveLocks(`http://127.0.0.1:${port}`, "wrong-token", "run-1")).rejects.toThrow(/401/)
    } finally {
      server.kill()
    }

    // A later CI run (new context) with unchanged inputs: everything comes from the cache, nothing is rebuilt.
    const again = await startJob(root, "extra1", ["--context", "run-2", ...FAST]).done
    expect(again.code).toBe(0)
    expect(buildLog(root)).toHaveLength(4)
    expect(again.stderr).toMatch(/CACHE HIT gen/)
    // Changing an input changes every downstream key: all four rebuild.
    writeFileSync(join(root, "primary/src/a.txt"), "changed\n")
    const changed = await startJob(root, "primary", ["--context", "run-3", ...FAST]).done
    expect(changed.code).toBe(0)
    expect(buildLog(root)).toHaveLength(8)
    expect(readFileSync(join(root, "primary/out/test/report.txt"), "utf8")).toBe("changed\ncore\nui\n")
  }, 120_000)

  it("crash and takeover: the holder is killed (SIGKILL) mid-build; another job takes over after the lease and finishes", async () => {
    const plan = { operations: [{ name: "slow", command: "echo start-$JOB >> \"$BUILD_LOG\"; sleep 4; mkdir -p out && echo $JOB > out/who.txt", outputs: ["out"] }] }
    const root = workspaceRoot(plan, {}, ["A", "B"])
    const lease = ["--context", "crash", "--lease-ms", "4000", "--renew-ms", "1000", "--max-latency-ms", "1000", "--poll-ms", "300"]
    const a = startJob(root, "A", lease)
    while (!buildLog(root).includes("start-A")) await new Promise((r) => setTimeout(r, 100))
    const b = startJob(root, "B", lease)
    await new Promise((r) => setTimeout(r, 1500))
    a.child.kill("SIGKILL")
    const killedAt = Date.now()
    const rb = await b.done
    expect((await a.done).signal).toBe("SIGKILL")
    expect(rb.code, rb.stderr).toBe(0)
    expect(rb.stderr).toMatch(/WAITING {3}slow/)
    expect(buildLog(root)).toContain("start-B")
    expect(readFileSync(join(root, "B/out/who.txt"), "utf8")).toBe("B\n")
    // B cannot have started before A's last lease ran out (≤ 4 s after the kill, plus B's build of 4 s).
    expect(Date.now() - killedAt).toBeGreaterThan(4000)
  }, 60_000)

  it("a failing operation runs once; the other jobs fail fast with its log; dependents are skipped", async () => {
    const plan = {
      operations: [
        { name: "base", command: "sleep 1; mkdir -p out/base && echo b > out/base/b.txt && echo base >> \"$BUILD_LOG\"", outputs: ["out/base"] },
        { name: "tests", deps: ["base"], command: "echo tests >> \"$BUILD_LOG\"; echo '3 of 120 tests failed: expected 4, got 5'; exit 3" },
        { name: "package", deps: ["tests"], command: "echo package >> \"$BUILD_LOG\"" }
      ]
    }
    const root = workspaceRoot(plan, {}, JOBS)
    const results = await Promise.all(JOBS.map((j) => startJob(root, j, ["--context", "fail-1", ...FAST]).done))
    for (const r of results) expect(r.code).toBe(1)
    expect(buildLog(root).sort()).toEqual(["base", "tests"])
    const reports = results.map((r) => JSON.parse(r.stdout) as { operations: Array<{ name: string; outcome: string }> })
    const outcome = (n: string) => reports.map((r) => r.operations.find((o) => o.name === n)!.outcome).sort()
    expect(outcome("tests")).toEqual(["build-failed", "failed-elsewhere", "failed-elsewhere"])
    expect(outcome("package")).toEqual(["skipped", "skipped", "skipped"])
    const fastFailers = results.filter((r) => /failed in another job/.test(r.stderr))
    expect(fastFailers).toHaveLength(2)
    for (const r of fastFailers) expect(r.stderr).toMatch(/3 of 120 tests failed/)
  }, 60_000)
})

describe("cobuild cache save / restore (GitHub-cache-style)", () => {
  it("restores the saved paths byte for byte; a changed hash file misses; GITHUB_OUTPUT gets cache-hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "cobuild-cache-"))
    roots.push(root)
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true })
    writeFileSync(join(root, "package-lock.json"), '{"v":1}')
    writeFileSync(join(root, "node_modules/pkg/index.js"), "module.exports = 1\n")
    writeFileSync(join(root, "node_modules/pkg/empty"), "")
    const out = join(root, "gh-output")
    const store = ["--store", `fs:${join(root, "bucket")}`]
    const args = ["--name", "deps", "--path", "node_modules", "--hash-files", "package-lock.json", ...store]
    const save = cliDeps(root, { GITHUB_OUTPUT: out })
    expect(await main(["cache", "save", ...args], save.deps)).toBe(0)
    expect(JSON.parse(save.out[0]!)).toMatchObject({ files: 2, result: "published" })
    rmSync(join(root, "node_modules"), { recursive: true })
    const hit = cliDeps(root, { GITHUB_OUTPUT: out })
    expect(await main(["cache", "restore", ...args], hit.deps)).toBe(0)
    expect(JSON.parse(hit.out[0]!)).toMatchObject({ hit: true })
    expect(readFileSync(join(root, "node_modules/pkg/index.js"), "utf8")).toBe("module.exports = 1\n")
    expect(readFileSync(join(root, "node_modules/pkg/empty"), "utf8")).toBe("")
    writeFileSync(join(root, "package-lock.json"), '{"v":2}')
    const miss = cliDeps(root, { GITHUB_OUTPUT: out })
    expect(await main(["cache", "restore", ...args], miss.deps)).toBe(0)
    expect(JSON.parse(miss.out[0]!)).toMatchObject({ hit: false, reason: "not_found" })
    expect(await main(["cache", "restore", ...args, "--fail-on-miss"], cliDeps(root, {}).deps)).toBe(1)
    expect(readFileSync(out, "utf8")).toMatch(/cache-key=blake3:[0-9a-f]{64}\ncache-hit=true\ncache-hit=false\n/)
  })

  it("usage and configuration errors exit 2 with a message", async () => {
    const d = cliDeps(tmpdir(), {})
    expect(await main(["run", "--plan", "x.json", "--store", "fs:/tmp/x"], d.deps)).toBe(1) // missing file: runtime error
    const noStore = cliDeps(tmpdir(), { RUSH_COBUILD_CONTEXT: "c" })
    expect(await main(["status"], noStore.deps)).toBe(2)
    expect(noStore.err.join("\n")).toMatch(/no store configured/)
    const partial = cliDeps(tmpdir(), { R2_BUCKET: "b" })
    expect(await main(["status", "--context", "c"], partial.deps)).toBe(2)
    expect(partial.err.join("\n")).toMatch(/missing: R2_ACCESS_KEY_ID/)
    expect(await main(["bogus"], cliDeps(tmpdir(), {}).deps)).toBe(2)
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("hardening: secrets, scope, opt-in, input validation, timeouts, signals", () => {
  it("build commands never see the job's credentials, but do see its other variables", async () => {
    const plan = { operations: [{ name: "dump", command: "mkdir -p out && env > out/env.txt", outputs: ["out"] }] }
    const root = workspaceRoot(plan, {}, ["A"])
    const secrets = {
      R2_SECRET_ACCESS_KEY: "r2-secret-value",
      R2_ACCESS_KEY_ID: "r2-key-id-value",
      CLOUDFLARE_API_TOKEN: "cf-token-value",
      AWS_SECRET_ACCESS_KEY: "aws-secret-value",
      COBUILDS_API_TOKEN: "dash-token-value",
      BAYESECT_API_TOKEN: "bayesect-token-value",
      MY_DEPLOY_KEY: "custom-secret-value",
      COBUILD_STRIP_ENV: "my_deploy_key",
      HARMLESS_SETTING: "visible-value"
    }
    const r = await startJob(root, "A", ["--context", "env-1", ...FAST], secrets).done
    expect(r.code, r.stderr).toBe(0)
    const dumped = readFileSync(join(root, "A/out/env.txt"), "utf8")
    for (const [k, v] of Object.entries(secrets)) {
      if (k === "HARMLESS_SETTING" || k === "COBUILD_STRIP_ENV") continue
      expect(dumped, k).not.toContain(v)
      expect(dumped, k).not.toMatch(new RegExp(`^${k}=`, "m"))
    }
    expect(dumped).toMatch(/^HARMLESS_SETTING=visible-value$/m)
    expect(dumped).toMatch(/^JOB=A$/m)
    expect(dumped).toMatch(/^COBUILD_OPERATION=dump$/m)
  }, 60_000)

  it("a run without a scope, with a malformed RUSH_COBUILD_ENABLED or a malformed COBUILD_FS_RATE_LIMIT_MS is a usage error (exit 2)", async () => {
    const plan = { operations: [{ name: "x", command: "true" }] }
    const root = workspaceRoot(plan, {}, ["A"])
    const store = ["--store", `fs:${join(root, "bucket")}`]
    const noScope = cliDeps(join(root, "A"), { RUSH_COBUILD_CONTEXT: "c" })
    expect(await main(["run", ...store], { ...noScope.deps, env: { RUSH_COBUILD_CONTEXT: "c" } })).toBe(2)
    expect(noScope.err.join("\n")).toMatch(/no cache scope/)
    for (const bad of ["maybe", "2", "enabled"]) {
      const d = cliDeps(join(root, "A"), { RUSH_COBUILD_CONTEXT: "c", RUSH_COBUILD_ENABLED: bad })
      expect(await main(["run", ...store], d.deps), bad).toBe(2)
      expect(d.err.join("\n")).toMatch(/RUSH_COBUILD_ENABLED/)
    }
    for (const bad of ["abc", "-1", "1.5", "NaN", "Infinity"]) {
      const d = cliDeps(join(root, "A"), { RUSH_COBUILD_CONTEXT: "c", COBUILD_FS_RATE_LIMIT_MS: bad })
      expect(await main(["run", ...store], d.deps), bad).toBe(2)
      expect(d.err.join("\n")).toMatch(/COBUILD_FS_RATE_LIMIT_MS/)
    }
  })

  it("cobuilds are opt-in: without RUSH_COBUILD_ENABLED the run builds locally and says so", async () => {
    const plan = { operations: [{ name: "x", command: "mkdir -p out && echo x > out/x", outputs: ["out"] }] }
    const root = workspaceRoot(plan, {}, ["A"])
    const r = await startJob(root, "A", ["--context", "optin", ...FAST], { RUSH_COBUILD_ENABLED: "" }).done
    expect(r.code, r.stderr).toBe(0)
    expect(r.stderr).toMatch(/cobuilds disabled/)
    const on = await startJob(root, "A", ["--context", "optin-2", ...FAST]).done
    expect(on.stderr).not.toMatch(/cobuilds disabled/)
  }, 60_000)

  it("--op-timeout-ms / timeoutMs kill the whole process group and fail the operation", async () => {
    const plan = {
      operations: [
        { name: "hang", command: "sleep 60 & echo $! > bg.pid; sleep 60", timeoutMs: 800 },
        { name: "after", deps: ["hang"], command: "echo after >> \"$BUILD_LOG\"" }
      ]
    }
    const root = workspaceRoot(plan, {}, ["A"])
    const started = Date.now()
    const r = await startJob(root, "A", ["--context", "timeout", ...FAST]).done
    expect(r.code).toBe(1)
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(r.stderr).toMatch(/FAILED {4}hang/)
    const report = JSON.parse(r.stdout) as { operations: Array<{ name: string; outcome: string }> }
    expect(report.operations.map((o) => o.outcome)).toEqual(["build-failed", "skipped"])
    const bg = Number(readFileSync(join(root, "A/bg.pid"), "utf8").trim())
    for (let i = 0; i < 50 && alive(bg); i++) await new Promise((res) => setTimeout(res, 100))
    expect(alive(bg)).toBe(false)
    // The flag applies to operations without their own limit.
    const plan2 = { operations: [{ name: "hang2", command: "sleep 60" }] }
    const root2 = workspaceRoot(plan2, {}, ["A"])
    const r2 = await startJob(root2, "A", ["--context", "timeout-2", "--op-timeout-ms", "800", ...FAST]).done
    expect(r2.code).toBe(1)
    expect(r2.stderr).toMatch(/FAILED {4}hang2/)
  }, 60_000)

  it("SIGTERM: the holder exits 130 after abandoning its lock, and another job takes over at once (not after the lease)", async () => {
    const plan = { operations: [{ name: "slow", command: "echo start-$JOB >> \"$BUILD_LOG\"; sleep 3; mkdir -p out && echo $JOB > out/who.txt", outputs: ["out"] }] }
    const root = workspaceRoot(plan, {}, ["A", "B"])
    // A 60 s lease: waiting it out would blow the bound checked below.
    const lease = ["--context", "sigterm", "--lease-ms", "60000", "--renew-ms", "5000", "--poll-ms", "300"]
    const a = startJob(root, "A", lease)
    while (!buildLog(root).includes("start-A")) await new Promise((r) => setTimeout(r, 100))
    const b = startJob(root, "B", lease)
    await new Promise((r) => setTimeout(r, 1000))
    const termAt = Date.now()
    a.child.kill("SIGTERM")
    const ra = await a.done
    expect(ra.code, ra.stderr).toBe(130)
    expect(ra.stderr).toMatch(/interrupted/)
    const rb = await b.done
    expect(rb.code, rb.stderr).toBe(0)
    expect(readFileSync(join(root, "B/out/who.txt"), "utf8")).toBe("B\n")
    expect(Date.now() - termAt).toBeLessThan(20_000)
  }, 60_000)
})

describe("runMain at the process boundary (the built facade, as the CLI entry points use it)", () => {
  const FX = pathToFileURL(join(TS_DIR, "dist/fx/index.js")).href
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cobuild-runmain-"))
    roots.push(dir)
    const file = join(dir, "main.mjs")
    writeFileSync(file, `import { Effect, fromAbortablePromise, runMain } from ${JSON.stringify(FX)}\n${body}\n`)
    return file
  }
  const runScript = (file: string) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()))
    const done = new Promise<Done>((res) => child.on("close", (code, signal) => res({ code, signal, stdout, stderr })))
    const started = new Promise<void>((res) => child.stdout!.on("data", (d: Buffer) => (d.toString().includes("started") ? res() : undefined)))
    return { child, done, started }
  }

  it("a numeric success is the exit status; a failure is reported and exits 1", async () => {
    expect((await runScript(script("runMain(Effect.succeed(7))")).done).code).toBe(7)
    expect((await runScript(script("runMain(Effect.succeed('done'))")).done).code).toBe(0)
    const failed = await runScript(script("runMain(Effect.fail(new Error('boom-failure')))")).done
    expect(failed.code).toBe(1)
    expect(failed.stderr).toMatch(/boom-failure/)
  }, 30_000)

  it("SIGINT interrupts the main fiber: finalizers run before the process exits 130", async () => {
    const s = runScript(
      script(`runMain(Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => process.stdout.write("finalized\\n")))
  process.stdout.write("started\\n")
  return yield* Effect.never
})))`)
    )
    await s.started
    s.child.kill("SIGINT")
    const r = await s.done
    expect(r.code, JSON.stringify(r)).toBe(130)
    expect(r.stdout).toMatch(/started\nfinalized\n/)
  }, 30_000)

  it("fromAbortablePromise: the signal aborts the promise and its teardown completes before exit", async () => {
    const s = runScript(
      script(`runMain(fromAbortablePromise((signal) => new Promise((resolve) => {
  const work = setInterval(() => undefined, 1000)
  process.stdout.write("started\\n")
  signal.addEventListener("abort", () => setTimeout(() => { clearInterval(work); process.stdout.write("teardown done\\n"); resolve(0) }, 300))
})), { onSignal: (sig) => process.stdout.write("signal " + sig + "\\n") })`)
    )
    await s.started
    s.child.kill("SIGTERM")
    const r = await s.done
    expect(r.code, JSON.stringify(r)).toBe(130)
    expect(r.stdout).toMatch(/started\nsignal SIGTERM\nteardown done\n/)
  }, 30_000)
})
