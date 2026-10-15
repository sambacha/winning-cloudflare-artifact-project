/**
 * Laws of `withRequestTimeout` (`src/storeTimeout.ts`, audit item B-3).
 *
 * Requirement (from the lock's configuration predicate D-10): every store
 * request finishes, successfully or not, within `maxLatencyMs`; a request
 * that runs out of time is cancelled and reported as the *ambiguous* error
 * (`StoreFailure`), never as a definite answer (`PreconditionFailed`,
 * `RateLimited`), because R2 may have applied it.
 *
 * | Law | Oracle |
 * |---|---|
 * | T1 deadline | for delay d and limit t: d < t ⇒ the inner answer; d > t ⇒ `StoreFailure(RequestTimeout)` at exactly t |
 * | T2 cancellation | a timed-out request's `AbortSignal` is aborted (the HTTP request is cancelled) |
 * | T3 transparency | on random op sequences against a fast store, decorated and plain stores give identical answers and identical stored state |
 * | T4 lock reconciliation | a create/CAS that R2 applied but whose response arrives after the limit is still recognised by the lock as its own write |
 *
 * Mutants (H3): "no limit" (T1 refutes it), "timeout reported as
 * PreconditionFailed" (T4 refutes it).
 */
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Result } from "../src/fx/index.js"
import { TestClock } from "../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { makeCobuildLock, makeMemoryStore, type ObjectStore, PreconditionFailed, type StoreError, StoreFailure } from "../src/index.js"
import { isTimeoutFailure, RequestTimeout, withRequestTimeout, checkTimeout } from "../src/storeTimeout.js"
import { announce, lawAsync, mutantKilledAsync } from "./harness.js"
import { CacheKey, JobId } from "../src/ids.js"

announce("test/storeTimeout.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

/** `store` whose every call takes `delay(op)` ms of Effect time *before* reaching the store (a slow network on the way in). */
const slowIn = (store: ObjectStore, delay: () => number): ObjectStore => ({
  putIfNoneMatch: (k, b) => Effect.andThen(Effect.sleep(Duration.millis(delay())), store.putIfNoneMatch(k, b)),
  putIfMatch: (k, e, b) => Effect.andThen(Effect.sleep(Duration.millis(delay())), store.putIfMatch(k, e, b)),
  get: (k) => Effect.andThen(Effect.sleep(Duration.millis(delay())), store.get(k))
})

/** `store` whose *writes* are applied at once but whose responses arrive `delay` ms later (the response is lost in transit). */
const slowWriteResponses = (store: ObjectStore, delay: number): ObjectStore => ({
  putIfNoneMatch: (k, b) => Effect.tap(store.putIfNoneMatch(k, b), () => Effect.sleep(Duration.millis(delay))),
  putIfMatch: (k, e, b) => Effect.tap(store.putIfMatch(k, e, b), () => Effect.sleep(Duration.millis(delay))),
  get: store.get
})

/** Run `eff` forked, advance the test clock by `advanceMs`, and return its exit plus the clock reading when it finished. */
const runWithClock = <A, E>(eff: Effect.Effect<A, E>, advanceMs: number) =>
  Effect.gen(function* () {
    let finishedAt = -1
    const fiber = yield* Effect.forkChild(
      Effect.ensuring(
        eff,
        Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => void (finishedAt = t)))
      )
    )
    yield* TestClock.adjust(Duration.millis(advanceMs))
    const exit = yield* Fiber.await(fiber)
    return { exit, finishedAt }
  })

describe("withRequestTimeout", () => {
  it("rejects limits that are not positive whole milliseconds (unit)", () => {
    for (const bad of [Duration.zero, Duration.micros(1500n), Duration.infinity]) expect(() => checkTimeout(bad), Duration.format(bad)).toThrow(RangeError)
    expect(checkTimeout(Duration.millis(1))).toEqual(Duration.millis(1))
  })

  it("T1 law: d < t gives the inner answer at time d; d > t gives StoreFailure(RequestTimeout) at time t", async () => {
    await lawAsync(
      "deadline",
      fc.record({
        t: fc.integer({ min: 1, max: 5_000 }),
        d: fc.integer({ min: 0, max: 10_000 }),
        op: fc.constantFrom("putIfNoneMatch", "putIfMatch", "get") as fc.Arbitrary<"putIfNoneMatch" | "putIfMatch" | "get">
      }).filter((c) => c.d !== c.t),
      async ({ t, d, op }) => {
        const inner = makeMemoryStore(0)
        const seeded = await run(inner.putIfNoneMatch("k", "v0"))
        const store = withRequestTimeout(slowIn(inner, () => d), Duration.millis(t))
        const call: Effect.Effect<unknown, StoreError> =
          op === "putIfNoneMatch" ? store.putIfNoneMatch("k2", "v") : op === "putIfMatch" ? store.putIfMatch("k", seeded, "v1") : store.get("k")
        const { exit, finishedAt } = await run(runWithClock(call, Math.max(d, t) + 1))
        if (d < t) {
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(finishedAt).toBe(d)
          if (op === "get" && Exit.isSuccess(exit)) expect(Option.getOrThrow(exit.value as Option.Option<{ body: string }>).body).toBe("v0")
        } else {
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Option.getOrNull(Cause.findErrorOption(exit.cause))
            expect(isTimeoutFailure(err)).toBe(true)
            const cause = (err as StoreFailure).cause as RequestTimeout
            expect(cause.operation).toBe(op)
            expect(Duration.toMillis(cause.timeout)).toBe(t)
          }
          expect(finishedAt).toBe(t)
          // The interrupted request never reached the store: nothing was written.
          if (op === "putIfNoneMatch") expect(inner.peek("k2")).toBeUndefined()
          if (op === "putIfMatch") expect(inner.peek("k")!.body).toBe("v0")
        }
        return { valid: true, boundary: Math.abs(d - t) === 1 || d === 0 }
      },
      200,
      { domain: "limit 1–5000 ms, delay 0–10000 ms (d ≠ t), all three operations", minValidFraction: 1, minBoundary: 0 }
    )
  })

  it("T1 boundary (unit): d = t ± 1 on both sides of the limit", async () => {
    for (const [d, ok] of [[1999, true], [2001, false]] as const) {
      const store = withRequestTimeout(slowIn(makeMemoryStore(0), () => d), Duration.seconds(2))
      const { exit } = await run(runWithClock(store.get("k"), 3000))
      expect(Exit.isSuccess(exit)).toBe(ok)
    }
  })

  it("T1 negation: a decorator without a limit is refuted by the deadline law", async () => {
    const noLimit = (s: ObjectStore, _t: number): ObjectStore => s
    const killed = await mutantKilledAsync(
      fc.record({ t: fc.integer({ min: 1, max: 1000 }), d: fc.integer({ min: 1001, max: 3000 }) }),
      async ({ t, d }) => {
        const { exit, finishedAt } = await run(runWithClock(noLimit(slowIn(makeMemoryStore(0), () => d), t).get("k"), d + 1))
        return Exit.isFailure(exit) && finishedAt === t
      },
      20
    )
    expect(killed).toBe(true)
  })

  it("T2: a timed-out request's AbortSignal is aborted (the underlying HTTP request is cancelled)", async () => {
    await lawAsync(
      "cancellation",
      fc.integer({ min: 1, max: 500 }),
      async (t) => {
        let signal: AbortSignal | undefined
        const hanging: ObjectStore = {
          ...makeMemoryStore(0),
          get: (key) =>
            Effect.tryPromise({
              try: (s) => {
                signal = s
                return new Promise<never>(() => {})
              },
              catch: (cause) => new StoreFailure({ key, cause })
            })
        }
        const { exit } = await run(runWithClock(withRequestTimeout(hanging, Duration.millis(t)).get("k"), t))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(signal?.aborted).toBe(true)
        return { valid: true, boundary: t === 1 }
      },
      50,
      { domain: "limit 1–500 ms, request that never answers", minValidFraction: 1, minBoundary: 0 }
    )
  })

  it("T3 law: against a fast store the decorator changes no answer and no stored state", async () => {
    const opArb = fc.oneof(
      fc.record({ op: fc.constant("create" as const), key: fc.constantFrom("a", "b"), body: fc.string({ maxLength: 4 }) }),
      fc.record({ op: fc.constant("cas" as const), key: fc.constantFrom("a", "b"), body: fc.string({ maxLength: 4 }), stale: fc.boolean() }),
      fc.record({ op: fc.constant("get" as const), key: fc.constantFrom("a", "b") })
    )
    await lawAsync(
      "transparency",
      fc.record({ ops: fc.array(opArb, { minLength: 1, maxLength: 12 }), t: fc.integer({ min: 1, max: 10_000 }) }),
      async ({ ops, t }) => {
        const plain = makeMemoryStore(0)
        const inner = makeMemoryStore(0)
        const wrapped = withRequestTimeout(inner, Duration.millis(t))
        const answers = (s: ObjectStore, peek: typeof plain.peek) =>
          Effect.forEach(ops, (o) =>
            Effect.result<unknown, StoreError, never>(
              o.op === "create"
                ? s.putIfNoneMatch(o.key, o.body)
                : o.op === "cas"
                  ? s.putIfMatch(o.key, o.stale ? '"stale"' : (peek(o.key)?.etag ?? '"none"'), o.body)
                  : Effect.map(s.get(o.key), Option.map((x) => x.body))
            ).pipe(Effect.map((r) => Result.mapError(r, (e) => e._tag)))
          )
        const a = await run(answers(plain, plain.peek))
        const b = await run(answers(wrapped, inner.peek))
        expect(b).toEqual(a)
        expect(inner.keys().map((k) => inner.peek(k)!.body)).toEqual(plain.keys().map((k) => plain.peek(k)!.body))
        const failures = a.filter((r) => Result.isFailure(r)).length
        return { valid: true, boundary: failures > 0 && failures < a.length }
      },
      150,
      { domain: "1–12 random create/CAS/get on two keys, limit 1–10000 ms", minValidFraction: 1, minBoundary: 5 }
    )
  })

  it("T4 law: a write R2 applied but whose response came after the limit is adopted by the lock (acquire obtains, renew keeps the lock)", async () => {
    await lawAsync(
      "lock reconciliation after a late response",
      fc.record({ t: fc.integer({ min: 1, max: 2_000 }), late: fc.integer({ min: 1, max: 5_000 }) }),
      async ({ t, late }) => {
        const inner = makeMemoryStore(0)
        const store = withRequestTimeout(slowWriteResponses(inner, t + late), Duration.millis(t))
        const lock = makeCobuildLock(store, { scope: "trusted", context: "c", jobId: JobId("j"), maxLatency: Duration.millis(0), maxSkew: Duration.millis(0), rateLimit: Duration.millis(0) })
        const { exit } = await run(runWithClock(lock.acquire(CacheKey("op")), t + 1))
        expect(Exit.isSuccess(exit)).toBe(true)
        if (!Exit.isSuccess(exit)) return { valid: false, boundary: false }
        const st = exit.value
        expect(st.state).toBe("obtained")
        if (st.state !== "obtained") return { valid: false, boundary: false }
        // The ETag the lock holds is the one R2 actually stored, so later CAS writes succeed.
        expect(st.lock.etag).toBe(inner.peek(lock.objectKey(CacheKey("op")))!.etag)
        const renewed = await run(runWithClock(lock.renewOnce(st.lock), t + 1))
        expect(Exit.isSuccess(renewed.exit)).toBe(true)
        if (Exit.isSuccess(renewed.exit)) expect(renewed.exit.value.etag).toBe(inner.peek(lock.objectKey(CacheKey("op")))!.etag)
        return { valid: true, boundary: t === 1 }
      },
      60,
      { domain: "limit 1–2000 ms, response 1–5000 ms after the limit", minValidFraction: 1, minBoundary: 0 }
    )
  })

  /** Only CAS writes are slow on the way in (never reach R2 within the limit); reads and creates are fast. */
  const slowCasIn = (s: ObjectStore, d: number): ObjectStore => ({
    ...s,
    putIfMatch: (k, e, b) => Effect.andThen(Effect.sleep(Duration.millis(d)), s.putIfMatch(k, e, b))
  })

  /** A renewal attempt with time limit `t` whose request needs `d > t` ms to reach R2. */
  const renewTimedOut = (decorate: (s: ObjectStore, t: number) => ObjectStore, t: number, d: number) =>
    Effect.gen(function* () {
      const inner = makeMemoryStore(0)
      const lock = makeCobuildLock(decorate(slowCasIn(inner, d), t), {
        scope: "trusted", context: "c", jobId: JobId("j"), maxLatency: Duration.millis(0), maxSkew: Duration.millis(0), rateLimit: Duration.millis(0)
      })
      const st = yield* lock.acquire(CacheKey("op"))
      if (st.state !== "obtained") return yield* Effect.die("setup: expected to obtain a fresh lock")
      const { exit } = yield* runWithClock(Effect.result(lock.renewOnce(st.lock)), t + 1)
      return { exit, held: st.lock.etag, stored: inner.peek(lock.objectKey(CacheKey("op")))!.etag }
    })

  it("T5 law: a renewal that timed out before reaching R2 is retryable (StoreFailure), not LockLost, and the lock is still ours", async () => {
    await lawAsync(
      "unapplied renewal stays retryable",
      fc.record({ t: fc.integer({ min: 1, max: 2_000 }), extra: fc.integer({ min: 1, max: 5_000 }) }),
      async ({ t, extra }) => {
        const r = await run(renewTimedOut((store, limit) => withRequestTimeout(store, Duration.millis(limit)), t, t + extra))
        expect(Exit.isSuccess(r.exit)).toBe(true)
        if (!Exit.isSuccess(r.exit)) return { valid: false, boundary: false }
        const e = r.exit.value
        expect(Result.isFailure(e)).toBe(true)
        if (Result.isFailure(e)) {
          expect(e.failure._tag).toBe("StoreFailure")
          expect(isTimeoutFailure(e.failure)).toBe(true)
        }
        // Nobody else wrote: R2 still holds the version this job holds, so the next renewal can succeed.
        expect(r.stored).toBe(r.held)
        return { valid: true, boundary: extra === 1 }
      },
      60,
      { domain: "limit 1–2000 ms, request 1–5000 ms slower than the limit", minValidFraction: 1, minBoundary: 0 }
    )
  })

  it("T5 negation: reporting a timeout as PreconditionFailed makes the holder think its lock was taken over (LockLost)", async () => {
    const asPrecondition = (s: ObjectStore, t: number): ObjectStore => {
      const lim = <A, E>(key: string, eff: Effect.Effect<A, E>) =>
        Effect.timeoutOrElse(eff, { duration: Duration.millis(t), orElse: () => Effect.fail(new PreconditionFailed({ key })) })
      return { putIfNoneMatch: (k, b) => lim(k, s.putIfNoneMatch(k, b)), putIfMatch: (k, e, b) => lim(k, s.putIfMatch(k, e, b)), get: (k) => lim(k, s.get(k)) }
    }
    const killed = await mutantKilledAsync(
      fc.record({ t: fc.integer({ min: 1, max: 2_000 }), extra: fc.integer({ min: 1, max: 5_000 }) }),
      async ({ t, extra }) => {
        const r = await run(renewTimedOut(asPrecondition, t, t + extra))
        return Exit.isSuccess(r.exit) && Result.isFailure(r.exit.value) && r.exit.value.failure._tag === "StoreFailure"
      },
      20
    )
    expect(killed).toBe(true)
  })
})
