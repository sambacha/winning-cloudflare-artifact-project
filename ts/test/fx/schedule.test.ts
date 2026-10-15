/**
 * Semantics of the v4-shaped `Schedule` combinators of the facade
 * (`src/fx/Schedule.ts`), pinned with `TestClock` as the style guide
 * prescribes (`skills.md` § 8, § 15): fork the program, adjust the clock,
 * join the fiber, and record times with `Clock.currentTimeMillis`.
 */
import { describe, expect, it } from "vitest"
import { Clock, Data, Duration, Effect, Fiber, Schedule } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"

class RateLimited extends Data.TaggedError("RateLimited")<{ readonly retryAfter: Duration.Duration }> {}

/** Fails `failures` times with `RateLimited`, recording the time of each attempt. */
const flaky = (failures: number, retryAfter: Duration.Duration, times: Array<number>) => {
  let n = 0
  return Effect.gen(function* () {
    times.push(yield* Clock.currentTimeMillis)
    n++
    if (n <= failures) return yield* Effect.fail(new RateLimited({ retryAfter }))
    return n
  })
}

const run = <A, E>(program: Effect.Effect<A, E>, advance: Duration.Duration) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(program))
      yield* TestClock.adjust(advance)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))
  )

describe("facade Schedule (v4 shapes)", () => {
  it("upTo({ times: n }) allows n + 1 executions", async () => {
    const times: Array<number> = []
    const r = await run(flaky(10, Duration.zero, times).pipe(Effect.retry(Schedule.recurs(100).pipe(Schedule.upTo({ times: 3 })))), Duration.seconds(1))
    expect(r._tag).toBe("Failure")
    expect(times.length).toBe(4)
  })

  it("modifyDelay sees the typed input: Retry-After overrides a shorter backoff", async () => {
    const times: Array<number> = []
    const policy = Schedule.exponential("100 millis").pipe(
      Schedule.setInputType<RateLimited>(),
      Schedule.modifyDelay(({ duration, input }) => Effect.succeed(Duration.max(duration, input.retryAfter))),
      Schedule.upTo({ times: 4 })
    )
    const r = await run(flaky(3, Duration.seconds(1), times).pipe(Effect.retry(policy)), Duration.seconds(10))
    expect(r).toMatchObject({ _tag: "Success", success: 4 })
    expect(times).toEqual([0, 1000, 2000, 3000])
  })

  it("modifyDelay keeps the backoff when it is longer than Retry-After", async () => {
    const times: Array<number> = []
    const policy = Schedule.exponential("1 second").pipe(
      Schedule.setInputType<RateLimited>(),
      Schedule.modifyDelay(({ duration, input }) => Effect.succeed(Duration.max(duration, input.retryAfter))),
      Schedule.upTo({ times: 4 })
    )
    await run(flaky(3, Duration.millis(10), times).pipe(Effect.retry(policy)), Duration.seconds(30))
    expect(times).toEqual([0, 1000, 3000, 7000])
  })

  it("tap after upTo records exactly the permitted retries, before each wait", async () => {
    const events: Array<{ attempt: number; delayMs: number }> = []
    const policy = Schedule.exponential("100 millis").pipe(
      Schedule.setInputType<RateLimited>(),
      Schedule.upTo({ times: 2 }),
      Schedule.tap(({ attempt, duration }) => Effect.sync(() => void events.push({ attempt, delayMs: Duration.toMillis(duration) })))
    )
    const r = await run(flaky(10, Duration.zero, []).pipe(Effect.retry(policy)), Duration.seconds(5))
    expect(r._tag).toBe("Failure")
    expect(events).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 }
    ])
  })

  it("max waits the largest delay; min the smallest", async () => {
    const tMax: Array<number> = []
    const tMin: Array<number> = []
    const both = [Schedule.spaced("100 millis"), Schedule.spaced("1 second")] as const
    await run(flaky(2, Duration.zero, tMax).pipe(Effect.retry(Schedule.max(both))), Duration.seconds(5))
    await run(flaky(2, Duration.zero, tMin).pipe(Effect.retry(Schedule.min(both))), Duration.seconds(5))
    expect(tMax).toEqual([0, 1000, 2000])
    expect(tMin).toEqual([0, 100, 200])
  })

  it("negation: without upTo the same schedule retries past 3", async () => {
    const times: Array<number> = []
    await run(flaky(10, Duration.zero, times).pipe(Effect.retry(Schedule.recurs(100))), Duration.seconds(1))
    expect(times.length).toBe(11)
  })

  it("Effect.retry while runs after the schedule step: a tap in the schedule sees the error that stops the retry", async () => {
    // Why `restRetryPolicy` gates retriability inside the schedule (first
    // step) rather than with `Effect.retry({ schedule, while })`.
    class Transport extends Data.TaggedError("Transport")<{}> {}
    const tapped: Array<string> = []
    const policy = Schedule.exponential("1 second").pipe(
      Schedule.setInputType<RateLimited | Transport>(),
      Schedule.upTo({ times: 3 }),
      Schedule.tap(({ input }) =>
        Effect.sync(() => {
          tapped.push(input._tag)
        })
      )
    )
    let n = 0
    const program: Effect.Effect<never, RateLimited | Transport> = Effect.suspend((): Effect.Effect<never, RateLimited | Transport> => (n++ === 0 ? Effect.fail(new RateLimited({ retryAfter: Duration.zero })) : Effect.fail(new Transport())))
    const viaOption = await run(program.pipe(Effect.retry({ schedule: policy, while: (e) => e._tag === "RateLimited" })), Duration.seconds(10))
    expect(viaOption._tag).toBe("Failure")
    expect(n).toBe(2) // the retry does stop at the transport error ...
    expect(tapped).toEqual(["RateLimited", "Transport"]) // ... but only after the tap observed it

    tapped.length = 0
    n = 0
    const gated = Schedule.exponential("1 second").pipe(
      Schedule.setInputType<RateLimited | Transport>(),
      Schedule.while(({ input }) => input._tag === "RateLimited"),
      Schedule.upTo({ times: 3 }),
      Schedule.tap(({ input }) =>
        Effect.sync(() => {
          tapped.push(input._tag)
        })
      )
    )
    const viaSchedule = await run(program.pipe(Effect.retry(gated)), Duration.seconds(10))
    expect(viaSchedule._tag).toBe("Failure")
    expect(n).toBe(2)
    expect(tapped).toEqual(["RateLimited"])
  })

  it("seam pattern: a Promise-based fake that fails twice, Retry-After 2 s over a 1 s backoff; tap after upTo records [2000, 2000]; one adjust of 6 s", async () => {
    const recordedDelays: Array<number> = []
    const retryPolicy = Schedule.exponential("1 second").pipe(
      Schedule.setInputType<RateLimited>(),
      Schedule.modifyDelay(({ duration, input }) => Effect.succeed(Duration.max(duration, input.retryAfter))),
      Schedule.upTo({ times: 3 }),
      Schedule.tap(({ duration }) =>
        Effect.sync(() => {
          recordedDelays.push(Duration.toMillis(duration))
        })
      )
    )
    let attempts = 0
    const fakeFetch = Effect.tryPromise({
      try: () => {
        attempts++
        return attempts < 3 ? Promise.reject(new Error("rate limited")) : Promise.resolve("success")
      },
      catch: () => new RateLimited({ retryAfter: Duration.seconds(2) })
    })
    const r = await run(fakeFetch.pipe(Effect.retry(retryPolicy)), Duration.seconds(6))
    expect(r).toMatchObject({ _tag: "Success", success: "success" })
    expect(attempts).toBe(3)
    expect(recordedDelays).toEqual([2000, 2000])
  })
})
