/**
 * The Effect v4 facade (`src/fx`): semantics of every v4 name it adds, and
 * the lint rule that keeps call sites on the facade and off the v3 names.
 *
 * Each semantic test states the behaviour the v4 guide documents for the
 * name (`Fibers.md`, `Building Pipelines.md`, `Cache.md`,
 * `Metrics in Effect.md`) and checks the facade's implementation of it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Cache, Deferred, Duration, Effect, Exit, Fiber, Metric, Option, Ref, Result } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import { announce, params } from "../harness.js"

announce("test/fx/facade.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)
const runTest = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

/** A metric name no other test uses (the metric registry is process-wide). */
let metricSerial = 0
const freshName = (base: string) => `facade_test_${base}_${metricSerial++}_${Date.now()}`

describe("Result (v4 replacement of Either)", () => {
  const resultArb = fc.oneof(
    fc.anything().map((a) => Result.succeed(a)),
    fc.anything().map((e) => Result.fail(e))
  )

  it("has v4's shape: { _tag: 'Success', success } | { _tag: 'Failure', failure }", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(Result.succeed(v)).toMatchObject({ _tag: "Success", success: v })
        expect(Result.fail(v)).toMatchObject({ _tag: "Failure", failure: v })
      }),
      params(200)
    )
  })

  it("guards, match and mapError agree with the tag", () => {
    fc.assert(
      fc.property(resultArb, (r) => {
        expect(Result.isSuccess(r)).toBe(r._tag === "Success")
        expect(Result.isFailure(r)).toBe(r._tag === "Failure")
        const folded = Result.match(r, { onSuccess: () => "s", onFailure: () => "f" })
        expect(folded).toBe(r._tag === "Success" ? "s" : "f")
        const mapped = Result.mapError(r, (e) => ({ wrapped: e }))
        if (r._tag === "Success") expect(mapped).toEqual(r)
        else expect(mapped).toEqual(Result.fail({ wrapped: r.failure }))
      }),
      params(300)
    )
  })

  it("getOrThrow returns the success value and throws on a failure", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(Result.getOrThrow(Result.succeed(v))).toBe(v)
        expect(() => Result.getOrThrow(Result.fail(new Error("boom")))).toThrow("boom")
        expect(() => Result.getOrThrow(Result.fail(v))).toThrow()
      }),
      params(100)
    )
  })
})

describe("Effect.result / fromResult / fromOption (Building Pipelines: Option and Result with andThen)", () => {
  it("Effect.result captures the outcome, and fromResult is its inverse", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer(), async (ok, v) => {
        const eff: Effect.Effect<number, number> = ok ? Effect.succeed(v) : Effect.fail(v)
        const r = await run(Effect.result(eff))
        expect(r).toEqual(ok ? Result.succeed(v) : Result.fail(v))
        expect(await run(Effect.result(Effect.fromResult(r)))).toEqual(r)
      }),
      params(100)
    )
  })

  it("an Option is an effect that fails with NoSuchElementError on None", async () => {
    expect(await run(Effect.fromOption(Option.some(42)))).toBe(42)
    const exit = await run(Effect.exit(Effect.fromOption(Option.none())))
    expect(Exit.isFailure(exit)).toBe(true)
    const r = await run(Effect.result(Effect.fromOption(Option.none())))
    expect(r._tag === "Failure" && r.failure._tag).toBe("NoSuchElementError")
  })

  it("Effect.andThen with a Result-returning step merges the error channels (the guide's parseInteger example)", async () => {
    const parseInteger = (input: string): Result.Result<number, string> =>
      Number.isNaN(Number.parseInt(input, 10)) ? Result.fail("Invalid integer") : Result.succeed(Number.parseInt(input, 10))
    expect(await run(Effect.succeed("42").pipe(Effect.andThen((s) => Effect.fromResult(parseInteger(s)))))).toBe(42)
    const bad = await run(Effect.result(Effect.succeed("x").pipe(Effect.andThen((s) => Effect.fromResult(parseInteger(s))))))
    expect(bad).toEqual(Result.fail("Invalid integer"))
  })
})

describe("fiber lifetimes (Fibers: Lifetime of Child Fibers)", () => {
  it("forkChild: the child is interrupted when its parent ends", async () => {
    const interrupted = await run(
      Effect.gen(function* () {
        const flag = yield* Ref.make(false)
        const done = yield* Deferred.make<void>()
        yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Effect.forkChild(
              Effect.never.pipe(Effect.onInterrupt(() => Effect.andThen(Ref.set(flag, true), Deferred.succeed(done, undefined))))
            )
            yield* Effect.sleep(Duration.millis(5))
          })
        )
        yield* Deferred.await(done)
        return yield* Ref.get(flag)
      })
    )
    expect(interrupted).toBe(true)
  })

  it("forkDetach: a daemon keeps running after its parent has finished", async () => {
    const done = await run(Deferred.make<string>())
    await run(Effect.forkDetach(Effect.andThen(Effect.sleep(Duration.millis(20)), Deferred.succeed(done, "daemon finished"))))
    expect(await run(Deferred.await(done))).toBe("daemon finished")
  })

  it("forkScoped: the fiber outlives its parent and stops when the scope closes", async () => {
    const ticks = await runTest(
      Effect.gen(function* () {
        const count = yield* Ref.make(0)
        const tick = Effect.forever(Effect.andThen(Effect.sleep(Duration.seconds(1)), Ref.update(count, (n) => n + 1)))
        const scoped = Effect.scoped(
          Effect.gen(function* () {
            // The parent forks the ticker into the enclosing scope and ends at once.
            const parent = yield* Effect.forkChild(Effect.forkScoped(tick))
            yield* Fiber.join(parent)
            yield* Effect.sleep(Duration.millis(5_500))
            return yield* Ref.get(count)
          })
        )
        const fiber = yield* Effect.forkChild(scoped)
        // Let the forked fibers start (and register their sleeps) before moving the clock.
        yield* Effect.yieldNow
        yield* TestClock.adjust(Duration.seconds(10))
        const atClose = yield* Fiber.join(fiber)
        return { atClose, later: yield* Ref.get(count) }
      })
    )
    expect(ticks.atClose).toBe(5) // still ticking after its parent ended
    expect(ticks.later).toBe(5) // no tick after the scope closed at 5.5 s
  })

  it("catchCause recovers from a defect as well as a failure (Composing Fiber Results)", async () => {
    expect(await run(Effect.catchCause(Effect.die("defect"), () => Effect.succeed("recovered")))).toBe("recovered")
    expect(await run(Effect.catchCause(Effect.fail("failure"), () => Effect.succeed("recovered")))).toBe("recovered")
    expect(await run(Effect.catch(Effect.fail("failure"), (e) => Effect.succeed(`caught ${e}`)))).toBe("caught failure")
  })
})

describe("Cache (Cache guide)", () => {
  it("concurrent gets of one key run the lookup once; distinct keys each once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom("a", "bb", "ccc", "dddd"), { minLength: 1, maxLength: 30 }), async (keys) => {
        const out = await run(
          Effect.gen(function* () {
            const calls = yield* Ref.make(0)
            const cache = yield* Cache.make({
              capacity: 100,
              timeToLive: Duration.infinity,
              lookup: (k: string) => Effect.andThen(Ref.update(calls, (n) => n + 1), Effect.as(Effect.sleep(Duration.millis(1)), k.length))
            })
            const values = yield* Effect.forEach(keys, (k) => Cache.get(cache, k), { concurrency: "unbounded" })
            return { values, calls: yield* Ref.get(calls), size: yield* Cache.size(cache), hasA: yield* Cache.has(cache, "a") }
          })
        )
        expect(out.values).toEqual(keys.map((k) => k.length))
        expect(out.calls).toBe(new Set(keys).size)
        expect(out.size).toBe(new Set(keys).size)
        expect(out.hasA).toBe(keys.includes("a"))
      }),
      params(40)
    )
  })

  it("a failed lookup is cached; invalidate makes the next get recompute", async () => {
    const out = await run(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const cache = yield* Cache.make({
          capacity: 10,
          timeToLive: Duration.infinity,
          lookup: (k: string) => Effect.andThen(Ref.update(calls, (n) => n + 1), Effect.fail(`no ${k}`))
        })
        const first = yield* Effect.result(Cache.get(cache, "x"))
        const second = yield* Effect.result(Cache.get(cache, "x"))
        const afterTwo = yield* Ref.get(calls)
        yield* Cache.invalidate(cache, "x")
        yield* Effect.result(Cache.get(cache, "x"))
        return { first, second, afterTwo, afterInvalidate: yield* Ref.get(calls) }
      })
    )
    expect(out.first).toEqual(Result.fail("no x"))
    expect(out.second).toEqual(Result.fail("no x"))
    expect(out.afterTwo).toBe(1)
    expect(out.afterInvalidate).toBe(2)
  })
})

describe("Metric (Metrics guide)", () => {
  it("counter: trackSuccesses adds each value; incremental counters ignore decrements; withConstantInput counts calls", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 20 }), async (xs) => {
        const plain = Metric.counter(freshName("counter"))
        const inc = Metric.counter(freshName("incremental"), { incremental: true })
        const calls = Metric.counter(freshName("calls")).pipe(Metric.withConstantInput(1))
        const state = await run(
          Effect.gen(function* () {
            for (const x of xs) {
              yield* Effect.succeed(x).pipe(Effect.trackSuccesses(plain), Effect.trackSuccesses(inc), Effect.trackSuccesses(calls))
            }
            return {
              plain: (yield* Metric.value(plain)).count,
              inc: (yield* Metric.value(inc)).count,
              calls: (yield* Metric.value(calls)).count
            }
          })
        )
        expect(state.plain).toBe(xs.reduce((s, x) => s + x, 0))
        expect(state.inc).toBe(xs.filter((x) => x > 0).reduce((s, x) => s + x, 0))
        expect(state.calls).toBe(xs.length)
      }),
      params(50)
    )
  })

  it("gauge keeps the last value; histogram, summary and frequency count every observation", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 120 }), { minLength: 1, maxLength: 40 }), async (xs) => {
        const gauge = Metric.gauge(freshName("gauge"))
        const histogram = Metric.histogram(freshName("histogram"), {
          boundaries: Metric.linearBoundaries({ start: 0, width: 10, count: 11 })
        })
        const summary = Metric.summary(freshName("summary"), { maxAge: "1 day", maxSize: 100, quantiles: [0.1, 0.5, 0.9] })
        const frequency = Metric.frequency(freshName("frequency"))
        const s = await run(
          Effect.gen(function* () {
            for (const x of xs) {
              yield* Effect.succeed(x).pipe(Effect.trackSuccesses(gauge), Effect.trackSuccesses(histogram), Effect.trackSuccesses(summary))
              yield* Effect.succeed(`Error-${x % 3}`).pipe(Effect.trackSuccesses(frequency))
            }
            return {
              gauge: yield* Metric.value(gauge),
              histogram: yield* Metric.value(histogram),
              summary: yield* Metric.value(summary),
              frequency: yield* Metric.value(frequency)
            }
          })
        )
        expect(s.gauge.value).toBe(xs.at(-1))
        expect(s.histogram.count).toBe(xs.length)
        expect(s.histogram.sum).toBe(xs.reduce((a, b) => a + b, 0))
        expect(s.histogram.min).toBe(Math.min(...xs))
        expect(s.histogram.max).toBe(Math.max(...xs))
        expect(s.histogram.buckets.at(-1)).toEqual([Number.POSITIVE_INFINITY, xs.length])
        expect(s.summary.count).toBe(xs.length)
        expect(s.summary.quantiles.length).toBe(3)
        expect([...s.frequency.occurrences.values()].reduce((a, b) => a + b, 0)).toBe(xs.length)
      }),
      params(40)
    )
  })

  it("timer: trackDuration records one observation per run, measured on the Effect clock", async () => {
    const timer = Metric.timer(freshName("timer"), { boundaries: [1, 10, 100, 1_000] })
    const state = await runTest(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.sleep(Duration.millis(50)).pipe(Effect.trackDuration(timer), Effect.repeat({ times: 2 })))
        yield* TestClock.adjust(Duration.millis(200))
        yield* Fiber.join(fiber)
        return yield* Metric.value(timer)
      })
    )
    expect(state.count).toBe(3)
    expect(state.min).toBeGreaterThanOrEqual(50)
  })

  it("withAttributes leaves the metric usable", async () => {
    const counter = Metric.counter(freshName("attributed")).pipe(Metric.withAttributes({ environment: "test" }))
    const count = await run(Effect.andThen(Effect.succeed(3).pipe(Effect.trackSuccesses(counter)), Metric.value(counter)))
    expect(count.count).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Lint: Effect is used through the facade, with v4 names only.

/** v3 spellings the facade replaces, with the v4 name to use instead. */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/from "effect(\/[A-Za-z]+)?"/, 'import from the facade ("src/fx/index.js"), not from "effect"'],
  [/\bEffect\.fork\b(?![A-Za-z])/, "Effect.forkChild"],
  [/\bEffect\.forkDaemon\b/, "Effect.forkDetach"],
  [/\bEffect\.either\b/, "Effect.result"],
  [/\bEffect\.catchAll\b/, "Effect.catch"],
  [/\bEffect\.catchAllCause\b/, "Effect.catchCause"],
  [/\bEffect\.catchAllDefect\b/, "Effect.catchDefect"],
  [/\bEffect\.async\b/, "Effect.callback"],
  [/\bEffect\.zipRight\b/, "Effect.andThen"],
  [/\bEffect\.zipLeft\b/, "Effect.tap"],
  [/\bEither\./, "Result"],
  [/\bParseResult\b/, "Schema.formatIssue / Schema.SchemaError"],
  [/\bSchema\.decodeUnknownEither\b/, "Schema.decodeUnknownResult"],
  [/\bEffect\.timeoutFail\b/, "Effect.timeoutOrElse"],
  [/\bEffect\.timeoutTo\b/, "Effect.timeoutOrElse"],
  [/\bEffect\.orElseSucceed\b/, "Effect.catch(() => Effect.succeed(x))"],
  [/\bSchedule\.intersect\b/, "Effect.retry({ schedule, times }) or Schedule.upTo"],
  [/\bSchedule\.(whileInput|whileOutput|untilInput|untilOutput)\b/, "Schedule.while / Schedule.until"],
  [/\bCause\.(failureOption|isFailure|isDie|isInterrupted|isInterruptedOnly|failures|defects)\b/, "Cause.hasFails / hasDies / hasInterrupts / reasons"],
  [/\bExit\.isInterrupted\b/, "Exit.hasInterrupts"],
  [/\bSchema\.parseJson\b/, "Schema.fromJsonString"],
  [/\bSchema\.optionalWith\b/, "Schema.optionalKey + Schema.withDecodingDefaultKey"],
  [/\bSchema\.(filter|int|nonNegative|positive|pattern|minLength|minItems)\(/, "Schema.check(Schema.makeFilter / isInt / isGreaterThan… )"],
  [/\bSchema\.Union\((?!\[)/, "Schema.Union([...members])"],
  [/\bContext\.(Tag|GenericTag)\b/, "ServiceMap.Service"]
]

/**
 * Violations of {@link BANNED} in one file's text.
 *
 * @param file - Path used in the messages.
 * @param text - File contents.
 * @returns One message per offending line and rule.
 */
const lintFacade = (file: string, text: string): Array<string> => {
  const out: Array<string> = []
  text.split("\n").forEach((line, i) => {
    for (const [re, instead] of BANNED) if (re.test(line)) out.push(`${file}:${i + 1}: use ${instead}: ${line.trim()}`)
  })
  return out
}

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []
  })

describe("facade lint", () => {
  const root = new URL("../../", import.meta.url).pathname
  const files = [...walk(join(root, "src")), ...walk(join(root, "test"))].filter(
    (f) => !f.includes(`${join("src", "fx")}`) && !f.endsWith(join("test", "fx", "facade.test.ts"))
  )

  it("every TypeScript file outside src/fx imports Effect from the facade and uses v4 names", () => {
    expect(files.length).toBeGreaterThan(50)
    const offences = files.flatMap((f) => lintFacade(relative(root, f), readFileSync(f, "utf8")))
    expect(offences).toEqual([])
  })

  it("negation: each banned spelling is reported, and its v4 replacement is not", () => {
    const bad = [
      'import { Effect } from "effect"',
      "Effect.fork(x)",
      "pipe(x, Effect.fork)",
      "Effect.forkDaemon(x)",
      "Effect.either(x)",
      "Effect.catchAll(x, f)",
      "Effect.catchAllCause(x, f)",
      "Effect.catchAllDefect(x, f)",
      "Effect.async((k) => k)",
      "Effect.zipRight(a, b)",
      "Effect.zipLeft(a, b)",
      "Either.isLeft(r)",
      "ParseResult.TreeFormatter",
      "Schema.decodeUnknownEither(s)",
      "Effect.timeoutFail({ duration, onTimeout })",
      "Effect.orElseSucceed(() => 1)",
      "Schedule.intersect(Schedule.recurs(5))",
      "Cause.failureOption(c)",
      "Exit.isInterrupted(e)",
      "Schema.parseJson(M)",
      "Schema.optionalWith(S, { default })",
      "Schema.filter((s) => true)",
      "Schema.Union(A, B)",
      "Context.Tag(\"X\")"
    ]
    for (const line of bad) expect(lintFacade("x.ts", line), line).toHaveLength(1)
    const good = [
      'import { Effect } from "../fx/index.js"',
      "Effect.forkChild(x)",
      "Effect.forkScoped(x)",
      "Effect.forkDetach(x)",
      "Effect.forkIn(x, scope)",
      "Effect.result(x)",
      "Effect.catch(x, f)",
      "Effect.catchCause(x, f)",
      "Effect.catchTag(x, 'A', f)",
      "Effect.callback((k) => k)",
      "Effect.andThen(a, b)",
      "Result.isFailure(r)",
      "Schema.decodeUnknownResult(s)",
      "Effect.timeoutOrElse({ duration, orElse })",
      "Cause.hasFails(c)",
      "Exit.hasInterrupts(e)",
      "Schema.fromJsonString(M)",
      "Schema.optionalKey(S)",
      "Schema.check(Schema.isInt())",
      "Schema.Union([A, B])"
    ]
    for (const line of good) expect(lintFacade("x.ts", line), line).toEqual([])
  })
})
