/**
 * Laws of the cooperative-build job runner (`src/demo/runner.ts`), with
 * several jobs sharing one in-memory R2 (lock store with R2's 1 write/key/s
 * limit) and one blob store, on random dependency graphs. Time is Effect's
 * `TestClock`, advanced in 100 ms steps until every job has finished.
 *
 * Oracles are computed from the generated plan alone (dependency closure of
 * failing operations, the set of operations whose inputs changed), never
 * from the runner's own bookkeeping.
 */
import { Clock, Duration, Effect, Exit, Fiber, Option } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import { createHash } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, lawAsync, mutantKilledAsync } from "../harness.js"
import { makeMemoryBlobStore, type MemoryBlobStore } from "../../src/cache/blobStore.js"
import { formatDigest } from "../../src/cache/digest.js"
import {
  type DemoOperation,
  InvalidPlan,
  type JobConfig,
  type JobSummary,
  operationDigests,
  type RunnerConfig,
  type RunnerEvent,
  runJobs
} from "../../src/demo/runner.js"
import { makeCobuildLock, makeMemoryStore, type MemoryStore } from "../../src/index.js"
import { CacheKey, JobId } from "../../src/ids.js"

announce("test/demo/runner.test.ts")

const KEY_ENV = { flushSalt: "test", toolchain: "lean4.28" }
const STEP_MS = 1000
/** Simulated-time budget per run; a run that needs more is reported as a hang. */
const MAX_SIM_MS = 15 * 60_000

interface World {
  readonly lockStore: MemoryStore
  readonly blobStore: MemoryBlobStore
}

const newWorld = (): World => ({ lockStore: makeMemoryStore(1000), blobStore: makeMemoryBlobStore() })

const config = (w: World, ops: ReadonlyArray<DemoOperation>, events: Array<RunnerEvent>, context = "ctx-1"): RunnerConfig => ({
  ops,
  lockStore: w.lockStore,
  blobStore: w.blobStore,
  cobuild: { scope: "trusted", context },
  keyEnv: KEY_ENV,
  pollInterval: Duration.seconds(2),
  onEvent: (e) => events.push(e)
})

/** Run `jobs` to completion under the TestClock. `before` runs first at time `startAt`. */
const simulate = (
  cfg: RunnerConfig,
  jobs: ReadonlyArray<JobConfig>,
  before: Effect.Effect<void> = Effect.void,
  impl: typeof runJobs = runJobs,
  stepMs: number = STEP_MS
): Promise<{ summaries: ReadonlyArray<JobSummary>; endedAt: number }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* before
      const fiber = yield* Effect.forkChild(impl(cfg, jobs))
      for (let t = 0; t <= MAX_SIM_MS; t += stepMs) {
        const polled = yield* Effect.sync(() => Option.fromUndefinedOr(fiber.pollUnsafe()))
        if (Option.isSome(polled)) {
          if (Exit.isFailure(polled.value)) return yield* Effect.die(new Error(`runner failed: ${String(polled.value.cause)}`))
          const endedAt = yield* Clock.currentTimeMillis
          return { summaries: polled.value.value, endedAt }
        }
        yield* TestClock.adjust(stepMs)
      }
      yield* Fiber.interrupt(fiber)
      return yield* Effect.die(new Error(`runner did not finish within ${MAX_SIM_MS} ms of simulated time`))
    }).pipe(Effect.provide(TestClock.layer()))
  )

/** Random acyclic plan: operation i may depend only on operations < i. */
const arbPlan = (maxOps: number, failRate: number) =>
  fc.integer({ min: 1, max: maxOps }).chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.record({
          deps: fc.subarray(Array.from({ length: i }, (_, j) => `op${j}`)),
          buildMs: fc.integer({ min: 200, max: 25_000 }),
          fails: failRate > 0 ? fc.double({ min: 0, max: 1, noNaN: true }).map((x) => x < failRate) : fc.constant(false)
        })
      )
    ).map((specs) => specs.map((s, i): DemoOperation => ({ name: `op${i}`, deps: s.deps, buildMs: s.buildMs, inputs: `src of op${i}`, fails: s.fails })))
  )

const arbJobs = (ops: ReadonlyArray<DemoOperation>) =>
  fc.integer({ min: 1, max: 3 }).chain((k) =>
    fc.tuple(
      ...Array.from({ length: k }, () => fc.shuffledSubarray(ops.map((o) => o.name), { minLength: ops.length, maxLength: ops.length }))
    ).map((orders) => orders.map((order, i): JobConfig => ({ jobId: JobId(["primary", "extra1", "extra2"][i]!), order })))
  )

const of = <K extends RunnerEvent["kind"]>(events: ReadonlyArray<RunnerEvent>, kind: K) =>
  events.filter((e): e is Extract<RunnerEvent, { kind: K }> => e.kind === kind)

/** Operations that fail or depend (transitively) on one that fails. */
const doomed = (ops: ReadonlyArray<DemoOperation>): Set<string> => {
  const out = new Set<string>()
  for (const op of ops) if (op.fails === true || op.deps.some((d) => out.has(d))) out.add(op.name)
  return out
}

describe("cobuild runner", () => {
  it("every job ends with every operation; each is built exactly once, after its dependencies", async () => {
    await lawAsync(
      "no duplicate builds + dependency order + completeness",
      arbPlan(6, 0).chain((ops) => arbJobs(ops).map((jobs) => ({ ops, jobs }))),
      async ({ ops, jobs }) => {
        const events: Array<RunnerEvent> = []
        const w = newWorld()
        const { summaries } = await simulate(config(w, ops, events), jobs)
        for (const s of summaries) {
          for (const op of ops) expect(["built", "restored"]).toContain(s.outcomes.get(op.name))
        }
        const built = of(events, "built")
        expect(built.map((e) => e.op).sort()).toEqual(ops.map((o) => o.name).sort())
        expect(of(events, "restored").length).toBe(ops.length * (jobs.length - 1))
        const builtAt = new Map(built.map((e) => [e.op, e.at]))
        for (const start of of(events, "build-start")) {
          for (const d of ops.find((o) => o.name === start.op)!.deps) expect(builtAt.get(d)!).toBeLessThanOrEqual(start.at)
        }
        // Lock keys are the content digests of the operations.
        const digests = operationDigests(ops, KEY_ENV)
        for (const start of of(events, "build-start")) expect(start.lockKey).toBe(formatDigest(digests.get(start.op)!))
        const contended = of(events, "pending").length > 0
        return { valid: jobs.length > 1, boundary: !contended || ops.length === 1 }
      },
      25,
      { domain: "1–6 operations, random DAG, builds 0.2–25 s, 1–3 jobs with random orders", minValidFraction: 0.5, minBoundary: 3 }
    )
  })

  it("a failing operation is built once; jobs that see its marker do not rebuild it; its dependents are skipped everywhere", async () => {
    await lawAsync(
      "failure propagation",
      arbPlan(6, 0.3).chain((ops) => arbJobs(ops).map((jobs) => ({ ops, jobs }))),
      async ({ ops, jobs }) => {
        const events: Array<RunnerEvent> = []
        const { summaries } = await simulate(config(newWorld(), ops, events), jobs)
        const bad = doomed(ops)
        const firstFailures = ops.filter((o) => o.fails === true && !o.deps.some((d) => bad.has(d))).map((o) => o.name)
        expect(of(events, "build-failed").map((e) => e.op).sort()).toEqual([...firstFailures].sort())
        expect(of(events, "built").map((e) => e.op).sort()).toEqual(ops.filter((o) => !bad.has(o.name)).map((o) => o.name).sort())
        for (const s of summaries) {
          for (const op of ops) {
            const o = s.outcomes.get(op.name)
            if (!bad.has(op.name)) expect(["built", "restored"]).toContain(o)
            else if (firstFailures.includes(op.name)) expect(["build-failed", "failed-elsewhere"]).toContain(o)
            else expect(o).toBe("skipped")
          }
        }
        return { valid: firstFailures.length > 0, boundary: bad.size === ops.length || bad.size === 0 }
      },
      25,
      { domain: "1–6 operations, each failing with probability 0.3, 1–3 jobs", minValidFraction: 0.4, minBoundary: 3 }
    )
  })

  it("an operation whose lock is held by a crashed job (no heartbeat) is taken over after the lease and built once", async () => {
    await lawAsync(
      "crash takeover",
      arbPlan(5, 0).chain((ops) =>
        fc.record({ jobs: arbJobs(ops), victim: fc.constantFrom(...ops.filter((o) => o.deps.length === 0).map((o) => o.name)) }).map((r) => ({ ops, ...r }))
      ),
      async ({ ops, jobs, victim }) => {
        const events: Array<RunnerEvent> = []
        const w = newWorld()
        const lookup = formatDigest(operationDigests(ops, KEY_ENV).get(victim)!)
        // The crashed job: acquires the lock at t = 0, then never renews (kill -9).
        const crashed = Effect.gen(function* () {
          const zombie = makeCobuildLock(w.lockStore, { scope: "trusted", context: "ctx-1", jobId: JobId("crashed") })
          const s = yield* zombie.acquire(CacheKey(lookup))
          if (s.state !== "obtained") return yield* Effect.die(new Error("zombie did not obtain the lock"))
        }).pipe(Effect.orDie)
        await simulate(config(w, ops, events), jobs, crashed)
        const starts = of(events, "build-start").filter((e) => e.op === victim)
        expect(starts.length).toBe(1)
        // Lease = 30 s from t = 0; takeover needs expiresAt < now.
        expect(starts[0]!.at).toBeGreaterThan(30_000)
        expect(of(events, "built").map((e) => e.op).sort()).toEqual(ops.map((o) => o.name).sort())
        return { valid: true, boundary: jobs.length === 1 }
      },
      25,
      { domain: "1–5 operations, one root operation locked by a crashed job at t=0, 1–3 jobs", minValidFraction: 1, minBoundary: 1 }
    )
  })

  it("a second run in the same context rebuilds exactly the operations whose inputs (or dependencies' inputs) changed", async () => {
    await lawAsync(
      "content-addressed lock keys",
      arbPlan(6, 0).chain((ops) =>
        fc.record({ jobs: arbJobs(ops), changed: fc.constantFrom(...ops.map((o) => o.name)) }).map((r) => ({ ops, ...r }))
      ),
      async ({ ops, jobs, changed }) => {
        const w = newWorld()
        await simulate(config(w, ops, []), jobs)
        const ops2 = ops.map((o) => (o.name === changed ? { ...o, inputs: `${o.inputs} (edited)` } : o))
        const affected = new Set<string>()
        for (const o of ops2) if (o.name === changed || o.deps.some((d) => affected.has(d))) affected.add(o.name)
        const events: Array<RunnerEvent> = []
        const { summaries } = await simulate(config(w, ops2, events), jobs)
        expect(of(events, "built").map((e) => e.op).sort()).toEqual([...affected].sort())
        for (const s of summaries) {
          for (const o of ops2) if (!affected.has(o.name)) expect(s.outcomes.get(o.name)).toBe("restored")
        }
        return { valid: affected.size < ops.length, boundary: affected.size === 1 || affected.size === ops.length }
      },
      30,
      { domain: "1–6 operations, one operation's inputs edited between two runs in one context", minValidFraction: 0.3, minBoundary: 3 }
    )
  })

  it("regression: the proposal's six-operation graph with three jobs (recorded)", async () => {
    const ops: ReadonlyArray<DemoOperation> = [
      { name: "mathlib-import", deps: [], buildMs: 18_000, inputs: "a" },
      { name: "build-core", deps: ["mathlib-import"], buildMs: 4_500, inputs: "b" },
      { name: "build-ui", deps: ["mathlib-import"], buildMs: 3_000, inputs: "c" },
      { name: "axiom-audit", deps: ["build-core"], buildMs: 13_700, inputs: "d" },
      { name: "test-suite", deps: ["build-core", "build-ui"], buildMs: 12_000, inputs: "e" },
      { name: "lint-lean", deps: ["mathlib-import"], buildMs: 2_000, inputs: "f" }
    ]
    const names = ops.map((o) => o.name)
    const jobs: Array<JobConfig> = [
      { jobId: JobId("primary"), order: names },
      { jobId: JobId("extra1"), order: [...names].reverse() },
      { jobId: JobId("extra2"), order: ["lint-lean", "test-suite", "build-ui", "mathlib-import", "axiom-audit", "build-core"] }
    ]
    const events: Array<RunnerEvent> = []
    const { endedAt } = await simulate(config(newWorld(), ops, events), jobs)
    expect(of(events, "built").map((e) => [e.job, e.op, e.at])).toEqual([
      ["primary", "mathlib-import", 18000],
      ["extra1", "lint-lean", 22000],
      ["primary", "build-core", 22500],
      ["extra2", "build-ui", 23000],
      ["extra1", "test-suite", 36000],
      ["primary", "axiom-audit", 36200]
    ])
    // Serial build time is 53.2 s. The last build ends at 36.2 s; the other jobs
    // restore it on their next poll (every 2 s), observed at 1 s granularity.
    expect(endedAt).toBe(39000)
  })

  it("regression (recorded): a 60 s build with a 2 s poll — the waiter writes at most twice", async () => {
    const w = newWorld()
    const ops: Array<DemoOperation> = [{ name: "long", deps: [], buildMs: 60_000, inputs: "x" }]
    const events: Array<RunnerEvent> = []
    await simulate(config(w, ops, events), [
      { jobId: JobId("holder"), order: ["long"] },
      { jobId: JobId("waiter"), order: ["long"] }
    ])
    expect(of(events, "built").map((e) => e.job)).toEqual(["holder"])
    expect(of(events, "restored").map((e) => e.job)).toEqual(["waiter"])
    // 60 s of waiting at a 2 s poll would be ~30 create attempts with `acquire`;
    // with `inspect` the waiter writes at most twice (first attempt, final attempt),
    // plus at most ⌈1000 / 2000⌉ = 1 attempt answered 429 because it falls in the
    // store's one-write-per-second window after the holder's completion write
    // (the polling rule below). Holder's acquire + 2 + 1 = 4.
    expect(w.lockStore.calls.putIfNoneMatch).toBeLessThanOrEqual(4)
    expect(w.lockStore.calls.get).toBeGreaterThanOrEqual(25)
  })

  /*
   * Polling as a rule (replaces one 60 s / 2 s run with fixed thresholds):
   * while another job holds a live lease, a waiting job checks it with reads,
   * once per `pollMs`: for any build time B and poll interval P, the number
   * of create-only write attempts is bounded independently of B (holder's
   * acquire and completion marker, the waiter's first and final attempt, plus
   * at most ⌈1000/P⌉ attempts answered 429 because they fall inside the
   * store's one-write-per-second window after the holder's last write), and the number of reads lies within [⌊B/P⌋, ⌈B/P⌉ + 12] — one read
   * per poll while the lease is live, plus a constant for the start and the
   * hand-over. It scales with B/P, not with any fixed threshold.
   */
    // Poll intervals are whole multiples of the simulation step (100 ms) so the
  // simulated clock never quantizes a poll; that is a property of the harness,
  // not of the rule under test.
  const POLL_STEP_MS = 100
  const withEnds = (min: number, max: number) => fc.oneof({ weight: 1, arbitrary: fc.constantFrom(min, max) }, { weight: 3, arbitrary: fc.integer({ min, max }) })
  const pollCase = fc.record({ buildMs: withEnds(5_000, 120_000), pollMs: withEnds(5, 80).map((k) => k * POLL_STEP_MS) })
  const pollingFollowsRule = async (impl: typeof runJobs, c: { buildMs: number; pollMs: number }): Promise<boolean> => {
    const w = newWorld()
    const events: Array<RunnerEvent> = []
    const ops: Array<DemoOperation> = [{ name: "long", deps: [], buildMs: c.buildMs, inputs: "x" }]
    await simulate({ ...config(w, ops, events), pollInterval: Duration.millis(c.pollMs) }, [{ jobId: JobId("holder"), order: ["long"] }, { jobId: JobId("waiter"), order: ["long"] }], Effect.void, impl, POLL_STEP_MS)
    const built = of(events, "built").map((e) => e.job)
    const restored = of(events, "restored").map((e) => e.job)
    const reads = w.lockStore.calls.get
    const ratio = c.buildMs / c.pollMs
    lastPollObservation = { built, restored, writes: w.lockStore.calls.putIfNoneMatch, reads, ratio }
    return JSON.stringify(built) === '["holder"]' && JSON.stringify(restored) === '["waiter"]' && w.lockStore.calls.putIfNoneMatch <= 4 + Math.ceil(1000 / c.pollMs) && reads >= Math.floor(ratio) && reads <= Math.ceil(ratio) + 12
  }
  let lastPollObservation: unknown = null
  /** Load a planted source mutant of the runner (a patched copy next to the original, removed afterwards). */
  const loadRunnerMutant = async (from: string, to: string): Promise<typeof runJobs> => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../../src/demo/runner.ts")
    const code = readFileSync(src, "utf8")
    if (!code.includes(from)) throw new Error(`mutation anchor not found: ${from}`)
    const patched = code.replace(from, to)
    // One file name per distinct patched source, so the module cache never hands back another mutant.
    const file = join(dirname(src), `runner.mutant-${process.pid}-${createHash("sha256").update(patched).digest("hex").slice(0, 12)}.ts`)
    writeFileSync(file, patched)
    try {
      return ((await import(pathToFileURL(file).href)) as { runJobs: typeof runJobs }).runJobs
    } finally {
      rmSync(file, { force: true })
    }
  }
  /** Mutant 1: no read before retrying — the waiter re-attempts the create-only write on every poll. */
  const writesEveryPoll = () => loadRunnerMutant("if (pending.has(name)) {", "if (false && pending.has(name)) {")
  /** Mutant 2: the poll interval hard-coded to the value of the old example (2 s) instead of `pollInterval`. */
  const hardCodedPoll = () => loadRunnerMutant("yield* Effect.sleep(cfg.pollInterval)", "yield* Effect.sleep(Duration.seconds(2))")

  it("law: the waiter reads once per poll interval and writes O(1) times, for any build time and poll interval", async () => {
    await lawAsync(
      "polling by reads",
      pollCase,
      async (c) => {
        const ok = await pollingFollowsRule(runJobs, c)
        expect(ok, JSON.stringify({ c, observed: lastPollObservation })).toBe(true)
        return { valid: c.buildMs > 3 * c.pollMs, boundary: c.pollMs === 500 || c.pollMs === 8_000 || c.buildMs === 5_000 || c.buildMs === 120_000 }
      },
      15,
      // P(valid) = 0.85 under pollCase, so needing 6 of 15 fails by chance with probability 8e-6
      // (0.6 needed 9 of 15: 0.35%). The assertion above runs on every case either way.
      { domain: "one operation, holder + waiter, build 5–120 s, poll 0.5–8 s", minValidFraction: 0.4, minBoundary: 1 }
    )
    // About 60 s alone; the whole suite runs files in parallel and slows it about threefold.
  }, 300_000)

  it("counterexample 1 (mutant: write on every poll): 60 s build, 2 s poll", async () => {
    const c = { buildMs: 60_000, pollMs: 2_000 }
    expect(await pollingFollowsRule(runJobs, c)).toBe(true)
    expect(await pollingFollowsRule(await writesEveryPoll(), c)).toBe(false)
  }, 60_000)

  it("counterexample 2 (mutant: poll interval hard-coded to 2 s): 60 s build, 500 ms poll — the old example's values pass, these do not", async () => {
    const mutant = await hardCodedPoll()
    expect(await pollingFollowsRule(runJobs, { buildMs: 60_000, pollMs: 500 })).toBe(true)
    expect(await pollingFollowsRule(mutant, { buildMs: 60_000, pollMs: 500 })).toBe(false)
    // On the old test's own input the hard-coded mutant is indistinguishable:
    expect(await pollingFollowsRule(mutant, { buildMs: 60_000, pollMs: 2_000 })).toBe(true)
  }, 60_000)

  it("negation 1: the law is refuted for the write-every-poll mutant", async () => {
    const m = await writesEveryPoll()
    expect(await mutantKilledAsync(pollCase, (c) => pollingFollowsRule(m, c), 10)).toBe(true)
  }, 120_000)

  it("negation 2: the law is refuted for the hard-coded-poll mutant", async () => {
    const m = await hardCodedPoll()
    expect(await mutantKilledAsync(pollCase, (c) => pollingFollowsRule(m, c), 10)).toBe(true)
  }, 120_000)

  it("cacheFirst: a new context with unchanged inputs restores from the cache without taking any lock", async () => {
    const w = newWorld()
    const ops: Array<DemoOperation> = [
      { name: "a", deps: [], buildMs: 5_000, inputs: "a" },
      { name: "b", deps: ["a"], buildMs: 5_000, inputs: "b" }
    ]
    await simulate(config(w, ops, []), [{ jobId: JobId("run1"), order: ["a", "b"] }])
    const writesBefore = w.lockStore.calls.putIfNoneMatch + w.lockStore.calls.putIfMatch
    const events: Array<RunnerEvent> = []
    await simulate({ ...config(w, ops, events, "ctx-2"), cacheFirst: true }, [{ jobId: JobId("run2"), order: ["a", "b"] }])
    expect(of(events, "cache-hit").map((e) => e.op)).toEqual(["a", "b"])
    expect(of(events, "built")).toEqual([])
    expect(w.lockStore.calls.putIfNoneMatch + w.lockStore.calls.putIfMatch).toBe(writesBefore)
  })

  it("rejects invalid plans", async () => {
    const w = newWorld()
    const ok: DemoOperation = { name: "a", deps: [], buildMs: 1, inputs: "" }
    expect(() => operationDigests([ok, ok], KEY_ENV)).toThrow(InvalidPlan)
    expect(() => operationDigests([{ ...ok, deps: ["missing"] }], KEY_ENV)).toThrow(InvalidPlan)
    expect(() => operationDigests([{ ...ok, deps: ["b"] }, { ...ok, name: "b", deps: ["a"] }], KEY_ENV)).toThrow(InvalidPlan)
    await expect(simulate(config(w, [ok], []), [{ jobId: JobId("j"), order: [] }])).rejects.toThrow()
  })
})
