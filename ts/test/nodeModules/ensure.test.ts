/**
 * `ensureNodeModules` end to end on a filesystem bucket (`src/fsBucket.ts`,
 * the same create-only contract as R2) with real `tar`/`gzip`.
 *
 * E1 First run: miss, the install runs, the entry is published.
 *    Second run on a fresh checkout: hit, no install, identical tree.
 *    A changed lockfile misses again.
 * E2 Hit rate over three runs of the same lockfile is 2/3 at the first
 *    lockfile and 100% from then on.
 * E3 A failed store or a corrupt entry falls back to installing; a failing
 *    install is the only error.
 * E4 Measured: restoring the real 111 MB `ts/node_modules` (when present on
 *    disk) takes under 3 s. The "cold install" here is a copy of that tree,
 *    because this environment has no registry access. The 3 s bound is a
 *    wall-clock benchmark, so it is asserted only when the test runs on its
 *    own (`npm run test:bench`, which sets `NM_BENCH=1`): inside the full
 *    parallel suite the machine is shared with dozens of other test files
 *    and the same restore was measured at about 4.5 s (about 1.6 s alone).
 *    In the full suite the test still checks that the hit restores the tree.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { announce } from "../harness.js"
import { makeFsBucket } from "../../src/fsBucket.js"
import { Effect, Exit } from "../../src/fx/index.js"
import { ensureNodeModules as ensureIn } from "../../src/nodeModules/ensure.js"
import { makeLocalWorkspace } from "../../src/nodeModules/localWorkspace.js"
import { makeMemoryBlobStore } from "../../src/cache/blobStore.js"
import { manifestKey, nodeModulesKey, sha256Hex } from "../../src/nodeModules/key.js"
import { StoreFailure } from "../../src/store.js"

announce("test/nodeModules/ensure.test.ts")

const ensureNodeModules = (o: { dir: string } & Omit<Parameters<typeof ensureIn>[0], "workspace">) => {
  const { dir, ...rest } = o
  return ensureIn({ ...rest, workspace: makeLocalWorkspace(dir) })
}

const FAKE_INSTALL = [
  "sh",
  "-c",
  "mkdir -p node_modules/left-pad && printf 'module.exports = 1\\n' > node_modules/left-pad/index.js && cp package-lock.json node_modules/.package-lock.json && echo installed >> install.log"
]

const project = (lock: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "nm-proj-"))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }))
  writeFileSync(path.join(dir, "package-lock.json"), lock)
  return dir
}
const installs = (dir: string): number => (existsSync(path.join(dir, "install.log")) ? readFileSync(path.join(dir, "install.log"), "utf8").trim().split("\n").length : 0)

describe("ensureNodeModules (E1-E3)", () => {
  it("E1/E2: miss + publish, then hits on fresh checkouts; a new lockfile misses", async () => {
    const bucket = makeFsBucket(mkdtempSync(path.join(tmpdir(), "nm-bucket-")), { rateLimitMs: 0 })
    const lockA = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.0.0" } } })
    const outcomes: string[] = []
    let firstKey = ""
    for (let run = 0; run < 3; run++) {
      const dir = project(lockA)
      const r = await Effect.runPromise(ensureNodeModules({ dir, store: bucket.blobStore, runId: `run-a-${run}`, install: FAKE_INSTALL, npmVersion: "10.0.0" }))
      outcomes.push(r.outcome)
      if (run === 0) {
        firstKey = r.key
        expect(r.publish).toBe("published")
        expect(installs(dir)).toBe(1)
      } else {
        expect(r.key).toBe(firstKey)
        expect(installs(dir)).toBe(0)
        expect(readFileSync(path.join(dir, "node_modules/left-pad/index.js"), "utf8")).toBe("module.exports = 1\n")
      }
    }
    expect(outcomes).toEqual(["miss", "hit", "hit"])
    const dirB = project(lockA.replace("1.0.0", "1.0.1"))
    const rb = await Effect.runPromise(ensureNodeModules({ dir: dirB, store: bucket.blobStore, runId: "run-b-0", install: FAKE_INSTALL, npmVersion: "10.0.0" }))
    expect(rb.outcome).toBe("miss")
    expect(rb.key).not.toBe(firstKey)
    // Every run left a report.
    const events = await bucket.list({ prefix: "nm-cache/v1/events/" })
    expect(events.objects.length).toBe(4)
  })

  it("E3: store failures and corrupt entries fall back to installing; a failing install is an error", async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } })
    const failing = {
      putIfNoneMatch: (key: string) => Effect.fail(new StoreFailure({ key, cause: "down" })),
      getStream: (key: string) => Effect.fail(new StoreFailure({ key, cause: "down" }))
    }
    const dir = project(lock)
    const r = await Effect.runPromise(ensureNodeModules({ dir, store: failing, runId: "x", install: FAKE_INSTALL, npmVersion: "10.0.0" }))
    expect(r).toMatchObject({ outcome: "miss", missReason: "store-error", publish: "failed" })
    expect(installs(dir)).toBe(1)

    const corrupt = makeMemoryBlobStore()
    const dir2 = project(lock)
    const key = nodeModulesKey({ lockfileSha256: await sha256Hex(new TextEncoder().encode(lock)), abi: process.versions.modules, platform: process.platform, arch: process.arch })
    corrupt.forcePut(manifestKey(key), new TextEncoder().encode("{not json"))
    const r2 = await Effect.runPromise(ensureNodeModules({ dir: dir2, store: corrupt, runId: "y", install: FAKE_INSTALL, npmVersion: "10.0.0" }))
    expect(r2).toMatchObject({ outcome: "miss", missReason: "corrupt", publish: "failed" })

    const exit = await Effect.runPromiseExit(ensureNodeModules({ dir: project(lock), store: makeMemoryBlobStore(), runId: "z", install: ["sh", "-c", "exit 7"], npmVersion: "1" }))
    expect(Exit.isFailure(exit) && JSON.stringify(exit).includes("CommandFailed")).toBe(true)
  })
})

const realNodeModules = path.resolve(import.meta.dirname, "../../node_modules")

describe.skipIf(!existsSync(path.join(realNodeModules, ".package-lock.json")))("restore time of the real ts/node_modules (E4)", () => {
  it("E4: a hit restores the 111 MB tree (in under 3 s when run alone with NM_BENCH=1)", async () => {
    const bucket = makeFsBucket(mkdtempSync(path.join(tmpdir(), "nm-bucket-real-")), { rateLimitMs: 0 })
    const lock = readFileSync(path.resolve(realNodeModules, "../package-lock.json"), "utf8")
    const copyInstall = ["sh", "-c", `cp -a ${JSON.stringify(realNodeModules)} node_modules`]
    const cold = project(lock)
    const r1 = await Effect.runPromise(ensureNodeModules({ dir: cold, store: bucket.blobStore, runId: "real-0", install: copyInstall, npmVersion: "10.0.0" }))
    expect(r1.outcome).toBe("miss")
    expect(r1.publish).toBe("published")
    const warm = project(lock)
    mkdirSync(path.join(warm, "node_modules"))
    const r2 = await Effect.runPromise(ensureNodeModules({ dir: warm, store: bucket.blobStore, runId: "real-1", install: ["sh", "-c", "exit 1"], npmVersion: "10.0.0" }))
    const sizeMb = Number(execFileSync("du", ["-sm", path.join(warm, "node_modules")]).toString().split("\t")[0])
    console.log(`[measure] node_modules ${sizeMb} MB, tarball ${r1.manifest!.tarballBytes} bytes, cold copy ${r1.durationMs} ms, restore ${r2.durationMs} ms`)
    expect(r2.outcome).toBe("hit")
    if (process.env["NM_BENCH"] === "1") expect(r2.durationMs).toBeLessThan(3000)
    expect(existsSync(path.join(warm, "node_modules/typescript/package.json"))).toBe(true)
  }, 180_000)
})
