/**
 * Status after the third test pass (`docs/test-review.md` §TS-Sc): every
 * scenario below is a labelled **regression example**, not the primary test.
 * The general law each one is an instance of lives in `test/laws.test.ts`
 * (renewal schedule, failure shelf life, takeover threshold and fencing,
 * persistent 429, abandon, 412-is-final, configuration predicate) or
 * `test/cache/keyLaws.test.ts` (keys), checked on fresh random inputs with
 * total / valid / boundary counts and mutants.
 *
 * Deterministic scenarios, each mirroring a Lean result in
 * `RequestProject/Cobuilds`. Time is driven by Effect's `TestClock`
 * (starting at 0 ms).
 *
 * Audited against `docs/testing-guidelines.md` (`docs/test-audit.md`). Three
 * tests were rewritten:
 * - "persistent 429 …" claimed the heartbeat gives up *before expiry* but did
 *   not check when; it now pins the time of the interruption (F3, D3);
 * - the key-encoding test checked two hand-picked pairs; it is now a seeded
 *   property over adversarial strings, with the decode ∘ encode round trip
 *   (D2) and injectivity;
 * - the configuration test contained a tautological assertion
 *   (`Option.isSome(Option.some(1))`, A5) and probed far from the bounds; it
 *   now probes both bounds at predecessor / threshold / successor (B1).
 */
import { Clock, Duration, Effect, Fiber, Result } from "../src/fx/index.js"
import { TestClock } from "../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, params } from "./harness.js"
import { decodeKey, encodeKey } from "../src/cache/keyEncoding.js"
import {
  checkCobuildConfig,
  type CobuildConfig,
  type CobuildLock,
  type HeldLock,
  makeCobuildLock,
  makeMemoryStore,
  type MemoryStore,
  type ObjectStore,
  RateLimited,
  resolveConfig,
  runCobuild,
  StoreFailure
} from "../src/index.js"
import { CacheKey, JobId } from "../src/ids.js"

announce("test/scenarios.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

const setup = (store: ObjectStore = makeMemoryStore()) => {
  const a = makeCobuildLock(store, { scope: "trusted", context: "build-1", jobId: JobId("A") })
  const b = makeCobuildLock(store, { scope: "trusted", context: "build-1", jobId: JobId("B") })
  return { a, b }
}

const obtain = (lock: CobuildLock, cacheKey: string) =>
  Effect.flatMap(lock.acquire(CacheKey(cacheKey)), (s) =>
    s.state === "obtained" ? Effect.succeed(s.lock) : Effect.die(new Error(`expected obtained, got ${s.state}`))
  )

const log = (store: MemoryStore, lock: CobuildLock, cacheKey: string) =>
  store.writeLog.get(lock.objectKey(CacheKey(cacheKey))) ?? []

describe("renewal keeps the ETag R2 returns (review item 2)", () => {
  it("two consecutive renewals succeed; reusing the acquisition ETag is rejected", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a } = setup(store)
        const h0 = yield* obtain(a, "p")
        yield* TestClock.adjust(10_000)
        const h1 = yield* a.renewOnce(h0)
        yield* TestClock.adjust(10_000)
        const h2 = yield* a.renewOnce(h1)
        expect(h2.etag).not.toBe(h1.etag)
        expect(store.peek(h2.objectKey)?.etag).toBe(h2.etag)
        expect(h2.manifest.expiresAt).toBe(50_000)
        // The original bug: renewing with the acquisition's ETag gets 412 (`stale_cas_rejected`).
        yield* TestClock.adjust(10_000)
        const stale = yield* Effect.result(a.renewOnce(h0))
        expect(stale._tag === "Failure" && stale.failure._tag).toBe("LockLost")
      })
    ))
})

describe("runCobuild", () => {
  it("a 35 s build renews three times, publishes with the latest ETag, and is not rebuilt (items 1, 3)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a, b } = setup(store)
        const fiber = yield* Effect.forkChild(
          runCobuild(a, {
            cacheKey: CacheKey("p"),
            build: Effect.as(Effect.sleep(35_000), "output"),
            upload: () => Effect.succeed("tarball/p")
          })
        )
        yield* TestClock.adjust(40_000)
        const result = yield* Fiber.join(fiber)
        expect(result).toEqual({ _tag: "Built", value: "output", buildCacheKey: "tarball/p" })
        expect(log(store, a, "p")).toEqual([0, 10_000, 20_000, 30_000, 35_000])
        // Nothing was released after publishing: B sees the result (`no_duplicate_builds`).
        expect(yield* b.acquire(CacheKey("p"))).toEqual({ state: "completed", buildCacheKey: "tarball/p" })
        yield* TestClock.adjust(3_600_000)
        expect(yield* b.acquire(CacheKey("p"))).toEqual({ state: "completed", buildCacheKey: "tarball/p" })
      })
    ))

  it("a publish 500 ms after a renewal gets 429 and is retried after 1 s (`publish_after_renew_rate_limited`)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a } = setup(store)
        const fiber = yield* Effect.forkChild(
          runCobuild(a, {
            cacheKey: CacheKey("p"),
            build: Effect.as(Effect.sleep(30_500), "output"),
            upload: () => Effect.succeed("tarball/p")
          })
        )
        yield* TestClock.adjust(40_000)
        const result = yield* Fiber.join(fiber)
        expect(result._tag).toBe("Built")
        expect(log(store, a, "p")).toEqual([0, 10_000, 20_000, 30_000, 31_500])
      })
    ))

  it("a failed build publishes a failure marker whose shelf life starts at the failure (items 4, 8)", () =>
    run(
      Effect.gen(function* () {
        // Shelf life shortened to 60 s (30 min in production) to keep the test fast;
        // the build (95 s) is longer than the shelf life, as in the review.
        const store = makeMemoryStore()
        const shelf = { scope: "trusted", context: "build-1", failureShelf: Duration.millis(60_000) }
        const a = makeCobuildLock(store, { ...shelf, jobId: JobId("A") })
        const b = makeCobuildLock(store, { ...shelf, jobId: JobId("B") })
        const fiber = yield* Effect.forkChild(
          runCobuild(a, {
            cacheKey: CacheKey("p"),
            build: Effect.andThen(Effect.sleep(95_000), Effect.fail("tests failed")),
            upload: () => Effect.succeed("unused"),
            uploadFailureLog: () => Effect.succeed("logs/p")
          })
        )
        yield* TestClock.adjust(95_000)
        const result = yield* Fiber.join(fiber)
        expect(result._tag).toBe("BuildFailed")
        // Measured from acquiredAt (0) the marker would already be stale; it is not.
        yield* TestClock.adjust(1_000)
        expect(yield* b.acquire(CacheKey("p"))).toEqual({ state: "failed", failedAt: 95_000, logKey: "logs/p" })
        yield* TestClock.adjust(59_000)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("failed") // exactly failedAt + shelf: not yet
        yield* TestClock.adjust(1)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("obtained")
      })
    ))

  it("persistent 429 on renewals: the heartbeat gives up at the lease expiry, not after, and interrupts the build (item 7)", () =>
    run(
      Effect.gen(function* () {
        const base = makeMemoryStore()
        const store: ObjectStore = {
          ...base,
          putIfMatch: (key) => Effect.fail(new RateLimited({ key }))
        }
        const { a } = setup(store)
        let interruptedAt: number | null = null
        const fiber = yield* Effect.forkChild(
          runCobuild(a, {
            cacheKey: CacheKey("p"),
            build: Effect.sleep(3_600_000).pipe(
              Effect.onInterrupt(() =>
                Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => (interruptedAt = t)))
              )
            ),
            upload: () => Effect.succeed("unused")
          })
        )
        yield* TestClock.adjust(60_000)
        const result = yield* Fiber.join(fiber)
        expect(result).toEqual({ _tag: "LockLost" })
        // Renewals are tried at 10 000 and then every second while the lease
        // (expiresAt = 30 000) would still be valid; the last try is at 30 000,
        // so the build is interrupted exactly at the expiry, never later.
        expect(interruptedAt).toBe(30_000)
      })
    ))

  it("an upload failure never publishes success; the lock is given up and B takes over (`cache_coherence`)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a, b } = setup(store)
        const fiber = yield* Effect.forkChild(
          runCobuild(a, {
            cacheKey: CacheKey("p"),
            build: Effect.as(Effect.sleep(5_000), "output"),
            upload: () => Effect.fail("upload failed" as const)
          })
        )
        yield* TestClock.adjust(5_000)
        const exit = yield* Effect.result(Fiber.join(fiber))
        expect(Result.isFailure(exit) && exit.failure).toBe("upload failed")
        yield* TestClock.adjust(1_000)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("obtained")
      })
    ))

  it("another job's live lease gives Pending", () =>
    run(
      Effect.gen(function* () {
        const { a, b } = setup()
        yield* obtain(a, "p")
        yield* TestClock.adjust(1_000)
        const r = yield* runCobuild(b, {
          cacheKey: CacheKey("p"),
          build: Effect.succeed("x"),
          upload: () => Effect.succeed("y")
        })
        expect(r).toEqual({ _tag: "Pending", owner: "A", expiresAt: 30_000 })
      })
    ))
})

describe("takeover and fencing", () => {
  it("a crashed holder's lock is taken over just after expiry; its late writes are rejected (`failure_recovery`, `stale_cas_rejected`)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a, b } = setup(store)
        const ha = yield* obtain(a, "p")
        yield* TestClock.adjust(30_000)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("pending") // expiresAt = 30 000, not yet expired
        yield* TestClock.adjust(1)
        const hb = yield* obtain(b, "p")
        expect(hb.manifest.owner).toBe("B")
        expect(store.peek(hb.objectKey)?.etag).toBe(hb.etag) // the steal kept R2's new ETag
        yield* TestClock.adjust(1_000)
        const renew = yield* Effect.result(a.renewOnce(ha))
        expect(renew._tag === "Failure" && renew.failure._tag).toBe("LockLost")
        const publish = yield* Effect.result(a.markCompleted(ha, { status: "succeeded", buildCacheKey: "x" }))
        expect(publish._tag === "Failure" && publish.failure._tag).toBe("LockLost")
        expect(store.peek(hb.objectKey)?.etag).toBe(hb.etag)
      })
    ))

  it("412 is not retried (item 6)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a } = setup(store)
        const h0 = yield* obtain(a, "p")
        yield* TestClock.adjust(10_000)
        yield* a.renewOnce(h0)
        yield* TestClock.adjust(10_000)
        const before = store.calls.putIfMatch
        const r = yield* Effect.result(a.markCompleted(h0, { status: "succeeded", buildCacheKey: "x" }))
        expect(r._tag === "Failure" && r.failure._tag).toBe("LockLost")
        expect(store.calls.putIfMatch - before).toBe(1)
      })
    ))

  it("abandon makes the lock stealable at once, without DeleteObject (item 5)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const { a, b } = setup(store)
        const h = yield* obtain(a, "p")
        yield* TestClock.adjust(1_000)
        yield* a.abandon(h)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("pending") // same instant: 429 on the takeover
        yield* TestClock.adjust(1_000)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("obtained")
      })
    ))

  it("a renewal whose response was lost is recognised by its nonce", () =>
    run(
      Effect.gen(function* () {
        const base = makeMemoryStore()
        let dropNext = true
        const store: ObjectStore = {
          ...base,
          putIfMatch: (key, etag, body) =>
            Effect.flatMap(base.putIfMatch(key, etag, body), (e) => {
              if (!dropNext) return Effect.succeed(e)
              dropNext = false
              return Effect.fail(new StoreFailure({ key, cause: "connection reset" }))
            })
        }
        const { a } = setup(store)
        const h0 = yield* obtain(a, "p")
        yield* TestClock.adjust(10_000)
        const h1: HeldLock = yield* a.renewOnce(h0)
        expect(base.peek(h1.objectKey)?.etag).toBe(h1.etag)
      })
    ))

  // Regression for the client-retry case found in the R2 review (docs/r2-end-to-end-review.md, R2-3):
  // the first attempt is applied, its response is lost, and the client's automatic retry
  // is answered 412 (create) or 429 (CAS, < 1 s after the first attempt). The lock must
  // recognise its own write by the nonce instead of reporting pending / lost.
  it("a create and a renewal whose automatic retry was rejected (429 / 412) are recognised as our own writes", () =>
    run(
      Effect.gen(function* () {
        const base = makeMemoryStore()
        let mode: "create" | "cas" | "off" = "create"
        const store: ObjectStore = {
          ...base,
          putIfNoneMatch: (key, body) =>
            Effect.flatMap(base.putIfNoneMatch(key, body), (e) => {
              if (mode !== "create") return Effect.succeed(e)
              mode = "off"
              return Effect.flatMap(Effect.result(base.putIfNoneMatch(key, body)), (retry) =>
                Result.isFailure(retry) ? Effect.fail(retry.failure) : Effect.succeed(retry.success)
              )
            }),
          putIfMatch: (key, etag, body) =>
            Effect.flatMap(base.putIfMatch(key, etag, body), (e) => {
              if (mode !== "cas") return Effect.succeed(e)
              mode = "off"
              return Effect.flatMap(Effect.result(base.putIfMatch(key, etag, body)), (retry) =>
                Result.isFailure(retry) ? Effect.fail(retry.failure) : Effect.succeed(retry.success)
              )
            })
        }
        const { a, b } = setup(store)
        const s0 = yield* a.acquire(CacheKey("p"))
        expect(s0.state).toBe("obtained")
        if (s0.state !== "obtained") return
        expect(base.peek(s0.lock.objectKey)?.etag).toBe(s0.lock.etag)
        yield* TestClock.adjust(10_000)
        mode = "cas"
        const h1 = yield* a.renewOnce(s0.lock)
        expect(base.peek(h1.objectKey)?.etag).toBe(h1.etag)
        // Someone else's write is still final: B never adopts A's object.
        yield* TestClock.adjust(1_000)
        expect((yield* b.acquire(CacheKey("p"))).state).toBe("pending")
      })
    ))
})

describe("keys", () => {
  // Adversarial alphabet for keys (D2): separators, escapes, empty strings, non-ASCII.
  const nasty = fc.string({
    unit: fc.constantFrom("a", "b", "/", "%", "2", "F", " ", "é", "\u0000", "?", "#"),
    maxLength: 6
  })

  it("objectKey is injective and decodable on adversarial (scope, context, cacheKey) triples (D2, D-1, D-4)", () => {
    const store = makeMemoryStore()
    const scopeArb = fc.constantFrom("trusted", "fork-pr", "trusted-fork")
    const keyOf = (scope: string, context: string, cacheKey: string) =>
      makeCobuildLock(store, { scope, context, jobId: JobId("A") }).objectKey(CacheKey(cacheKey))
    fc.assert(
      fc.property(scopeArb, nasty, nasty, scopeArb, nasty, nasty, (s1, c1, k1, s2, c2, k2) => {
        // decode ∘ encode = id (round trip through the object key)
        expect(decodeKey(keyOf(s1, c1, k1))).toEqual([s1, "cobuild", c1, k1, "lock"])
        // injectivity: distinct triples never share an object
        if (s1 !== s2 || c1 !== c2 || k1 !== k2) expect(keyOf(s1, c1, k1)).not.toBe(keyOf(s2, c2, k2))
        // scope isolation: a lock key lies under exactly its own scope's prefix
        expect(keyOf(s1, c1, k1).startsWith(encodeKey([s2]))).toBe(s1 === s2)
      }),
      params(2_000)
    )
  })

  it("regression: the pair that collides without encoding stays distinct; layout is v1/<scope>/…", () => {
    const store = makeMemoryStore()
    const l1 = makeCobuildLock(store, { scope: "trusted", context: "a/b", jobId: JobId("A") })
    const l2 = makeCobuildLock(store, { scope: "trusted", context: "a", jobId: JobId("A") })
    expect(l1.objectKey(CacheKey("c"))).toBe("v1/trusted/cobuild/a%2Fb/c/lock/")
    expect(l2.objectKey(CacheKey("b/c"))).toBe("v1/trusted/cobuild/a/b%2Fc/lock/")
  })

  it("an untrusted job's lock (and result pointer) is a different object from a trusted job's (D-1)", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryStore()
        const t = makeCobuildLock(store, { scope: "trusted", context: "build-1", jobId: JobId("T") })
        const u = makeCobuildLock(store, { scope: "fork-pr", context: "build-1", jobId: JobId("U") })
        const hu = yield* obtain(u, "p")
        yield* TestClock.adjust(1_000) // one write per key per second
        yield* u.markCompleted(hu, { status: "succeeded", buildCacheKey: "evil" })
        // The trusted job does not see the untrusted "completed" pointer; it builds itself.
        expect((yield* t.acquire(CacheKey("p"))).state).toBe("obtained")
      })
    ))

  it("configuration predicate (D-10), probed at both edges (B1)", () => {
    const store = makeMemoryStore()
    const mk = (renewIntervalMs: number, extra: Partial<CobuildConfig> = {}) => () =>
      makeCobuildLock(store, { scope: "trusted", context: "c", jobId: JobId("A"), renewInterval: Duration.millis(renewIntervalMs), ...extra })
    // Lower bound (rate limit 1000): 999 rejected; 1000, 1001 accepted.
    expect(mk(999)).toThrow(/rateLimitMs <= renewIntervalMs/)
    expect(mk(1_000)).not.toThrow()
    expect(mk(1_001)).not.toThrow()
    // Upper bound: renew + latency (2000) + skew (1000) < lease (30 000), strict.
    expect(mk(26_999)).not.toThrow()
    expect(mk(27_000)).toThrow(/maxLatencyMs \+ maxSkewMs < leaseMs/)
    expect(mk(27_001)).toThrow()
    // Regression: the previous check (`renew < lease`) accepted 29 999 ms, leaving 1 ms for latency and skew.
    expect(mk(29_999)).toThrow()
    // With zero latency and skew the predicate reduces to the old upper bound.
    expect(mk(29_999, { maxLatency: Duration.millis(0), maxSkew: Duration.millis(0) })).not.toThrow()
    expect(mk(30_000, { maxLatency: Duration.millis(0), maxSkew: Duration.millis(0) })).toThrow()
    // Garbage values and invalid scopes are rejected, not silently accepted.
    expect(mk(10_000, { lease: Duration.infinity })).toThrow()
    expect(mk(10_000, { maxSkew: Duration.micros(1500n) })).toThrow()
    expect(() => makeCobuildLock(store, { scope: "feat/x", context: "c", jobId: JobId("A") })).toThrow(/scope/)
  })

  it("the default configuration satisfies the predicate with a 17 s margin", () => {
    const r = resolveConfig({ scope: "trusted", context: "c", jobId: JobId("A") })
    expect(checkCobuildConfig(r)).toEqual([])
    expect(r.leaseMs - (r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs)).toBe(17_000)
  })
})
