/**
 * Acceptance on the demo monorepo, end to end and offline: the real driver,
 * real Git checkouts by commit id, real `npm test`, `node_modules` through
 * the R2 cache (a filesystem bucket with R2's conditional-write contract).
 *
 * A1 With the pinned seed `a`, rates known (new 0.8, old 0), the bisection
 *    names commit 34 with confidence >= 0.95 in under 10 predicate runs, and
 *    records at least one skip (the hanging test at commit 22 times out).
 * A2 Killing the process (SIGKILL) mid-bisection and starting it again
 *    resumes from R2 + the step journal: no observation lost, no completed
 *    step run again, and the final session equals the uninterrupted one.
 * A3 node_modules: hit rate over three bisections sharing the cache >= 80%.
 *
 * The seed is pinned so the test is reproducible; over random seeds the step
 * count varies (see docs/feature-slice-preflight.md for the simulation).
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { parseSession, sessionStatus } from "../../src/bisect/session.js"
import { demoState, runLocalBisectDemo } from "../../src/demo/bisectDemo.js"
import { DEMO } from "../../src/demo/demoRepo.js"
import { sessionKey } from "../../src/worker/bisectStore.js"
import { SessionId } from "../../src/ids.js"

const SEED = "a"
const TIMEOUT_SEC = 6
const here = path.dirname(new URL(import.meta.url).pathname)
const tsRoot = path.resolve(here, "../..")

const storedSession = async (state: string, id = "demo") => {
  const o = await demoState(state).bucket.getBytes(sessionKey("demo", SessionId(id)))
  return parseSession(JSON.parse(new TextDecoder().decode(o!.body)))
}

let reference: Awaited<ReturnType<typeof runLocalBisectDemo>>
let refState = ""

beforeAll(async () => {
  refState = mkdtempSync(path.join(tmpdir(), "acc-ref-"))
  reference = await runLocalBisectDemo({ state: refState, seed: SEED, timeoutSec: TIMEOUT_SEC })
}, 600_000)

describe("bisect acceptance on the demo monorepo", () => {
  it("A1: commit 34, confidence >= 0.95, under 10 steps, at least one skip", async () => {
    const s = await storedSession(refState)
    const st = sessionStatus(s)
    expect(st.culprit.message).toMatch(new RegExp(`^${DEMO.culprit}: `))
    expect(st.confidence).toBeGreaterThanOrEqual(0.95)
    expect(s.events.length).toBeLessThan(10)
    expect(s.events.filter((e) => e.kind === "skip").length).toBeGreaterThanOrEqual(1)
    const hang = s.candidates.find((c) => c.message?.startsWith(`${DEMO.hang}: `))!
    expect(s.events.find((e) => e.oid === hang.oid)?.kind).toBe("skip")
    expect(reference.result.culprit.oid).toBe(st.culprit.oid)
  })

  it("A2: SIGKILL mid-bisection, restart, resume with no lost observations and no replayed steps", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "acc-kill-"))
    const journal = demoState(state).journal("demo")
    const child = spawn(process.execPath, ["node_modules/vite-node/vite-node.mjs", "src/demo/bisectDemoBin.ts", "--state", state, "--seed", SEED, "--timeout", String(TIMEOUT_SEC)], {
      cwd: tsRoot,
      stdio: ["ignore", "pipe", "pipe"]
    })
    // Kill as soon as record-3 is checkpointed (the next step is then running).
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (existsSync(journal) && (JSON.parse(readFileSync(journal, "utf8")) as Array<[string]>).some(([n]) => n === "record-3")) {
          clearInterval(timer)
          child.kill("SIGKILL")
          resolve()
        }
      }, 50)
      child.on("exit", (code) => {
        clearInterval(timer)
        if (code === 0) reject(new Error("finished before it could be killed"))
      })
    })
    await new Promise((r) => child.once("close", r))
    const before = (JSON.parse(readFileSync(journal, "utf8")) as Array<[string]>).map(([n]) => n)
    const resumed = await runLocalBisectDemo({ state, seed: SEED, timeoutSec: TIMEOUT_SEC })
    // Nothing checkpointed before the kill ran again.
    expect(resumed.ran.filter((n) => before.includes(n))).toEqual([])
    expect(resumed.replayed).toEqual(expect.arrayContaining(before))
    // Same observations as the uninterrupted run, each recorded once.
    const s = await storedSession(state)
    const ref = await storedSession(refState)
    const strip = (x: typeof s) => x.events.map((e) => ({ ...e, at: 0 }))
    expect(strip(s)).toEqual(strip(ref))
    expect(new Set(s.events.map((e) => e.step)).size).toBe(s.events.length)
  }, 600_000)

  it("A3: node_modules hit rate over three bisections sharing the cache is >= 80%", async () => {
    const outcomes = reference.tests.map((t) => t.nodeModules?.outcome)
    for (const id of ["demo-2", "demo-3"]) {
      const out = await runLocalBisectDemo({ state: refState, seed: SEED, timeoutSec: TIMEOUT_SEC, sessionId: id })
      outcomes.push(...out.tests.map((t) => t.nodeModules?.outcome))
    }
    const hits = outcomes.filter((o) => o === "hit").length
    const misses = outcomes.filter((o) => o === "miss").length
    // Steps that never reached the install are excluded (none expected here).
    expect(hits / (hits + misses)).toBeGreaterThanOrEqual(0.8)
    // At most one miss per distinct lockfile (5 in the demo history).
    expect(misses).toBeLessThanOrEqual(5)
  }, 600_000)
})
