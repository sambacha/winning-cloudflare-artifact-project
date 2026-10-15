/**
 * CI workflow on push: green records the last green tip; a red tip is
 * re-run; only an intermittent failure with a known-good baseline starts a
 * bisection (session + BisectWorkflow instance), with the reruns as the
 * new-side rate prior. Non-branch refs are ignored; payload shapes are
 * normalised.
 */
import { describe, expect, it } from "vitest"
import { makeMemorySessionStore } from "../../src/bisect/session.js"
import { Effect } from "../../src/fx/index.js"
import { type CiDriverDeps, ciSessionId, InvalidPushEvent, lastGreenKey, parsePushEvent, runCiDriver, startOrLoadSession } from "../../src/workflows/ciDriver.js"
import { makeLocalSteps, memoryJournal, SimulatedCrash } from "../../src/workflows/localSteps.js"
import { makeFakeNamespace, makeRepo } from "../bisect/fakeArtifacts.js"
import { makeConditionalBucket, makeScriptedSandboxes, oid, type Script } from "./fakes.js"

const push = (commit: string, ref = "refs/heads/main") => ({ type: "cf.artifacts.repo.pushed", payload: { repo: "demo", ref, after: commit } })

const depsFor = (script: Script) => {
  const bucket = makeConditionalBucket()
  const sb = makeScriptedSandboxes(script)
  const started: Array<unknown> = []
  const launched: Array<unknown> = []
  let n = 0
  const deps: CiDriverDeps = {
    bucket,
    credentials: () => Effect.succeed({ remote: "https://artifacts.invalid/demo.git", token: "read" }),
    sandbox: sb.factory,
    predicate: { command: "npm test", timeoutSec: 60, noInstall: true },
    startBisect: (p) => Effect.sync(() => (started.push(p), { id: "sess-1", session: null as never })),
    launchBisect: (p) => Effect.sync(() => (launched.push(p), `wf-${p.sessionId}`)),
    freshId: () => String(++n)
  }
  return { deps, bucket, sb, started, launched }
}

const run = (raw: unknown, deps: CiDriverDeps) => runCiDriver(raw, makeLocalSteps({ journal: memoryJournal() }), deps)

describe("parsePushEvent", () => {
  it("accepts the envelope or the bare payload, and aliases", () => {
    const c = oid(7)
    expect(parsePushEvent(push(c))).toEqual({ repo: "demo", ref: "refs/heads/main", branch: "main", commit: c })
    expect(parsePushEvent({ repository: { name: "demo" }, ref: "refs/heads/feat/x", commit: c })).toEqual({ repo: "demo", ref: "refs/heads/feat/x", branch: "feat/x", commit: c })
    expect(parsePushEvent({ type: "x", data: { repoName: "demo", ref: "refs/heads/main", sha: c } })?.repo).toBe("demo")
  })
  it("ignores tags and notes; rejects malformed events", () => {
    expect(parsePushEvent(push(oid(1), "refs/notes/commits"))).toBeNull()
    expect(parsePushEvent(push(oid(1), "refs/tags/v1"))).toBeNull()
    expect(() => parsePushEvent({ ref: "refs/heads/main" })).toThrow(InvalidPushEvent)
    expect(() => parsePushEvent(push("abc"))).toThrow(InvalidPushEvent)
    expect(() => parsePushEvent(null)).toThrow(InvalidPushEvent)
  })
})

describe("CI driver", () => {
  it("green: records the last green tip with conditional writes only", async () => {
    const { deps, bucket, started } = depsFor(() => 0)
    expect(await run(push(oid(5)), deps)).toEqual({ kind: "green", commit: oid(5) })
    expect(JSON.parse(bucket.objects.get(lastGreenKey("demo", "main"))!.body).commit).toBe(oid(5))
    expect(await run(push(oid(6)), deps)).toMatchObject({ kind: "green" })
    expect(JSON.parse(bucket.objects.get(lastGreenKey("demo", "main"))!.body).commit).toBe(oid(6))
    expect(bucket.unconditional).toEqual([])
    expect(started).toEqual([])
  })

  it("deterministic red: reruns, starts nothing", async () => {
    const { deps, sb, started } = depsFor(() => 1)
    await run(push(oid(5)), depsFor(() => 0).deps)
    const out = await run(push(oid(9)), deps)
    expect(out).toEqual({ kind: "red-deterministic", commit: oid(9), runs: 5 })
    expect(sb.predicateRuns).toHaveLength(5)
    expect(started).toEqual([])
  })

  it("intermittent red without a baseline starts nothing", async () => {
    const { deps, started } = depsFor((_, a) => (a % 2 === 1 ? 1 : 0))
    expect(await run(push(oid(9)), deps)).toMatchObject({ kind: "intermittent-no-baseline" })
    expect(started).toEqual([])
  })

  it("intermittent red after a green tip starts and launches a bisection with the reruns as prior", async () => {
    // Runs at oid(9): fail, pass, fail, fail, pass -> 3/5.
    const pattern = [1, 0, 1, 1, 0]
    const { deps, started, launched } = depsFor((c, a) => (c === oid(9) ? pattern[a - 1]! : 0))
    expect(await run(push(oid(5)), deps)).toMatchObject({ kind: "green" })
    const out = await run(push(oid(9)), deps)
    expect(out).toEqual({ kind: "bisecting", commit: oid(9), good: oid(5), failRate: 0.6, sessionId: "sess-1", instanceId: "wf-sess-1" })
    expect(started).toEqual([{ repo: "demo", good: oid(5), bad: oid(9), newRate: { kind: "beta", alpha: 4, beta: 3 } }])
    expect(launched).toEqual([{ sessionId: "sess-1", fallbackBranch: "main" }])
  })

  it("a non-branch push runs nothing", async () => {
    const { deps, sb } = depsFor(() => 0)
    expect(await run(push(oid(1), "refs/notes/commits"), deps)).toMatchObject({ kind: "ignored" })
    expect(sb.created()).toBe(0)
  })

  it("an intermittent red after a red tip does not start a second bisection", async () => {
    const pattern = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0]
    const { deps, started } = depsFor((c, a) => (c === oid(5) ? 0 : pattern[(a - 1) % pattern.length]!))
    await run(push(oid(5)), deps)
    expect(await run(push(oid(9)), deps)).toMatchObject({ kind: "bisecting" })
    expect(await run(push(oid(10)), deps)).toMatchObject({ kind: "intermittent-no-baseline", previousTip: "red" })
    expect(started).toHaveLength(1)
  })

  it("restart after a crash replays completed runs instead of re-running them", async () => {
    const pattern = [1, 0, 1, 1, 0]
    const { deps, sb, launched } = depsFor((c, a) => (c === oid(9) ? pattern[a - 1]! : 0))
    await run(push(oid(5)), deps)
    const journal = memoryJournal()
    await expect(runCiDriver(push(oid(9)), makeLocalSteps({ journal, crashBefore: 5 }), deps)).rejects.toBeInstanceOf(SimulatedCrash)
    const before = sb.predicateRuns.length
    const out = await runCiDriver(push(oid(9)), makeLocalSteps({ journal }), deps)
    expect(out).toMatchObject({ kind: "bisecting", failRate: 0.6 })
    expect(sb.predicateRuns.length - before).toBe(2)
    expect(launched).toHaveLength(1)
  })
})

describe("startOrLoadSession", () => {
  it("creates once under a deterministic id; a repeat loads the same session", async () => {
    const { repo, mainline } = makeRepo(10)
    const artifacts = makeFakeNamespace({ demo: repo }, { idField: "id" })
    const store = makeMemorySessionStore()
    const start = startOrLoadSession(artifacts, store)
    const p = { repo: "demo", good: mainline[2]!, bad: mainline[8]!, newRate: { kind: "beta" as const, alpha: 4, beta: 3 } }
    const a = await Effect.runPromise(start(p))
    const b = await Effect.runPromise(start(p))
    expect(a.id).toBe(await Effect.runPromise(ciSessionId("demo", mainline[8]!)))
    expect(b.id).toBe(a.id)
    expect(store.size()).toBe(1)
    expect(a.session.candidates.map((c) => c.oid)).toEqual(mainline.slice(3, 9))
    expect(a.session.newRate).toEqual(p.newRate)
  })
})
