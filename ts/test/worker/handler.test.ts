/**
 * The Worker's read-only state API (`src/worker/handler.ts`) against objects
 * written by the real lock (`makeCobuildLock`) and cache (`publish`) code.
 *
 * Main law (contract): for every set of lock operations across several
 * contexts (including contexts that are string prefixes of each other or
 * contain `/` and `%`), `GET /api/locks?context=c` returns exactly the locks
 * written in context `c`, each with the status, owner and ETag stored in R2.
 * The oracle is computed from the operations alone, not from the handler.
 */
import { Effect, Redacted } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, lawAsync, mutantKilledAsync } from "../harness.js"
import { makeMemoryBlobStore } from "../../src/cache/blobStore.js"
import { digestBytes } from "../../src/cache/digest.js"
import { publish } from "../../src/cache/publish.js"
import { makeScope } from "../../src/cache/scope.js"
import { makeCobuildLock, makeMemoryStore, type MemoryStore } from "../../src/index.js"
import { type CacheResponse, handle, type HandlerConfig, listAll, type LocksResponse, timingSafeEqual } from "../../src/worker/handler.js"
import type { R2BucketLike, R2ObjectSummary } from "../../src/worker/r2Bucket.js"
import worker from "../../src/worker/index.js"
import { makeFakeBucket } from "./fakeBucket.js"
import { CacheKey, JobId } from "../../src/ids.js"

announce("test/worker/handler.test.ts")

const TOKEN = "s3cret-token"
const cfg = (now: number, extra: Partial<HandlerConfig> = {}): HandlerConfig => ({ scope: "trusted", token: Redacted.make(TOKEN), now: () => now, ...extra })
const get = (path: string, token: string | null = TOKEN, method = "GET") =>
  new Request(`https://cobuilds.example${path}`, {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` }
  })

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

type Action = "building" | "succeeded" | "failed" | "abandoned"
interface Op {
  readonly context: string
  readonly cacheKey: string
  readonly owner: string
  readonly action: Action
}

/** Contexts that are string prefixes of one another or need escaping. */
const CONTEXTS = ["build-1", "build-10", "build-1/x", "a%2Fb", "a/b"]
const KEYS = ["pkg-a", "pkg-b", "x/y", "%", "lock"]

/** Write every op with the real lock code (store without rate limit, clock at 0). */
const writeOps = (store: MemoryStore, ops: ReadonlyArray<Op>) =>
  run(
    Effect.forEach(ops, (op) =>
      Effect.gen(function* () {
        const lock = makeCobuildLock(store, { scope: "trusted", context: op.context, jobId: JobId(op.owner) })
        const s = yield* lock.acquire(CacheKey(op.cacheKey))
        if (s.state !== "obtained") return yield* Effect.die(new Error(`expected obtained, got ${s.state}`))
        if (op.action === "succeeded") yield* lock.markCompleted(s.lock, { status: "succeeded", buildCacheKey: `bk-${op.cacheKey}` })
        if (op.action === "failed") yield* lock.markCompleted(s.lock, { status: "failed", logKey: null })
        if (op.action === "abandoned") yield* lock.abandon(s.lock)
        return lock.objectKey(CacheKey(op.cacheKey))
      })
    )
  )

const arbOps = fc
  .uniqueArray(
    fc.record({
      context: fc.constantFrom(...CONTEXTS),
      cacheKey: fc.constantFrom(...KEYS),
      owner: fc.constantFrom("primary", "extra1", "extra2"),
      action: fc.constantFrom<Action>("building", "succeeded", "failed", "abandoned")
    }),
    { maxLength: 14, selector: (o) => `${o.context}\u0000${o.cacheKey}` }
  )
  .chain((ops) => fc.record({ ops: fc.constant(ops), query: fc.constantFrom(...CONTEXTS), now: fc.constantFrom(10_000, 30_000, 30_001, 40_000), pageSize: fc.integer({ min: 1, max: 4 }) }))

describe("GET /api/locks", () => {
  it("returns exactly the locks of the queried context with the stored status, owner and ETag", async () => {
    await lawAsync(
      "locks endpoint = locks written in that context",
      arbOps,
      async ({ ops, query, now, pageSize }) => {
        const store = makeMemoryStore(0)
        const objectKeys = await writeOps(store, ops)
        const bucket = makeFakeBucket({ locks: store }, pageSize)
        const res = await handle(get(`/api/locks?context=${encodeURIComponent(query)}`), bucket, cfg(now))
        expect(res.status).toBe(200)
        const body = (await res.json()) as LocksResponse
        expect(body.truncated).toBe(false)
        const expected = ops
          .map((op, i) => ({ op, key: objectKeys[i]! }))
          .filter(({ op }) => op.context === query)
          .map(({ op, key }) => ({
            key,
            cacheKey: op.cacheKey,
            owner: op.owner,
            status: op.action === "abandoned" ? "building" : op.action,
            etag: store.peek(key)!.etag,
            // Leases are 30 s from time 0; an abandoned lock expires immediately.
            leaseExpired: op.action === "abandoned" || (op.action === "building" && now > 30_000),
            buildCacheKey: op.action === "succeeded" ? `bk-${op.cacheKey}` : null
          }))
          .sort((a, b) => (a.key < b.key ? -1 : 1))
        const actual = body.locks
          .map((l) => {
            if ("error" in l) throw new Error(`unexpected error entry ${l.key}`)
            const { key, cacheKey, owner, status, etag, leaseExpired, buildCacheKey } = l
            return { key, cacheKey, owner, status, etag, leaseExpired, buildCacheKey }
          })
          .sort((a, b) => (a.key < b.key ? -1 : 1))
        expect(actual).toEqual(expected)
        const otherContexts = ops.some((o) => o.context !== query && query.startsWith(o.context))
        return { valid: expected.length > 0, boundary: otherContexts || expected.length === 0 }
      },
      120,
      { domain: "≤14 lock ops over 5 contexts (string-prefix and escaped names) × 5 keys, page size 1–4", minValidFraction: 0.5, minBoundary: 10 }
    )
  })

  it("regression (recorded): 7 locks in pages of 2 → 4 list calls; maxObjects 3 → 3 locks, truncated", async () => {
    const store = makeMemoryStore(0)
    const ops: Array<Op> = Array.from({ length: 7 }, (_, i) => ({ context: "ctx", cacheKey: `k${i}`, owner: "primary", action: "building" }))
    await writeOps(store, ops)
    const bucket = makeFakeBucket({ locks: store }, 2)
    const full = (await (await handle(get("/api/locks?context=ctx"), bucket, cfg(0))).json()) as LocksResponse
    expect(full.locks.length).toBe(7)
    expect(full.truncated).toBe(false)
    expect(bucket.listCalls()).toBe(4) // pages of 2, 2, 2, 1
    const capped = (await (await handle(get("/api/locks?context=ctx"), bucket, cfg(0, { maxObjects: 3 }))).json()) as LocksResponse
    expect(capped.locks.length).toBe(3)
    expect(capped.truncated).toBe(true)
  })

  it("reports a malformed body at a lock path instead of dropping it, and ignores non-lock keys", async () => {
    const store = makeMemoryStore(0)
    await writeOps(store, [{ context: "ctx", cacheKey: "good", owner: "primary", action: "succeeded" }])
    const bucket = makeFakeBucket({ locks: store })
    bucket.extra.set("v1/trusted/cobuild/ctx/bad/lock/", "{not json")
    bucket.extra.set("v1/trusted/cobuild/ctx/bad/notes/", "{}")
    const body = (await (await handle(get("/api/locks?context=ctx"), bucket, cfg(0))).json()) as LocksResponse
    expect(body.locks).toEqual([
      { key: "v1/trusted/cobuild/ctx/bad/lock/", error: "body is not a cobuild lock manifest" },
      expect.objectContaining({ key: "v1/trusted/cobuild/ctx/good/lock/", status: "succeeded", buildCacheKey: "bk-good" })
    ])
  })

  it("regression: the proposal's prefix `v1/lock/` matches none of the keys the lock writes", async () => {
    const store = makeMemoryStore(0)
    const [key] = await writeOps(store, [{ context: "demo-ctx", cacheKey: "mathlib-import", owner: "primary", action: "building" }])
    expect(key).toBe("v1/trusted/cobuild/demo-ctx/mathlib-import/lock/")
    expect(store.keys().filter((k) => k.startsWith("v1/lock/"))).toEqual([])
  })
})

/*
 * Paging as a rule (replaces the single 7-objects / page-2 / cap-3 example):
 * for n objects under a prefix, page size p ≥ 1 and cap M ≥ 1, `listAll`
 * returns the first min(n, M) keys in key order, reports `truncated` iff
 * n > M, and makes exactly max(1, ⌈n / p⌉) list calls when n ≤ M (every
 * page, no extra) and ⌈(M + 1) / p⌉ when n > M (it stops at the first page
 * that proves there is more).
 */
const pagedBucket = (n: number, p: number, noise: number) => {
  let calls = 0
  const keys = [...Array.from({ length: n }, (_, i) => `pre/${String(i).padStart(5, "0")}`), ...Array.from({ length: noise }, (_, i) => `other/${i}`)].sort()
  const bucket: R2BucketLike = {
    list: async ({ prefix, cursor }) => {
      calls++
      const matching = keys.filter((k) => k.startsWith(prefix))
      const start = cursor === undefined ? 0 : Number(cursor)
      const objects = matching.slice(start, start + p).map((key) => ({ key, size: 1, etag: "e" }))
      return start + p < matching.length ? { objects, truncated: true, cursor: String(start + p) } : { objects, truncated: false }
    },
    get: async () => null
  }
  return { bucket, calls: () => calls }
}
const pagingCase = fc.record({ n: fc.integer({ min: 0, max: 60 }), p: fc.integer({ min: 1, max: 12 }), m: fc.integer({ min: 1, max: 70 }), noise: fc.integer({ min: 0, max: 5 }) })
type ListAll = (b: R2BucketLike, prefix: string, max: number) => Promise<{ objects: Array<R2ObjectSummary>; truncated: boolean }>
const pagingFollowsRule = async (impl: ListAll, c: { n: number; p: number; m: number; noise: number }): Promise<boolean> => {
  const { bucket, calls } = pagedBucket(c.n, c.p, c.noise)
  const r = await impl(bucket, "pre/", c.m)
  const want = Array.from({ length: Math.min(c.n, c.m) }, (_, i) => `pre/${String(i).padStart(5, "0")}`)
  const wantCalls = c.n <= c.m ? Math.max(1, Math.ceil(c.n / c.p)) : Math.ceil((c.m + 1) / c.p)
  return JSON.stringify(r.objects.map((o) => o.key)) === JSON.stringify(want) && r.truncated === c.n > c.m && calls() === wantCalls
}
/** Mutant 1: reads only the first page (ignores `truncated` / `cursor`). */
const firstPageOnly: ListAll = async (b, prefix, max) => {
  const page = await b.list({ prefix })
  return { objects: page.objects.slice(0, max), truncated: page.objects.length > max }
}
/** Mutant 2: reports truncation as soon as the cap is reached (off by one: n = M is not truncated). */
const truncatedAtCap: ListAll = async (b, prefix, max) => {
  const r = await listAll(b, prefix, max)
  return { ...r, truncated: r.objects.length >= max }
}

describe("listing: cursors and the object cap", () => {
  it("law: first min(n, M) keys, truncated ⇔ n > M, exactly the pages needed", async () => {
    await lawAsync(
      "listAll paging",
      pagingCase,
      async (c) => {
        expect(await pagingFollowsRule(listAll, c), JSON.stringify(c)).toBe(true)
        return { valid: c.n > c.p, boundary: c.n === c.m || c.n === c.m + 1 || c.n % c.p === 0 || c.n === 0 }
      },
      300,
      { domain: "n 0–60 objects (+0–5 under other prefixes), page size 1–12, cap 1–70", minValidFraction: 0.6, minBoundary: 30 }
    )
  })

  it("counterexample 1 (mutant: first page only): 7 objects in pages of 2", async () => {
    const c = { n: 7, p: 2, m: 5000, noise: 0 }
    expect(await pagingFollowsRule(listAll, c)).toBe(true)
    expect(await pagingFollowsRule(firstPageOnly, c)).toBe(false)
  })

  it("counterexample 2 (mutant: truncated at the cap): exactly M objects is not truncated", async () => {
    const c = { n: 3, p: 2, m: 3, noise: 1 }
    expect(await pagingFollowsRule(listAll, c)).toBe(true)
    expect(await pagingFollowsRule(truncatedAtCap, c)).toBe(false)
  })

  it("negation 1: the law is refuted for the first-page-only mutant", async () => {
    expect(await mutantKilledAsync(pagingCase, (c) => pagingFollowsRule(firstPageOnly, c), 200)).toBe(true)
  })

  it("negation 2: the law is refuted for the truncated-at-cap mutant", async () => {
    expect(await mutantKilledAsync(pagingCase.map((c) => ({ ...c, m: Math.max(1, c.n) })), (c) => pagingFollowsRule(truncatedAtCap, c), 200)).toBe(true)
  })
})

describe("GET /api/cache", () => {
  it("counts blobs and manifests written by the real publish, with exact byte totals", async () => {
    const blobs = makeMemoryBlobStore()
    const utf8 = (s: string) => new TextEncoder().encode(s)
    const job = { scope: makeScope("trusted") }
    const files = [
      { path: "dist/a.js", bytes: utf8("console.log(1)") },
      { path: "dist/b.js", bytes: utf8("console.log(2)") },
      { path: "dist/copy-of-a.js", bytes: utf8("console.log(1)") } // same content: one blob
    ]
    await run(publish({ store: blobs, job, lookup: digestBytes(utf8("op-1")), files, buildMs: 10, now: 0 }))
    await run(publish({ store: blobs, job, lookup: digestBytes(utf8("op-2")), files: files.slice(0, 1), buildMs: 10, now: 0 }))
    const bucket = makeFakeBucket({ blobs }, 1)
    const body = (await (await handle(get("/api/cache"), bucket, cfg(0))).json()) as CacheResponse
    const blobKeys = blobs.writes.filter((k) => k.startsWith("v1/trusted/b/"))
    const manifestKeys = blobs.writes.filter((k) => k.startsWith("v1/trusted/m/"))
    expect(blobKeys.length).toBe(2) // deduplicated by content
    expect(manifestKeys.length).toBe(2)
    expect(body).toEqual({
      scope: "trusted",
      blobCount: 2,
      blobBytes: blobKeys.reduce((s, k) => s + blobs.peek(k)!.length, 0),
      manifestCount: 2,
      manifestBytes: manifestKeys.reduce((s, k) => s + blobs.peek(k)!.length, 0),
      truncated: false
    })
    expect(body.blobBytes).toBe(28)
  })
})

describe("request handling", () => {
  const bucket = makeFakeBucket({ locks: makeMemoryStore(0) })
  it("requires the bearer token", async () => {
    expect((await handle(get("/api/cache", null), bucket, cfg(0))).status).toBe(401)
    expect((await handle(get("/api/cache", "wrong"), bucket, cfg(0))).status).toBe(401)
    expect((await handle(get("/api/cache", `${TOKEN}x`), bucket, cfg(0))).status).toBe(401)
    expect((await handle(get("/api/cache"), bucket, cfg(0))).status).toBe(200)
  })
  it("is read-only and has a fixed route set", async () => {
    expect((await handle(get("/api/cache", TOKEN, "POST"), bucket, cfg(0))).status).toBe(405)
    expect((await handle(get("/api/cache", TOKEN, "DELETE"), bucket, cfg(0))).status).toBe(405)
    expect((await handle(get("/api/other"), bucket, cfg(0))).status).toBe(404)
    expect((await handle(get("/api/locks"), bucket, cfg(0))).status).toBe(400)
  })
  it("refuses to serve with a misconfigured scope or an empty token", async () => {
    expect((await handle(get("/api/cache"), bucket, cfg(0, { scope: "Not A Scope" }))).status).toBe(500)
    expect((await handle(get("/api/cache", ""), bucket, cfg(0, { token: Redacted.make("") }))).status).toBe(500)
  })
  it("timingSafeEqual agrees with ===", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => timingSafeEqual(a, b) === (a === b)))
    fc.assert(fc.property(fc.string(), (a) => timingSafeEqual(a, a)))
  })
  it("the Worker entry point wires the binding, secret and scope", async () => {
    const store = makeMemoryStore(0)
    await writeOps(store, [{ context: "ctx", cacheKey: "k", owner: "primary", action: "building" }])
    const env = { CACHE_BUCKET: makeFakeBucket({ locks: store }), API_TOKEN: TOKEN, COBUILD_SCOPE: "trusted" }
    const res = await worker.fetch(get("/api/locks?context=ctx"), env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as LocksResponse).locks).toHaveLength(1)
    expect((await worker.fetch(get("/api/locks?context=ctx"), { ...env, API_TOKEN: "" })).status).toBe(500)
  })
})
