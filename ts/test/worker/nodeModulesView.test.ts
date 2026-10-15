/**
 * `GET /api/node-modules` over objects written by real `ensureNodeModules`
 * runs (filesystem bucket), the pure aggregation, and the `BlobStore` over
 * the Workers R2 binding shape.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { makeFsBucket } from "../../src/fsBucket.js"
import { Effect, Exit, Option, Redacted, Stream } from "../../src/fx/index.js"
import { ensureNodeModules } from "../../src/nodeModules/ensure.js"
import { makeLocalWorkspace } from "../../src/nodeModules/localWorkspace.js"
import { handle } from "../../src/worker/handler.js"
import { aggregateNodeModules } from "../../src/worker/nodeModulesView.js"
import { makeR2BindingBlobStore } from "../../src/worker/r2BindingBlobStore.js"

const FAKE_INSTALL = ["sh", "-c", "sleep 0.2 && mkdir -p node_modules/x && echo 1 > node_modules/x/index.js && cp package-lock.json node_modules/.package-lock.json"]

const project = (lock: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "nmv-"))
  writeFileSync(path.join(dir, "package.json"), "{}")
  writeFileSync(path.join(dir, "package-lock.json"), lock)
  return dir
}

describe("node_modules view", () => {
  it("aggregates entries, hits, misses and saved time from the bucket", async () => {
    const bucket = makeFsBucket(mkdtempSync(path.join(tmpdir(), "nmv-b-")), { rateLimitMs: 0 })
    const locks = [JSON.stringify({ lockfileVersion: 3, a: 1 }), JSON.stringify({ lockfileVersion: 3, a: 2 })]
    let run = 0
    for (const lock of [locks[0]!, locks[0]!, locks[0]!, locks[1]!, locks[1]!]) {
      await Effect.runPromise(ensureNodeModules({ workspace: makeLocalWorkspace(project(lock)), store: bucket.blobStore, runId: `r${++run}`, install: FAKE_INSTALL, npmVersion: "10.0.0" }))
    }
    const res = await handle(new Request("https://w/api/node-modules", { headers: { authorization: "Bearer t" } }), bucket, { scope: "trusted", token: Redacted.make("t"), now: () => 0 })
    expect(res.status).toBe(200)
    const v = (await res.json()) as ReturnType<typeof aggregateNodeModules>
    expect(v.entries).toHaveLength(2)
    expect(v.totals).toMatchObject({ hits: 3, misses: 2 })
    expect(v.entries.map((e) => [e.hits, e.misses])).toEqual([
      [2, 1],
      [1, 1]
    ])
    for (const e of v.entries) {
      expect(e.coldInstallMs).toBeGreaterThan(0)
      expect(e.tarballBytes).toBeGreaterThan(0)
      expect(e.meanRestoreMs).not.toBeNull()
    }
    expect(v.totals.storedBytes).toBe(v.entries[0]!.tarballBytes + v.entries[1]!.tarballBytes)
    expect(v.orphanEvents).toBe(0)
  }, 60_000)

  it("pure aggregation: orphan reports are counted apart; saved time is never negative", () => {
    const m = { version: 1, key: "k", lockfileSha256: "a", abi: "127", platform: "linux", arch: "x64", nodeVersion: "v22", npmVersion: "10", createdAt: 1, tarballSha256: "t", tarballBytes: 10, installedLockSha256: "i", coldInstallMs: 100 } as const
    const ev = (key: string, outcome: "hit" | "miss", durationMs: number, avoidedMs: number) => ({ version: 1 as const, runId: `${key}${durationMs}`, key, outcome, durationMs, avoidedMs, tarballBytes: 10, at: 0 })
    const v = aggregateNodeModules([m], [ev("k", "miss", 100, 0), ev("k", "hit", 30, 100), ev("k", "hit", 150, 100), ev("gone", "hit", 1, 1)], false)
    expect(v.totals).toMatchObject({ hits: 2, misses: 1, savedMs: 70, meanRestoreMs: 90 })
    expect(v.orphanEvents).toBe(1)
  })
})

describe("BlobStore over the R2 binding", () => {
  const fake = () => {
    const m = new Map<string, Uint8Array>()
    return {
      m,
      put: async (key: string, value: Uint8Array, options?: { onlyIf?: Headers }) => {
        if (options?.onlyIf?.get("If-None-Match") === "*" && m.has(key)) return null
        m.set(key, value)
        return { key }
      },
      get: async (key: string) => {
        const v = m.get(key)
        return v === undefined ? null : { body: new Blob([new Uint8Array(v)]).stream() as ReadableStream<Uint8Array> }
      }
    }
  }
  it("create-only put, 412 as PreconditionFailed, streamed get", async () => {
    const b = fake()
    const store = makeR2BindingBlobStore(b)
    await Effect.runPromise(store.putIfNoneMatch("k", new Uint8Array([1, 2, 3])))
    const again = await Effect.runPromiseExit(store.putIfNoneMatch("k", new Uint8Array([9])))
    expect(Exit.isFailure(again) && JSON.stringify(again).includes("PreconditionFailed")).toBe(true)
    const got = await Effect.runPromise(store.getStream("k"))
    const bytes = Option.isSome(got) ? await Effect.runPromise(Stream.runCollect(got.value)) : null
    expect(bytes === null ? null : [...bytes].flatMap((c) => [...c])).toEqual([1, 2, 3])
    expect(Option.isNone(await Effect.runPromise(store.getStream("missing")))).toBe(true)
  })
  it("a 429 from the binding is RateLimited", async () => {
    const store = makeR2BindingBlobStore({ put: async () => Promise.reject(new Error("429 Too Many Requests")), get: async () => null })
    const exit = await Effect.runPromiseExit(store.putIfNoneMatch("k", new Uint8Array()))
    expect(JSON.stringify(exit)).toContain("RateLimited")
  })
})
