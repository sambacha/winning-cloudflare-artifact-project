/**
 * The directory-backed bucket (`src/fsBucket.ts`) has the request semantics
 * of the in-memory R2 simulator, so the end-to-end runs on it (several OS
 * processes, `test/cli/e2e.test.ts`) exercise the same protocol paths as R2:
 * create-only, compare-and-swap with fresh ETags, the per-key write rate
 * limit, and cursor listing. The concurrency law below races many writers
 * on one key: exactly one create may win, and every CAS chain stays linear.
 */
import { createHash } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect, Option, Result } from "../src/fx/index.js"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { announce, lawAsync, mutantKilledAsync } from "./harness.js"
import { makeFsBucket } from "../src/fsBucket.js"

announce("test/fsBucket.test.ts")

const dirs: Array<string> = []
const fresh = async () => {
  const d = await mkdtemp(join(tmpdir(), "fsbucket-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(e))

describe("fs bucket: R2 request semantics", () => {
  it("create-only, CAS with a fresh ETag per write, 412 on a stale ETag, get returns the latest version", async () => {
    const b = makeFsBucket(await fresh(), { rateLimitMs: 0 })
    const s = b.objectStore
    const e1 = await run(s.putIfNoneMatch("k", "v1"))
    expect(Result.isSuccess(e1)).toBe(true)
    const again = await run(s.putIfNoneMatch("k", "v1"))
    expect(Result.isFailure(again) && again.failure._tag).toBe("PreconditionFailed")
    const e2 = await run(s.putIfMatch("k", Result.getOrThrow(e1), "v2"))
    expect(Result.getOrThrow(e2)).not.toBe(Result.getOrThrow(e1))
    const stale = await run(s.putIfMatch("k", Result.getOrThrow(e1), "v3"))
    expect(Result.isFailure(stale) && stale.failure._tag).toBe("PreconditionFailed")
    expect(await Effect.runPromise(s.get("k"))).toEqual(Option.some({ body: "v2", etag: Result.getOrThrow(e2) }))
    const missing = await run(s.putIfMatch("nope", '"x"', "v"))
    expect(Result.isFailure(missing) && missing.failure._tag).toBe("PreconditionFailed")
    expect(await Effect.runPromise(s.get("nope"))).toEqual(Option.none())
  })

  it("regression (recorded): rate limit with a 1000 ms window — a write 999 ms later is 429, 1000 ms later accepted; other keys unaffected", async () => {
    let now = 10_000
    const b = makeFsBucket(await fresh(), { rateLimitMs: 1000, now: () => now })
    const s = b.objectStore
    const e1 = Result.getOrThrow(await run(s.putIfNoneMatch("k", "v1")))
    now += 999
    const limited = await run(s.putIfMatch("k", e1, "v2"))
    expect(Result.isFailure(limited) && limited.failure._tag).toBe("RateLimited")
    expect(Result.isSuccess(await run(s.putIfNoneMatch("other", "x")))).toBe(true)
    now += 1
    expect(Result.isSuccess(await run(s.putIfMatch("k", e1, "v2")))).toBe(true)
  })

  /*
   * Rate limit as a rule (replaces reliance on one 1000 ms / 999 ms example).
   * Requirement, stated without reference to any test value: for a window
   * W > 0, a write to key k at time t is answered 429 iff some earlier
   * *accepted* write to k happened at t' with t − t' < W; a 429 changes
   * nothing (body, ETag and the window's start stay as they were); writes to
   * other keys neither count against nor reset k's window; W = 0 disables the
   * limit. The reference model below is exactly that rule.
   */
  type RateOp = { readonly key: string; readonly dt: number }
  const rateCase = fc
    .oneof({ weight: 1, arbitrary: fc.constant(0) }, { weight: 4, arbitrary: fc.integer({ min: 1, max: 3_000 }) })
    .chain((windowMs) =>
      fc.record({
        windowMs: fc.constant(windowMs),
        ops: fc.array(
          fc.record({
            key: fc.constantFrom("a", "b", "c"),
            // Deltas concentrate on the window edges (W − 1, W, W + 1) and 0, plus anything up to 2W.
            dt: fc.oneof(fc.constantFrom(0, Math.max(0, windowMs - 1), windowMs, windowMs + 1), fc.integer({ min: 0, max: 2 * windowMs + 1 }))
          }),
          { minLength: 2, maxLength: 12 }
        )
      })
    )
  /** Expected outcome per op under the rule: "ok" or "429". */
  const rateModel = (windowMs: number, ops: ReadonlyArray<RateOp>): Array<"ok" | "429"> => {
    const lastAccepted = new Map<string, number>()
    let t = 0
    return ops.map((op) => {
      t += op.dt
      const last = lastAccepted.get(op.key)
      if (windowMs > 0 && last !== undefined && t - last < windowMs) return "429"
      lastAccepted.set(op.key, t)
      return "ok"
    })
  }
  type MakeBucket = typeof makeFsBucket
  /** Run the schedule on a bucket built by `make`; true iff every answer and every final body matches the rule. */
  const rateFollowsRule = async (make: MakeBucket, c: { windowMs: number; ops: ReadonlyArray<RateOp> }): Promise<boolean> => {
    let now = 50_000
    const b = make(await fresh(), { rateLimitMs: c.windowMs, now: () => now })
    const s = b.objectStore
    const expected = rateModel(c.windowMs, c.ops)
    const etag = new Map<string, string>()
    const body = new Map<string, string>()
    for (const [i, op] of c.ops.entries()) {
      now += op.dt
      const prev = etag.get(op.key)
      const r = await run(prev === undefined ? s.putIfNoneMatch(op.key, `v${i}`) : s.putIfMatch(op.key, prev, `v${i}`))
      const got = Result.isSuccess(r) ? "ok" : r.failure._tag === "RateLimited" ? "429" : r.failure._tag
      if (got !== expected[i]) return false
      if (Result.isSuccess(r)) {
        etag.set(op.key, r.success)
        body.set(op.key, `v${i}`)
      }
    }
    for (const [k, v] of body) {
      const cur = await Effect.runPromise(s.get(k))
      if (Option.isNone(cur) || cur.value.body !== v || cur.value.etag !== etag.get(k)) return false
    }
    return true
  }
  /** Load a planted source mutant of the bucket (patched copy next to the original, removed afterwards). */
  const loadBucketMutant = async (patches: ReadonlyArray<readonly [string, string]>): Promise<MakeBucket> => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src/fsBucket.ts")
    let code = readFileSync(src, "utf8")
    for (const [from, to] of patches) {
      if (!code.includes(from)) throw new Error(`mutation anchor not found: ${from}`)
      code = code.replace(from, to)
    }
    // One file name per distinct patched source, so the module cache never hands back another mutant.
    const file = join(dirname(src), `fsBucket.mutant-${process.pid}-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.ts`)
    writeFileSync(file, code)
    try {
      return ((await import(pathToFileURL(file).href)) as { makeFsBucket: MakeBucket }).makeFsBucket
    } finally {
      rmSync(file, { force: true })
    }
  }
  /** Mutant 1: the old example's window (1000 ms) hard-coded instead of `rateLimitMs`. */
  const hardCodedWindow = () =>
    loadBucketMutant([["meta.lastWriteMs + rateLimitMs <= now()", "meta.lastWriteMs + 1000 <= now()"]])
  /** Mutant 2: the window is anchored at the key's creation, not at its last accepted write. */
  const anchoredAtCreation = () =>
    loadBucketMutant([["lastWriteMs: now() }", "lastWriteMs: (await readMeta(dir))?.lastWriteMs ?? now() }"]])

  it("law: a write is 429 iff the key's last accepted write is less than the window ago; 429 changes nothing; keys are independent", async () => {
    await lawAsync(
      "per-key write window",
      rateCase,
      async (c) => {
        expect(await rateFollowsRule(makeFsBucket, c), JSON.stringify(c)).toBe(true)
        const verdicts = rateModel(c.windowMs, c.ops)
        return { valid: verdicts.includes("ok") && (c.windowMs === 0 || verdicts.includes("429")), boundary: c.windowMs === 0 || c.ops.some((o) => o.dt === c.windowMs) }
      },
      40,
      { domain: "window 0–3000 ms, 2–12 writes over 3 keys, deltas at and around the window edge", minValidFraction: 0.4, minBoundary: 3 }
    )
  }, 120_000)

  it("counterexample 1 (mutant: window hard-coded to 1000 ms): window 250 ms, second write after exactly 250 ms is accepted", async () => {
    const c = { windowMs: 250, ops: [{ key: "a", dt: 0 }, { key: "a", dt: 250 }] }
    expect(await rateFollowsRule(makeFsBucket, c)).toBe(true)
    expect(await rateFollowsRule(await hardCodedWindow(), c)).toBe(false)
    // The old example's own values cannot tell the mutant apart:
    expect(await rateFollowsRule(await hardCodedWindow(), { windowMs: 1000, ops: [{ key: "a", dt: 0 }, { key: "a", dt: 999 }, { key: "a", dt: 1 }] })).toBe(true)
  })

  it("counterexample 2 (mutant: window anchored at creation): writes at 0, 1000, 1500 with a 1000 ms window — the third is 429", async () => {
    const c = { windowMs: 1000, ops: [{ key: "a", dt: 0 }, { key: "a", dt: 1000 }, { key: "a", dt: 500 }] }
    expect(rateModel(c.windowMs, c.ops)).toEqual(["ok", "ok", "429"])
    expect(await rateFollowsRule(makeFsBucket, c)).toBe(true)
    expect(await rateFollowsRule(await anchoredAtCreation(), c)).toBe(false)
  })

  it("negation 1: the law is refuted for the hard-coded-window mutant", async () => {
    const m = await hardCodedWindow()
    expect(await mutantKilledAsync(rateCase, (c) => rateFollowsRule(m, c), 60)).toBe(true)
  }, 120_000)

  it("negation 2: the law is refuted for the anchored-at-creation mutant", async () => {
    const m = await anchoredAtCreation()
    expect(await mutantKilledAsync(rateCase, (c) => rateFollowsRule(m, c), 60)).toBe(true)
  }, 120_000)

  it("law: of N concurrent creates exactly one wins; N concurrent CAS writes on one version: exactly one wins", async () => {
    for (const n of [2, 5, 16]) {
      const b = makeFsBucket(await fresh(), { rateLimitMs: 0 })
      const creates = await Promise.all(Array.from({ length: n }, (_, i) => run(b.objectStore.putIfNoneMatch("k", `c${i}`))))
      expect(creates.filter(Result.isSuccess).length, `creates, n=${n}`).toBe(1)
      const winner = Result.getOrThrow(creates.find(Result.isSuccess)!)
      const cas = await Promise.all(Array.from({ length: n }, (_, i) => run(b.objectStore.putIfMatch("k", winner, `w${i}`))))
      expect(cas.filter(Result.isSuccess).length, `CAS, n=${n}`).toBe(1)
      const losers = cas.filter(Result.isFailure).map((l) => l.failure._tag)
      expect(new Set(losers)).toEqual(new Set(n > 1 ? ["PreconditionFailed"] : []))
    }
  })

  it("list follows cursors in key order and reports unquoted ETags; get/text read the body", async () => {
    const b = makeFsBucket(await fresh(), { rateLimitMs: 0, listPageSize: 2 })
    for (const k of ["p/c", "p/a", "q/x", "p/b"]) await b.putIfNoneMatchBytes(k, new TextEncoder().encode(k))
    const p1 = await b.list({ prefix: "p/" })
    expect(p1.objects.map((o) => o.key)).toEqual(["p/a", "p/b"])
    expect(p1.truncated).toBe(true)
    const p2 = await b.list({ prefix: "p/", cursor: p1.cursor! })
    expect(p2.objects.map((o) => o.key)).toEqual(["p/c"])
    expect(p2.truncated).toBe(false)
    expect(p1.objects[0]!.etag).not.toMatch(/"/)
    const o = await b.get("q/x")
    expect(await o!.text()).toBe("q/x")
    expect(await b.get("missing")).toBeNull()
  })
})
