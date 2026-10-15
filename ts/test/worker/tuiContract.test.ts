/**
 * Contract between the Worker (`src/worker/handler.ts`) and the dashboard's
 * live mode (`tui/src/live.ts`): every response the Worker produces from
 * lock objects written by the real lock code is accepted by the dashboard's
 * validator, and the rows it draws show the same holders, states and keys.
 * (The dashboard cannot import this package, so this check lives here.)
 */
import { Effect, Redacted } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, lawAsync } from "../harness.js"
import { makeCobuildLock, makeMemoryStore } from "../../src/index.js"
import { isWellFormed } from "../../src/cache/keyEncoding.js"
import { handle } from "../../src/worker/handler.js"
import { parseLiveLocks, toLiveRows } from "../../../tui/src/live.js"
import { makeFakeBucket } from "./fakeBucket.js"
import { CacheKey, JobId } from "../../src/ids.js"

announce("test/worker/tuiContract.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

describe("Worker → dashboard contract", () => {
  it("the dashboard accepts every Worker response and shows the stored holder, state and key", async () => {
    await lawAsync(
      "parseLiveLocks(handler response) succeeds and preserves the locks",
      fc.uniqueArray(
        fc.record({
          cacheKey: fc.string({ minLength: 1, maxLength: 12 }).filter(isWellFormed),
          owner: fc.constantFrom("primary", "extra1", "extra2"),
          action: fc.constantFrom("building", "succeeded", "failed", "abandoned")
        }),
        { maxLength: 8, selector: (o) => o.cacheKey }
      ),
      async (ops) => {
        const store = makeMemoryStore(0)
        await run(
          Effect.forEach(ops, (op) =>
            Effect.gen(function* () {
              const lock = makeCobuildLock(store, { scope: "trusted", context: "ctx", jobId: JobId(op.owner) })
              const s = yield* lock.acquire(CacheKey(op.cacheKey))
              if (s.state !== "obtained") return yield* Effect.die(new Error("not obtained"))
              if (op.action === "succeeded") yield* lock.markCompleted(s.lock, { status: "succeeded", buildCacheKey: "bk" })
              if (op.action === "failed") yield* lock.markCompleted(s.lock, { status: "failed", logKey: "log/1" })
              if (op.action === "abandoned") yield* lock.abandon(s.lock)
            })
          )
        )
        const req = new Request("https://w.example/api/locks?context=ctx", { headers: { authorization: "Bearer t" } })
        const res = await handle(req, makeFakeBucket({ locks: store }), { scope: "trusted", token: Redacted.make("t"), now: () => 10_000 })
        const live = parseLiveLocks(await res.json())
        const rows = toLiveRows(live, 10_000, 0)
        const byKey = new Map(rows.map((r) => [r.op, r]))
        expect(rows.length).toBe(ops.length)
        for (const op of ops) {
          const row = byKey.get(op.cacheKey)!
          expect(row.holder).toBe(op.owner)
          expect(row.state).toBe({ building: "BUILDING", abandoned: "BUILDING", succeeded: "SUCCEEDED", failed: "FAILED" }[op.action])
          expect(row.key).toBe(makeCobuildLock(store, { scope: "trusted", context: "ctx", jobId: JobId("x") }).objectKey(CacheKey(op.cacheKey)))
          // Lease from t = 0 is 30 s; polled at 10 s the countdown reads 20 s (abandoned: already expired).
          if (op.action === "building") expect(row.expiresAt).toBe(20)
          if (op.action === "abandoned") expect(row.expiresAt!).toBeLessThan(0)
        }
        return { valid: ops.length > 0, boundary: ops.length === 0 || ops.some((o) => o.action === "abandoned") }
      },
      60,
      { domain: "≤8 locks with arbitrary well-formed cache keys, all outcomes", minValidFraction: 0.8, minBoundary: 5 }
    )
  })
})
