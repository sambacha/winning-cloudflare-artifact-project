/**
 * Status after the third test pass (`docs/test-review.md` §TS-PR): the
 * hand-written scenarios of this file are labelled regressions; the laws
 * (round trip in memory and on disk, published ⇔ restorable, unsafe-path
 * oracle, deadline threshold, client breaker) are in `publishLaws.test.ts`.
 * The crash-prefix and tampering properties below remain primary tests.
 *
 * Publishing and restoring: D-3 (blobs then manifest), D-7 (client-side
 * streaming verification, any failure is a miss, staging + atomic swap),
 * D-1 (scopes stop poisoning), D-11 (deadline), D-12 (breaker in the client).
 *
 * Business assertions checked here (from `docs/cache-path-review.md` §6):
 * - BA-1  A job never restores bytes other than the ones the manifest of a
 *         readable scope names (property over arbitrary tampering).
 * - BA-2  After a crash at any point of a publish, readers see the complete
 *         entry or no entry (property over every crash prefix; the
 *         manifest-first mutant fails it).
 * - BA-3  An untrusted job cannot make a trusted job restore its output.
 * - BA-4  On a miss the destination is untouched; on a hit it is exactly the
 *         entry (filesystem staging, real directories).
 * - BA-5  A slow cache costs at most the deadline before the job rebuilds.
 * - BA-6  An unhealthy cache is skipped after N failures and re-probed.
 */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Duration, Effect, Fiber } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, params } from "../harness.js"
import { makeMemoryBlobStore, type BlobStore, type MemoryBlobStore } from "../../src/cache/blobStore.js"
import { makeCacheClient } from "../../src/cache/client.js"
import { type Digest, digestBytes, formatDigest } from "../../src/cache/digest.js"
import { blobKey, manifestKey } from "../../src/cache/lookupKey.js"
import { encodeManifest, makeManifest } from "../../src/cache/manifest.js"
import { InvalidOutput, publish, type OutputFile } from "../../src/cache/publish.js"
import { restore, type RestoreResult } from "../../src/cache/restore.js"
import { makeScope, type Job, type TrustPolicy } from "../../src/cache/scope.js"
import { makeFsStaging, makeMemoryStaging } from "../../src/cache/staging.js"

announce("test/cache/publishRestore.test.ts")

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestClock.layer())))

const trusted = makeScope("trusted")
const fork = makeScope("fork-pr")
const policy: TrustPolicy = { trusted: [trusted] }
const trustedJob: Job = { scope: trusted }
const forkJob: Job = { scope: fork }
const utf8 = (s: string) => new TextEncoder().encode(s)
const LOOKUP: Digest = digestBytes(utf8("lookup-of-package-A"))

const filesArb = fc.uniqueArray(
  fc.record({
    path: fc.constantFrom("a.js", "lib/b.js", "lib/c.d.ts", "dist/x/y.map", "README"),
    bytes: fc.uint8Array({ maxLength: 300 })
  }),
  { minLength: 1, maxLength: 5, selector: (f) => f.path }
)

const treeOf = (files: ReadonlyArray<OutputFile>) =>
  Object.fromEntries(files.map((f) => [f.path, Buffer.from(f.bytes).toString("hex")]))
const committedTree = (m: ReadonlyMap<string, Uint8Array> | undefined) =>
  m === undefined ? undefined : Object.fromEntries([...m].map(([p, b]) => [p, Buffer.from(b).toString("hex")]))

const restoreInto = (store: BlobStore, job: Job, staging = makeMemoryStaging()) =>
  Effect.map(restore({ store, policy, job, lookup: LOOKUP, staging }), (r) => ({ r, staging }))

describe("D-3 / D-7 round trip", () => {
  it("publish then restore gives exactly the published files", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryBlobStore({ chunkSize: 7 })
        const files = [
          { path: "a.js", bytes: utf8("console.log(1)") },
          { path: "lib/b.js", bytes: utf8("x".repeat(100)) },
          { path: "empty", bytes: new Uint8Array(0) }
        ]
        expect(yield* publish({ store, job: trustedJob, lookup: LOOKUP, files, buildMs: 60_000, now: 0 })).toBe("published")
        const { r, staging } = yield* restoreInto(store, trustedJob)
        expect(r.outcome).toBe("hit")
        expect(committedTree(staging.committed())).toEqual(treeOf(files))
        // The manifest is the last write (the commit point).
        expect(store.writes.at(-1)).toBe(manifestKey(trusted, LOOKUP))
      })
    ))

  it("a second publish of the same lookup is 'exists' and does not overwrite the first", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryBlobStore()
        yield* publish({ store, job: trustedJob, lookup: LOOKUP, files: [{ path: "a", bytes: utf8("1") }], buildMs: 1, now: 0 })
        const again = yield* publish({ store, job: trustedJob, lookup: LOOKUP, files: [{ path: "a", bytes: utf8("2") }], buildMs: 1, now: 1 })
        expect(again).toBe("exists")
        const { staging } = yield* restoreInto(store, trustedJob)
        expect(committedTree(staging.committed())).toEqual({ a: Buffer.from("1").toString("hex") })
      })
    ))

  it("rejects unsafe or duplicate output paths before writing anything", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryBlobStore()
        for (const files of [
          [{ path: "../evil", bytes: utf8("x") }],
          [{ path: "/abs", bytes: utf8("x") }],
          [
            { path: "a", bytes: utf8("x") },
            { path: "a", bytes: utf8("y") }
          ]
        ]) {
          const e = yield* Effect.flip(publish({ store, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0 }))
          expect(e).toBeInstanceOf(InvalidOutput)
        }
        expect(store.writes).toEqual([])
      })
    ))
})

/** Mutant publisher: manifest first, then blobs (`manifest_first_unsafe`). */
const publishManifestFirst = (store: MemoryBlobStore, job: Job, files: ReadonlyArray<OutputFile>) =>
  Effect.gen(function* () {
    const entries = files.map((f) => ({ ...f, blob: digestBytes(f.bytes) }))
    const m = makeManifest({ lookup: LOOKUP, buildMs: 1, createdAt: 0, files: entries.map((e) => ({ path: e.path, blob: e.blob, size: e.bytes.length })) })
    yield* store.putIfNoneMatch(manifestKey(job.scope, LOOKUP), encodeManifest(m))
    for (const e of entries) yield* Effect.ignore(store.putIfNoneMatch(blobKey(job.scope, e.blob), e.bytes))
  })

/** BA-2 invariant after a crash: no manifest, or a manifest whose blobs are all present and restore hits with the full entry. */
const crashInvariant = (store: MemoryBlobStore, files: ReadonlyArray<OutputFile>) =>
  Effect.gen(function* () {
    const { r, staging } = yield* restoreInto(store, trustedJob)
    if (r.outcome === "hit") return JSON.stringify(committedTree(staging.committed())) === JSON.stringify(treeOf(files))
    return r.reason === "not_found" && staging.committed() === undefined
  })

describe("BA-2 crash safety (blobs_then_manifest_safe)", () => {
  it("property: after a crash at every write prefix, readers see all or nothing", () =>
    fc.assert(
      fc.asyncProperty(filesArb, async (files) => {
        const distinctBlobs = new Set(files.map((f) => formatDigest(digestBytes(f.bytes)))).size
        for (let k = 0; k <= distinctBlobs + 1; k++) {
          const store = makeMemoryBlobStore({ chunkSize: 16, faults: { crashAfterWrites: k } })
          await run(Effect.ignore(publish({ store, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0, uploadConcurrency: 1 })))
          expect(await run(crashInvariant(store, files))).toBe(true)
        }
      }),
      params(100)
    ))

  it("mutant: manifest-first publishing violates the invariant (detected)", async () => {
    const r = await fc.check(
      fc.asyncProperty(filesArb, async (files) => {
        for (let k = 0; k <= files.length + 1; k++) {
          const store = makeMemoryBlobStore({ faults: { crashAfterWrites: k } })
          await run(Effect.ignore(publishManifestFirst(store, trustedJob, files)))
          if (!(await run(crashInvariant(store, files)))) return false
        }
        return true
      }),
      params(100)
    )
    expect(r.failed).toBe(true)
  })
})

describe("BA-1 restored bytes are the manifest's bytes (content_address_check_sound)", () => {
  const tamperArb = fc.oneof(
    fc.record({ kind: fc.constant("flip" as const), pos: fc.nat(), bit: fc.integer({ min: 0, max: 7 }) }),
    fc.record({ kind: fc.constant("truncate" as const), keep: fc.nat() }),
    fc.record({ kind: fc.constant("extend" as const), extra: fc.uint8Array({ minLength: 1, maxLength: 20 }) }),
    fc.record({ kind: fc.constant("replace" as const), body: fc.uint8Array({ maxLength: 50 }) })
  )
  type Tamper =
    | { kind: "flip"; pos: number; bit: number }
    | { kind: "truncate"; keep: number }
    | { kind: "extend"; extra: Uint8Array }
    | { kind: "replace"; body: Uint8Array }
  const apply = (t: Tamper, body: Uint8Array): Uint8Array => {
    switch (t.kind) {
      case "flip": {
        if (body.length === 0) return Uint8Array.of(1)
        const b = Uint8Array.from(body)
        b[t.pos % b.length]! ^= 1 << t.bit
        return b
      }
      case "truncate":
        return body.length === 0 ? Uint8Array.of(0) : body.slice(0, t.keep % body.length)
      case "extend":
        return Uint8Array.from([...body, ...t.extra])
      case "replace":
        return t.body
    }
  }

  it("property: whatever a reader of a blob receives, a hit commits exactly the published files; otherwise nothing is committed", () => {
    let misses = 0
    let hits = 0
    return fc
      .assert(
        fc.asyncProperty(filesArb, tamperArb, fc.nat(), async (files, t, which) => {
          const store = makeMemoryBlobStore({ chunkSize: 9 })
          await run(publish({ store, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0 }))
          const victim = blobKey(trusted, digestBytes(files[which % files.length]!.bytes))
          let changed = false
          const tampered = makeMemoryBlobStore({
            chunkSize: 9,
            faults: {
              tamper: (key, body) => {
                if (key !== victim) return body
                const out = apply(t, body)
                changed ||= Buffer.compare(Buffer.from(out), Buffer.from(body)) !== 0
                return out
              }
            }
          })
          for (const k of store.writes) tampered.forcePut(k, store.peek(k)!)
          const { r, staging } = await run(restoreInto(tampered, trustedJob))
          if (r.outcome === "hit") {
            hits++
            expect(changed).toBe(false) // a hit is only possible if the bytes were not changed
            expect(committedTree(staging.committed())).toEqual(treeOf(files))
          } else {
            misses++
            expect(changed).toBe(true)
            expect(["digest_mismatch", "size_mismatch"]).toContain(r.reason)
            expect(staging.committed()).toBeUndefined()
            expect(staging.stats.aborted).toBe(1)
          }
        }),
        params(300)
      )
      .then(() => {
        // Non-vacuity: tampering was detected many times; identity "tampering" (e.g. replacing
        // an empty blob by an empty body) is the only way to get a hit, and it is rare.
        expect(misses).toBeGreaterThan(250)
        expect(hits).toBeLessThan(50)
      })
  })

  it("a blob that vanished (GC) or a connection reset is a miss, never an error", () =>
    run(
      Effect.gen(function* () {
        const files = [{ path: "a", bytes: utf8("hello world") }]
        const src = makeMemoryBlobStore()
        yield* publish({ store: src, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0 })
        const noBlob = makeMemoryBlobStore()
        noBlob.forcePut(manifestKey(trusted, LOOKUP), src.peek(manifestKey(trusted, LOOKUP))!)
        expect((yield* restoreInto(noBlob, trustedJob)).r).toMatchObject({ outcome: "miss", reason: "blob_missing" })

        const reset = makeMemoryBlobStore({ chunkSize: 2, faults: { failAfterChunks: (k) => (k.includes("/b/") ? 1 : undefined) } })
        for (const k of src.writes) reset.forcePut(k, src.peek(k)!)
        const { r, staging } = yield* restoreInto(reset, trustedJob)
        expect(r).toMatchObject({ outcome: "miss", reason: "store_error" })
        expect(staging.committed()).toBeUndefined()
      })
    ))

  it("garbled manifests, path traversal and a manifest for another lookup are misses", () =>
    run(
      Effect.gen(function* () {
        const cases: Array<[Uint8Array, string]> = [
          [utf8("{not json"), "manifest_invalid"],
          [Uint8Array.of(0xff, 0xfe), "manifest_invalid"],
          [encodeManifest(makeManifest({ lookup: LOOKUP, buildMs: 1, createdAt: 0, files: [{ path: "../../.bashrc", blob: digestBytes(utf8("x")), size: 1 }] })), "manifest_invalid"],
          [encodeManifest(makeManifest({ lookup: digestBytes(utf8("other")), buildMs: 1, createdAt: 0, files: [] })), "manifest_mismatch"],
          [utf8(JSON.stringify({ ...makeManifest({ lookup: LOOKUP, buildMs: 1, createdAt: 0, files: [] }), lookup: "sha256:00" })), "manifest_invalid"]
        ]
        for (const [body, reason] of cases) {
          const store = makeMemoryBlobStore()
          store.forcePut(manifestKey(trusted, LOOKUP), body)
          expect((yield* restoreInto(store, trustedJob)).r).toMatchObject({ outcome: "miss", reason })
        }
      })
    ))
})

describe("BA-3 scopes stop poisoning (first_write_poisons, unscoped_serves_foreign)", () => {
  it("an untrusted job's entry is invisible to trusted jobs; untrusted jobs prefer the trusted entry", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryBlobStore()
        const evil = [{ path: "a.js", bytes: utf8("steal(secrets)") }]
        yield* publish({ store, job: forkJob, lookup: LOOKUP, files: evil, buildMs: 1, now: 0 })
        // Every key the untrusted job wrote is under its own scope.
        expect(store.writes.every((k) => k.startsWith("v1/fork-pr/"))).toBe(true)
        expect((yield* restoreInto(store, trustedJob)).r).toMatchObject({ outcome: "miss", reason: "not_found" })

        const good = [{ path: "a.js", bytes: utf8("ok()") }]
        yield* publish({ store, job: trustedJob, lookup: LOOKUP, files: good, buildMs: 1, now: 0 })
        const t = yield* restoreInto(store, trustedJob)
        expect(committedTree(t.staging.committed())).toEqual(treeOf(good))
        const f = yield* restoreInto(store, forkJob)
        expect(f.r).toMatchObject({ outcome: "hit", scope: "trusted" })
        expect(committedTree(f.staging.committed())).toEqual(treeOf(good))
      })
    ))

  it("an attacker overwriting a trusted blob out of band causes a miss, never a poisoned restore", () =>
    run(
      Effect.gen(function* () {
        const store = makeMemoryBlobStore()
        const files = [{ path: "a.js", bytes: utf8("ok()") }]
        yield* publish({ store, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0 })
        // Same length as the real blob, so only the digest check can catch it.
        store.forcePut(blobKey(trusted, digestBytes(files[0]!.bytes)), utf8("evil"))
        const { r, staging } = yield* restoreInto(store, trustedJob)
        expect(r).toMatchObject({ outcome: "miss", reason: "digest_mismatch" })
        expect(staging.committed()).toBeUndefined()
      })
    ))
})

describe("BA-4 filesystem staging and atomic swap", () => {
  it("a miss leaves the destination untouched; a hit replaces it exactly (stale files removed)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-restore-"))
    try {
      const dest = path.join(root, "dist")
      await fs.mkdir(dest)
      await fs.writeFile(path.join(dest, "stale.txt"), "old")
      const files = [
        { path: "a.js", bytes: utf8("A") },
        { path: "lib/deep/b.js", bytes: utf8("B".repeat(1000)) }
      ]
      const good = makeMemoryBlobStore({ chunkSize: 100 })
      await run(publish({ store: good, job: trustedJob, lookup: LOOKUP, files, buildMs: 1, now: 0 }))

      const bad = makeMemoryBlobStore({ chunkSize: 100, faults: { tamper: (k, b) => (k.includes("/b/") && b.length > 500 ? b.slice(0, 500) : b) } })
      for (const k of good.writes) bad.forcePut(k, good.peek(k)!)
      const miss = await run(restore({ store: bad, policy, job: trustedJob, lookup: LOOKUP, staging: makeFsStaging(dest) }))
      expect(miss).toMatchObject({ outcome: "miss", reason: "size_mismatch" })
      expect(await fs.readdir(dest)).toEqual(["stale.txt"])
      expect(await fs.readdir(root)).toEqual(["dist"]) // staging directory removed

      const hit = await run(restore({ store: good, policy, job: trustedJob, lookup: LOOKUP, staging: makeFsStaging(dest) }))
      expect(hit.outcome).toBe("hit")
      expect((await fs.readdir(dest)).sort()).toEqual(["a.js", "lib"])
      expect(await fs.readFile(path.join(dest, "lib/deep/b.js"), "utf8")).toBe("B".repeat(1000))
      expect(await fs.readdir(root)).toEqual(["dist"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("BA-5 restore deadline (D-11)", () => {
  /** 10 chunks of 10 bytes, 100 ms each: the blob phase takes 1 s. */
  const slowRestore = (buildMs: number) =>
    Effect.gen(function* () {
      const store = makeMemoryBlobStore({ chunkSize: 10, faults: { chunkDelayMs: (k) => (k.includes("/b/") ? 100 : 0) } })
      yield* publish({ store, job: trustedJob, lookup: LOOKUP, files: [{ path: "a", bytes: new Uint8Array(100) }], buildMs, now: 0 })
      const staging = makeMemoryStaging()
      const fiber = yield* Effect.forkChild(restore({ store, policy, job: trustedJob, lookup: LOOKUP, staging, deadline: { floor: Duration.millis(250), lookup: Duration.seconds(2) } }))
      yield* TestClock.adjust("5 seconds")
      const r: RestoreResult = yield* Fiber.join(fiber)
      return { r, staging }
    })

  it("a restore slower than the rebuild is abandoned at the deadline, and nothing is committed", () =>
    run(
      Effect.gen(function* () {
        const { r, staging } = yield* slowRestore(500)
        expect(r).toMatchObject({ outcome: "miss", reason: "restore_deadline" })
        expect(staging.committed()).toBeUndefined()
        expect(staging.stats.aborted).toBe(1)
      })
    ))

  it("a restore faster than the rebuild completes (the deadline is the manifest's buildMs)", () =>
    run(
      Effect.gen(function* () {
        const { r } = yield* slowRestore(60_000)
        expect(r).toMatchObject({ outcome: "hit", deadline: Duration.seconds(60) })
      })
    ))

  it("threshold: deadline exactly equal to the restore time is a hit; 1 ms less is a miss", () =>
    run(
      Effect.gen(function* () {
        expect((yield* slowRestore(1000)).r.outcome).toBe("hit")
        expect((yield* slowRestore(999)).r).toMatchObject({ outcome: "miss", reason: "restore_deadline" })
      })
    ))

  it("threshold, one chunk: data complete 1 ms after the deadline is a miss, at the deadline a hit (decided by the clock)", () =>
    run(
      Effect.gen(function* () {
        for (const [delay, expected] of [[251, "miss"], [250, "hit"]] as const) {
          const store = makeMemoryBlobStore({ chunkSize: 10, faults: { chunkDelayMs: (k) => (k.includes("/b/") ? delay : 0) } })
          yield* publish({ store, job: trustedJob, lookup: LOOKUP, files: [{ path: "a", bytes: new Uint8Array(10) }], buildMs: 250, now: 0 })
          const staging = makeMemoryStaging()
          const fiber = yield* Effect.forkChild(restore({ store, policy, job: trustedJob, lookup: LOOKUP, staging, deadline: { floor: Duration.millis(250), lookup: Duration.seconds(2) } }))
          yield* TestClock.adjust("5 seconds")
          const r: RestoreResult = yield* Fiber.join(fiber)
          expect(r.outcome).toBe(expected)
          if (expected === "miss") expect(staging.committed()).toBeUndefined()
        }
      })
    ))
})

describe("BA-6 circuit breaker in the client (D-12)", () => {
  it("opens after N unhealthy restores, skips the store while open, probes, and closes when healthy", () =>
    run(
      Effect.gen(function* () {
        let healthy = false
        let reads = 0
        const good = makeMemoryBlobStore()
        yield* publish({ store: good, job: trustedJob, lookup: LOOKUP, files: [{ path: "a", bytes: utf8("x") }], buildMs: 10_000, now: 0 })
        const store: BlobStore = {
          putIfNoneMatch: good.putIfNoneMatch,
          getStream: (k) => {
            reads++
            return healthy ? good.getStream(k) : Effect.fail({ _tag: "StoreFailure", key: k, cause: "down" } as never)
          }
        }
        const client = yield* makeCacheClient({ store, policy, job: trustedJob, breaker: { threshold: 3, coolDown: 2 } })
        const outcomes: string[] = []
        const step = Effect.gen(function* () {
          const r = yield* client.restore(LOOKUP, makeMemoryStaging())
          outcomes.push(r.outcome === "hit" ? "hit" : r.reason)
        })
        for (let i = 0; i < 3; i++) yield* step
        expect(outcomes).toEqual(["store_error", "store_error", "store_error"])
        expect((yield* client.breakerState).tag).toBe("open")
        const readsWhenOpened = reads
        healthy = true
        for (let i = 0; i < 3; i++) yield* step // cool-down 2, then the step to half-open
        expect(outcomes.slice(3)).toEqual(["breaker_open", "breaker_open", "breaker_open"])
        expect(reads).toBe(readsWhenOpened) // the store was not touched while open
        yield* step // the probe
        expect(outcomes.at(-1)).toBe("hit")
        expect((yield* client.breakerState).tag).toBe("closed")
      })
    ))
})
