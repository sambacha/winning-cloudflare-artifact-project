/**
 * Laws for publishing and restoring (third test pass, `docs/test-review.md`
 * §TS-PR). Each hand-written scenario of `publishRestore.test.ts` is
 * generalised into the rule it illustrated:
 *
 * | Scenario (one input) | Law (all inputs) |
 * |---|---|
 * | publish then restore three files | **round trip**: restore ∘ publish = id on any valid file set, in memory and on a real filesystem; the manifest is the last write |
 * | second publish of the same lookup | first writer wins for any two file sets |
 * | three unsafe path lists | every file set containing a path the independent oracle calls unsafe is rejected before any write |
 * | deadline 1000 / 999 ms | hit ⇔ `max(floor, buildMs) ≥ chunks · delay` for random sizes and delays, probed at the threshold ± 1 |
 * | breaker with N = 3, C = 2 | for every N, C: N unhealthy restores open it, C + 1 requests skip the store, the probe closes it |
 *
 * The filesystem round trip found a defect (now fixed): `publish` accepted a
 * file set in which one path is a directory of another (`a` and `a/b`). Such
 * an entry is create-only and permanent, yet no filesystem restore can apply
 * it (every job misses with `staging_error`), while in-memory staging reported
 * a hit. `publish` and the manifest decoder now reject such sets; the law
 * "published ⇔ restorable everywhere" below is the permanent regression.
 */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Duration, Effect, Fiber } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { type BlobStore, makeMemoryBlobStore } from "../../src/cache/blobStore.js"
import { makeCacheClient } from "../../src/cache/client.js"
import { type Digest, digestBytes } from "../../src/cache/digest.js"
import { manifestKey } from "../../src/cache/lookupKey.js"
import { encodeManifest, makeManifest } from "../../src/cache/manifest.js"
import { InvalidOutput, type OutputFile, publish } from "../../src/cache/publish.js"
import { restore } from "../../src/cache/restore.js"
import { type Job, makeScope, type TrustPolicy } from "../../src/cache/scope.js"
import { makeFsStaging, makeMemoryStaging } from "../../src/cache/staging.js"
import { announce, lawAsync, mutantKilled } from "../harness.js"

announce("test/cache/publishLaws.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

const trusted = makeScope("trusted")
const policy: TrustPolicy = { trusted: [trusted] }
const job: Job = { scope: trusted }
const LOOKUP: Digest = digestBytes(new TextEncoder().encode("lookup-of-package-L"))

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
const treeOf = (files: ReadonlyArray<OutputFile>) => Object.fromEntries(files.map((f) => [f.path, hex(f.bytes)]))

/** Independent oracle for safe output paths, written from D-7 (not from `isSafeRelativePath`). */
const safePathOracle = (p: string): boolean =>
  p.length >= 1 && p.length <= 4096 && !p.startsWith("/") && !/[\\\u0000]/.test(p) && p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..")

/** Path segments from a small alphabet, so that shared directories and prefix collisions are common (H6). */
const segment = fc.constantFrom("a", "b", "lib", "x.js", "é")
const safePath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((xs) => xs.join("/"))
/** File sets with distinct paths, none of which is a directory of another (a file and a directory cannot share a name). */
const filesArb = fc
  .uniqueArray(fc.record({ path: safePath, bytes: fc.oneof(fc.uint8Array({ maxLength: 200 }), fc.constant(new Uint8Array(0))) }), {
    minLength: 1,
    maxLength: 6,
    selector: (f) => f.path
  })
  .filter((fs_) => !fs_.some((f) => fs_.some((g) => g.path.startsWith(f.path + "/"))))

describe("round trip (D-3, D-7)", () => {
  it("law: restore ∘ publish = id for any valid file set (memory staging); the manifest is the last write; a second publish keeps the first", async () => {
    await lawAsync(
      "publish/restore round trip",
      fc.tuple(filesArb, filesArb, fc.integer({ min: 1, max: 50 })),
      async ([files, other, chunk]) =>
        run(
          Effect.gen(function* () {
            const store = makeMemoryBlobStore({ chunkSize: chunk })
            expect(yield* publish({ store, job, lookup: LOOKUP, files, buildMs: 60_000, now: 0 })).toBe("published")
            expect(store.writes.at(-1)).toBe(manifestKey(trusted, LOOKUP))
            const staging = makeMemoryStaging()
            const r = yield* restore({ store, policy, job, lookup: LOOKUP, staging })
            expect(r.outcome).toBe("hit")
            const committed = Object.fromEntries([...staging.committed()!].map(([p, b]) => [p, hex(b)]))
            expect(committed).toEqual(treeOf(files))
            // First writer wins: a second publish of the same lookup is "exists" and changes nothing.
            expect(yield* publish({ store, job, lookup: LOOKUP, files: other, buildMs: 1, now: 1 })).toBe("exists")
            const again = makeMemoryStaging()
            yield* restore({ store, policy, job, lookup: LOOKUP, staging: again })
            expect(Object.fromEntries([...again.committed()!].map(([p, b]) => [p, hex(b)]))).toEqual(treeOf(files))
            const sizes = files.map((f) => f.bytes.length)
            return { valid: files.length >= 2, boundary: sizes.some((n) => n === 0 || n % chunk === 0) }
          })
        ),
      150,
      { domain: "1–6 files, paths of 1–3 segments over {a,b,lib,x.js,é}, ≤200 bytes or empty; chunk size 1–50", minValidFraction: 0.5, minBoundary: 30 }
    )
  }, 60_000)

  it("law: the same round trip on a real filesystem, with nested directories and empty files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-law-"))
    try {
      let i = 0
      await lawAsync(
        "filesystem round trip",
        filesArb,
        async (files) => {
          const dest = path.join(root, `d${i++}`)
          await fs.mkdir(dest)
          await fs.writeFile(path.join(dest, "stale.txt"), "old")
          const store = makeMemoryBlobStore({ chunkSize: 32 })
          await run(publish({ store, job, lookup: LOOKUP, files, buildMs: 1, now: 0 }))
          const r = await run(restore({ store, policy, job, lookup: LOOKUP, staging: makeFsStaging(dest) }))
          expect(r.outcome).toBe("hit")
          for (const f of files) expect(hex(await fs.readFile(path.join(dest, f.path)))).toBe(hex(f.bytes))
          await expect(fs.access(path.join(dest, "stale.txt"))).rejects.toThrow()
          return { valid: files.some((f) => f.path.includes("/")), boundary: files.some((f) => f.bytes.length === 0) }
        },
        40,
        { domain: "as above, restored into a fresh directory holding a stale file", minValidFraction: 0.5, minBoundary: 3 }
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("published ⇔ restorable (regression law for the file/directory clash)", () => {
  /** File sets *without* the tree-shape filter: clashes such as `a` and `a/b` are common. */
  const freeFiles = fc.uniqueArray(fc.record({ path: safePath, bytes: fc.uint8Array({ maxLength: 20 }) }), { minLength: 1, maxLength: 6, selector: (f) => f.path })
  /**
   * Boundary generator (H6): a free file set plus a file directly under one of
   * its paths (`p` and `p/a` or `p/b`), the smallest possible clash. Without it
   * the minimal clashes were 5–14 of 100 cases, too close to the threshold.
   */
  const planted = fc
    .tuple(freeFiles, fc.nat(), fc.constantFrom("a", "b"), fc.uint8Array({ maxLength: 20 }))
    .map(([files, i, seg, bytes]) => {
      const child = `${files[i % files.length]!.path}/${seg}`
      return files.some((f) => f.path === child) ? files : [...files, { path: child, bytes }]
    })
  const anyFiles = fc.oneof(freeFiles, planted)
  /** Independent oracle: some path is a proper directory prefix of another. */
  const clashes = (files: ReadonlyArray<OutputFile>) => files.some((f) => files.some((g) => g.path.startsWith(f.path + "/")))

  it("law: publish accepts a file set iff it has no file/directory clash, and then both stagings restore it; a clashing manifest written out of band is a miss for both", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-clash-"))
    try {
      let i = 0
      await lawAsync(
        "published iff restorable",
        anyFiles,
        async (files) => {
          const store = makeMemoryBlobStore()
          const e = await run(Effect.result(publish({ store, job, lookup: LOOKUP, files, buildMs: 1, now: 0 })))
          const dest = path.join(root, `d${i++}`)
          if (clashes(files)) {
            expect(e._tag === "Failure" && e.failure).toBeInstanceOf(InvalidOutput)
            expect(store.writes).toEqual([])
            // A writer that bypasses publish (out of band): both stagings must agree it is a miss.
            const m = makeManifest({ lookup: LOOKUP, buildMs: 1, createdAt: 0, files: files.map((f) => ({ path: f.path, blob: digestBytes(f.bytes), size: f.bytes.length })) })
            store.forcePut(manifestKey(trusted, LOOKUP), encodeManifest(m))
            for (const staging of [makeMemoryStaging(), makeFsStaging(dest)]) {
              expect(await run(restore({ store, policy, job, lookup: LOOKUP, staging }))).toMatchObject({ outcome: "miss", reason: "manifest_invalid" })
            }
          } else {
            expect(e).toMatchObject({ _tag: "Success", success: "published" })
            for (const staging of [makeMemoryStaging(), makeFsStaging(dest)]) {
              expect((await run(restore({ store, policy, job, lookup: LOOKUP, staging }))).outcome).toBe("hit")
            }
          }
          return { valid: clashes(files), boundary: files.some((f) => files.some((g) => g.path === f.path + "/a" || g.path === f.path + "/b")) }
        },
        100,
        { domain: "1–6 distinct paths of 1–3 segments over {a,b,lib,x.js,é}, ≤20 bytes each, no tree-shape filter; half of the sets get a planted child p/a or p/b", minValidFraction: 0.4, minBoundary: 25 }
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("unsafe paths (D-7)", () => {
  const unsafeSegment = fc.constantFrom("", ".", "..", "a\\b", "nul\u0000")
  const unsafePath = fc.oneof(
    fc.tuple(fc.array(segment, { maxLength: 2 }), unsafeSegment, fc.array(segment, { maxLength: 2 })).map(([a, u, b]) => [...a, u, ...b].join("/")),
    safePath.map((p) => "/" + p),
    fc.constant("")
  )

  it("law: any file set with a path the oracle calls unsafe is rejected before the first write", async () => {
    await lawAsync(
      "unsafe paths rejected",
      fc.tuple(filesArb, unsafePath, fc.nat()),
      async ([files, bad, at]) => {
        const store = makeMemoryBlobStore()
        const withBad = [...files.slice(0, at % (files.length + 1)), { path: bad, bytes: new Uint8Array([1]) }, ...files.slice(at % (files.length + 1))]
        const unsafe = !safePathOracle(bad)
        const e = await run(Effect.result(publish({ store, job, lookup: LOOKUP, files: withBad, buildMs: 1, now: 0 })))
        if (unsafe) {
          expect(e._tag).toBe("Failure")
          expect(e._tag === "Failure" && e.failure).toBeInstanceOf(InvalidOutput)
          expect(store.writes).toEqual([])
        }
        return { valid: unsafe, boundary: bad === "" || bad.endsWith("/..") || bad.startsWith("/") }
      },
      300,
      { domain: "valid file sets with one path containing an empty, '.', '..', backslash or NUL segment, or absolute, inserted anywhere", minValidFraction: 0.9, minBoundary: 30 }
    )
  }, 60_000)

  it("the law kills a validator that only rejects '..'", () => {
    const naive = (p: string) => !p.split("/").includes("..")
    expect(mutantKilled(fc.oneof(safePath, fc.constantFrom("/abs", "a//b", "./a", "a\\b")), (p) => naive(p) === safePathOracle(p), 500)).toBe(true)
  })
})

describe("restore deadline (D-11)", () => {
  it("law: hit ⇔ max(floor, buildMs) ≥ chunks · delay, probed at the threshold and one millisecond either side", async () => {
    await lawAsync(
      "deadline threshold",
      fc.record({ chunks: fc.integer({ min: 1, max: 20 }), delay: fc.integer({ min: 1, max: 300 }), off: fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -5_000, max: 5_000 })) }),
      async ({ chunks, delay, off }) =>
        run(
          Effect.gen(function* () {
            const need = chunks * delay
            const buildMs = Math.max(1, need + off)
            const store = makeMemoryBlobStore({ chunkSize: 10, faults: { chunkDelayMs: (k) => (k.includes("/b/") ? delay : 0) } })
            yield* publish({ store, job, lookup: LOOKUP, files: [{ path: "a", bytes: new Uint8Array(10 * chunks) }], buildMs, now: 0 })
            const staging = makeMemoryStaging()
            const fiber = yield* Effect.forkChild(restore({ store, policy, job, lookup: LOOKUP, staging, deadline: { floor: Duration.millis(250), lookup: Duration.seconds(2) } }))
            yield* TestClock.adjust(need + 10_000)
            const r = yield* Fiber.join(fiber)
            const expectHit = Math.max(250, buildMs) >= need
            expect(r.outcome).toBe(expectHit ? "hit" : "miss")
            if (!expectHit) {
              expect(r).toMatchObject({ reason: "restore_deadline" })
              expect(staging.committed()).toBeUndefined()
            }
            return { valid: true, boundary: Math.abs(Math.max(250, buildMs) - need) <= 1 }
          })
        ),
      150,
      { domain: "1–20 chunks × 1–300 ms; buildMs = chunks·delay + {−1,0,1} ∪ [−5000,5000]; floor 250 ms", minValidFraction: 1, minBoundary: 20 }
    )
  }, 60_000)
})

describe("circuit breaker in the client (D-12)", () => {
  it("law: for every N and C, N unhealthy restores open it, the next C + 1 requests skip the store, and a healthy probe closes it", async () => {
    await lawAsync(
      "client breaker",
      fc.record({ threshold: fc.integer({ min: 1, max: 5 }), coolDown: fc.integer({ min: 0, max: 4 }) }),
      async (cfg) =>
        run(
          Effect.gen(function* () {
            let healthy = false
            let reads = 0
            const good = makeMemoryBlobStore()
            yield* publish({ store: good, job, lookup: LOOKUP, files: [{ path: "a", bytes: new Uint8Array([7]) }], buildMs: 10_000, now: 0 })
            const store: BlobStore = {
              putIfNoneMatch: good.putIfNoneMatch,
              getStream: (k) => {
                reads++
                return healthy ? good.getStream(k) : Effect.fail({ _tag: "StoreFailure", key: k, cause: "down" } as never)
              }
            }
            const client = yield* makeCacheClient({ store, policy, job, breaker: cfg })
            const step = Effect.map(client.restore(LOOKUP, makeMemoryStaging()), (r) => (r.outcome === "hit" ? "hit" : r.reason))
            for (let i = 0; i < cfg.threshold - 1; i++) {
              expect(yield* step).toBe("store_error")
              expect((yield* client.breakerState).tag).toBe("closed")
            }
            expect(yield* step).toBe("store_error")
            expect((yield* client.breakerState).tag).toBe("open")
            healthy = true
            const before = reads
            for (let i = 0; i < cfg.coolDown + 1; i++) expect(yield* step).toBe("breaker_open")
            expect(reads).toBe(before)
            expect(yield* step).toBe("hit")
            expect((yield* client.breakerState).tag).toBe("closed")
            return { valid: true, boundary: cfg.threshold === 1 || cfg.coolDown === 0 }
          })
        ),
      60,
      { domain: "N ∈ [1,5], C ∈ [0,4]", minValidFraction: 1, minBoundary: 5 }
    )
  }, 60_000)
})
