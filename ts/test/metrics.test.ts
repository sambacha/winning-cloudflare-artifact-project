/**
 * Cobuild metrics (`src/metrics.ts`): instrumentation never changes results,
 * and every metric moves by exactly the number of events it counts.
 *
 * The metric registry is process-wide, so every check compares two
 * snapshots taken around the code under test.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { runCobuild } from "../src/cobuild.js"
import { Duration, Effect, Fiber, Result } from "../src/fx/index.js"
import { TestClock } from "../src/fx/testing.js"
import { makeCobuildLock } from "../src/lock.js"
import { makeMemoryStore } from "../src/memoryStore.js"
import { type MetricsSnapshot, snapshotMetrics, withStoreMetrics } from "../src/metrics.js"
import type { ObjectStore } from "../src/store.js"
import { announce, params } from "./harness.js"
import { CacheKey, JobId } from "../src/ids.js"

announce("test/metrics.test.ts")

const runTest = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

/** `after - before` for every key of a frequency. */
const delta = (after: Readonly<Record<string, number>>, before: Readonly<Record<string, number>>) =>
  Object.fromEntries(
    Object.keys(after)
      .map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)] as const)
      .filter(([, n]) => n !== 0)
  )

type Op = { readonly op: "create" | "cas" | "get"; readonly key: "a" | "b"; readonly stale: boolean }

const opArb: fc.Arbitrary<Op> = fc.record({
  op: fc.constantFrom("create" as const, "cas" as const, "get" as const),
  key: fc.constantFrom("a" as const, "b" as const),
  stale: fc.boolean()
})

const apply = (s: ObjectStore, etags: Map<string, string>, o: Op) =>
  o.op === "create"
    ? s.putIfNoneMatch(o.key, "body")
    : o.op === "cas"
      ? s.putIfMatch(o.key, o.stale ? '"stale"' : (etags.get(o.key) ?? '"none"'), "body2")
      : Effect.map(s.get(o.key), () => "read")

describe("withStoreMetrics", () => {
  it("law: results are unchanged, and cobuild_store_requests moves by one per request, labelled <operation>:<outcome>", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 15 }), async (ops) => {
        // rate limit 0: every outcome is decided by the conditions alone.
        const plain = makeMemoryStore(0)
        const inner = makeMemoryStore(0)
        const wrapped = withStoreMetrics(inner)
        const before: MetricsSnapshot = await Effect.runPromise(snapshotMetrics)
        const results = async (s: ObjectStore, peek: typeof plain.peek) => {
          const out: Array<Result.Result<unknown, string>> = []
          for (const o of ops) {
            const etags = new Map<string, string>()
            const cur = peek(o.key)
            if (cur !== undefined) etags.set(o.key, cur.etag)
            const r = await Effect.runPromise(Effect.result(apply(s, etags, o)))
            out.push(Result.mapError(r, (e) => e._tag))
          }
          return out
        }
        const expected = await results(plain, plain.peek)
        const actual = await results(wrapped, inner.peek)
        expect(actual).toEqual(expected)
        const after = await Effect.runPromise(snapshotMetrics)
        const want: Record<string, number> = {}
        ops.forEach((o, i) => {
          const name = o.op === "create" ? "putIfNoneMatch" : o.op === "cas" ? "putIfMatch" : "get"
          const r = expected[i]!
          const label = `${name}:${r._tag === "Success" ? "ok" : r.failure}`
          want[label] = (want[label] ?? 0) + 1
        })
        expect(delta(after.storeRequests, before.storeRequests)).toEqual(want)
        expect(after.storeRequestDurationMs.count - before.storeRequestDurationMs.count).toBe(ops.length)
      }),
      params(60)
    )
  })
})

describe("lock and runCobuild metrics", () => {
  it("law: building for k·R + R/2 ms records k renewals, one acquisition `obtained`, one `Built` and one build duration", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 2, max: 9 }), async (k, rSeconds) => {
        const renew = rSeconds * 1_000
        const D = k * renew + renew / 2
        const before = await Effect.runPromise(snapshotMetrics)
        const result = await runTest(
          Effect.gen(function* () {
            const lock = makeCobuildLock(makeMemoryStore(), {
              scope: "trusted",
              context: "metrics",
              jobId: JobId("A"),
              lease: Duration.millis(renew * 3),
              renewInterval: Duration.millis(renew),
              maxLatency: Duration.millis(0),
              maxSkew: Duration.millis(0)
            })
            const fiber = yield* Effect.forkChild(
              runCobuild(lock, {
                cacheKey: CacheKey(`p-${k}-${rSeconds}`),
                build: Effect.as(Effect.sleep(D), "out"),
                upload: () => Effect.succeed("tarball")
              })
            )
            yield* TestClock.adjust(D + 2_000)
            return yield* Fiber.join(fiber)
          })
        )
        expect(result._tag).toBe("Built")
        const after = await Effect.runPromise(snapshotMetrics)
        expect(after.lockRenewals - before.lockRenewals).toBe(k)
        expect(after.lockLost - before.lockLost).toBe(0)
        expect(delta(after.lockAcquireOutcomes, before.lockAcquireOutcomes)).toEqual({ obtained: 1 })
        expect(delta(after.operationOutcomes, before.operationOutcomes)).toEqual({ Built: 1 })
        expect(after.buildDurationMs.count - before.buildDurationMs.count).toBe(1)
        expect(after.buildDurationMs.sum - before.buildDurationMs.sum).toBeGreaterThanOrEqual(D)
      }),
      params(25)
    )
  })

  it("a second job sees `pending` while the first holds the lease, and both outcomes are counted", async () => {
    const before = await Effect.runPromise(snapshotMetrics)
    const store = makeMemoryStore()
    const cfg = { scope: "trusted", context: "metrics-pending", maxLatency: Duration.millis(0), maxSkew: Duration.millis(0) } as const
    const r = await runTest(
      Effect.gen(function* () {
        const a = makeCobuildLock(store, { ...cfg, jobId: JobId("A") })
        const b = makeCobuildLock(store, { ...cfg, jobId: JobId("B") })
        const first = yield* a.acquire(CacheKey("x"))
        const second = yield* b.acquire(CacheKey("x"))
        return [first.state, second.state]
      })
    )
    expect(r).toEqual(["obtained", "pending"])
    const after = await Effect.runPromise(snapshotMetrics)
    expect(delta(after.lockAcquireOutcomes, before.lockAcquireOutcomes)).toEqual({ obtained: 1, pending: 1 })
  })

  it("the snapshot is plain JSON (what --metrics-json writes)", async () => {
    const s = await Effect.runPromise(snapshotMetrics)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(s.storeRequestDurationMs.buckets.at(-1)?.[0]).toBe("Infinity")
  })
})
