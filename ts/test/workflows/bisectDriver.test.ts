/**
 * The durable bisect driver under crashes: whatever step the instance dies
 * at (between steps, or after a step's side effects but before its output
 * was checkpointed), a restarted instance finishes the same bisection with
 * no lost observations and no completed step run twice. R2 (the session
 * object) is the source of truth; step outputs repair it if R2 lost a write.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { type BisectSession, makeSession, parseSession, sessionStatus } from "../../src/bisect/session.js"
import { Duration, Effect } from "../../src/fx/index.js"
import { SessionId } from "../../src/ids.js"
import { makeR2SessionStore, sessionKey } from "../../src/worker/bisectStore.js"
import { makeR2ResultStore, resultKey } from "../../src/worker/resultStore.js"
import { type BisectDriverDeps, type BisectDriverParams, runBisectDriver, stepKey } from "../../src/workflows/bisectDriver.js"
import { makeLocalSteps, memoryJournal, SimulatedCrash, type StepJournal } from "../../src/workflows/localSteps.js"
import { type ConditionalBucket, makeConditionalBucket, makeScriptedSandboxes, oid, type Script } from "./fakes.js"

const N = 30
const CULPRIT = 20
const HANG = 11
const SCOPE = "test"
const ID = SessionId("s-driver")

/** Deterministic 80% flake at and after the culprit, a hang at HANG, passes before. */
const script: Script = (commit, attempt) => {
  const i = parseInt(commit, 16)
  if (i === HANG) return 124
  if (i < CULPRIT) return 0
  const u = createHash("sha256").update(`${commit}:${attempt}`).digest().readUInt32BE(0) / 2 ** 32
  return u < 0.8 ? 1 : 0
}

const freshSession = (): BisectSession =>
  makeSession({
    repo: "demo",
    goodRef: oid(0),
    badRef: "main",
    good: { oid: oid(0) },
    candidates: Array.from({ length: N }, (_, j) => ({ oid: oid(j + 1) })),
    newRate: { kind: "known", p: 0.8 },
    oldRate: { kind: "known", p: 0 },
    now: 0
  })

const setup = async () => {
  const bucket = makeConditionalBucket()
  const sessions = makeR2SessionStore(bucket, SCOPE)
  await Effect.runPromise(sessions.create(ID, freshSession()))
  return { bucket, sessions, results: makeR2ResultStore(bucket) }
}

const depsFor = (env: Awaited<ReturnType<typeof setup>>, sandboxes: ReturnType<typeof makeScriptedSandboxes>): BisectDriverDeps => {
  let n = 0
  return {
    sessions: env.sessions,
    results: env.results,
    credentials: () => Effect.succeed({ remote: "https://artifacts.invalid/demo.git", token: "read-token" }),
    sandbox: sandboxes.factory,
    predicate: { command: "npm test", timeoutSec: 60, noInstall: true },
    freshId: () => String(++n),
    infraBackoff: Duration.millis(1)
  }
}

const params: BisectDriverParams = { sessionId: ID, instanceId: "wf-1" }

const storedSession = (bucket: ConditionalBucket): BisectSession => parseSession(JSON.parse(bucket.objects.get(sessionKey(SCOPE, ID))!.body))

/** Step keys of the stored session's events, in order. */
const keys = (s: BisectSession) => s.events.map((e) => e.step)

const checkFinal = (bucket: ConditionalBucket, journal: StepJournal) => {
  const s = storedSession(bucket)
  const records = journal.names().filter((n) => n.startsWith("record-"))
  // No lost observation, none recorded twice: exactly one event per completed record step, keyed 0..m-1.
  expect(keys(s)).toEqual(records.map((_, k) => stepKey(params.instanceId, k)))
  // Every recorded outcome is the one its test step observed.
  s.events.forEach((e, k) => {
    const t = journal.get(`test-${k}`)!.value as { commit: string; outcome: string }
    expect(e.oid).toBe(t.commit)
    expect(e.kind === "skip" ? "skip" : e.kind === "observe" && e.failed ? "fail" : "pass").toBe(t.outcome)
  })
  const st = sessionStatus(s)
  expect(st.culprit.oid).toBe(oid(CULPRIT))
  expect(st.confidence).toBeGreaterThanOrEqual(0.95)
  const result = JSON.parse(bucket.objects.get(resultKey(ID))!.body)
  expect(result.culprit.oid).toBe(oid(CULPRIT))
  expect(result.review).toBeNull()
  expect(bucket.unconditional).toEqual([])
  return s
}

describe("bisect driver", () => {
  it("runs to a confident culprit, records the hang as a skip, writes only conditionally", async () => {
    const env = await setup()
    const sb = makeScriptedSandboxes(script)
    const journal = memoryJournal()
    const steps = makeLocalSteps({ journal })
    const out = await runBisectDriver(params, steps, depsFor(env, sb))
    const s = checkFinal(env.bucket, journal)
    expect(out.result.culprit.oid).toBe(oid(CULPRIT))
    expect(sb.created()).toBe(sb.destroyed())
    expect(sb.predicateRuns.length).toBe(out.tests.length)
    // Each step ran in its own sandbox.
    expect(sb.created()).toBe(out.tests.length)
    const hang = s.events.find((e) => e.oid === oid(HANG))
    if (hang !== undefined) expect(hang.kind).toBe("skip")
  })

  it("resumes after a crash at any step with no lost observations and no replayed steps", async () => {
    // Uninterrupted run: how many new steps there are.
    const base = await setup()
    const baseJournal = memoryJournal()
    await runBisectDriver(params, makeLocalSteps({ journal: baseJournal }), depsFor(base, makeScriptedSandboxes(script)))
    const total = baseJournal.names().length
    expect(total).toBeGreaterThan(3)

    for (const mode of ["crashBefore", "crashAfterBody"] as const) {
      for (let n = 1; n <= total; n++) {
        const env = await setup()
        const sb = makeScriptedSandboxes(script)
        const journal = memoryJournal()
        const first = makeLocalSteps({ journal, [mode]: n })
        await expect(runBisectDriver(params, first, depsFor(env, sb))).rejects.toBeInstanceOf(SimulatedCrash)
        const second = makeLocalSteps({ journal })
        await runBisectDriver(params, second, depsFor(env, sb))
        checkFinal(env.bucket, journal)
        // Completed steps are replayed from their outputs, never run again.
        const checkpointedBeforeCrash = first.ran.filter((name) => second.replayed.includes(name))
        expect(second.ran.filter((name) => checkpointedBeforeCrash.includes(name))).toEqual([])
        // The predicate ran once per test step, plus once more only if the crash hit a test step's body.
        const crashed = first.ran.at(-1)!
        const observedAt = (name: string) => name.startsWith("test-") && (journal.get(name)!.value as { done: boolean }).done === false
        const extra = mode === "crashAfterBody" && observedAt(crashed) ? 1 : 0
        const testSteps = journal.names().filter(observedAt).length
        expect(sb.predicateRuns.length).toBe(testSteps + extra)
      }
    }
  })

  it("re-running a whole instance after it finished changes nothing", async () => {
    const env = await setup()
    const journal = memoryJournal()
    const sb = makeScriptedSandboxes(script)
    await runBisectDriver(params, makeLocalSteps({ journal }), depsFor(env, sb))
    const before = env.bucket.objects.get(sessionKey(SCOPE, ID))!.etag
    const runs = sb.predicateRuns.length
    const again = makeLocalSteps({ journal })
    await runBisectDriver(params, again, depsFor(env, sb))
    expect(again.ran).toEqual([])
    expect(env.bucket.objects.get(sessionKey(SCOPE, ID))!.etag).toBe(before)
    expect(sb.predicateRuns.length).toBe(runs)
  })

  it("a fresh journal over a session that already holds its observations re-runs no predicate", async () => {
    // The step outputs are gone (a new instance with the same id) but R2 has the observations.
    const env = await setup()
    const sb = makeScriptedSandboxes(script)
    await runBisectDriver(params, makeLocalSteps({ journal: memoryJournal() }), depsFor(env, sb))
    const runs = sb.predicateRuns.length
    await runBisectDriver(params, makeLocalSteps({ journal: memoryJournal() }), depsFor(env, sb))
    expect(sb.predicateRuns.length).toBe(runs)
  })

  it("repairs R2 from the returned session when R2 lost a completed write", async () => {
    const env = await setup()
    const sb = makeScriptedSandboxes(script)
    const journal = memoryJournal()
    let writes = 0
    // Lose the 3rd session write (record-2): R2 says "stored" but keeps the old object.
    env.bucket.loseNextWrite = (key) => key === sessionKey(SCOPE, ID) && ++writes === 3
    await runBisectDriver(params, makeLocalSteps({ journal }), depsFor(env, sb))
    checkFinal(env.bucket, journal)
  })

  it("falls back to a branch fetch when fetch by commit is refused", async () => {
    const env = await setup()
    const sb = makeScriptedSandboxes(script, { fetchByShaFails: true })
    const journal = memoryJournal()
    await runBisectDriver(params, makeLocalSteps({ journal }), depsFor(env, sb))
    checkFinal(env.bucket, journal)
  })
})
