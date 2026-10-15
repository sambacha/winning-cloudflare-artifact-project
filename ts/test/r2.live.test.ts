/**
 * Phase 1 of the demo plan: the R2 adapters against a **real** R2 bucket.
 *
 * Skipped unless all of these are set (nothing here has been run against
 * Cloudflare from this repository: no credentials or network here):
 *
 *   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com   (or R2_ACCOUNT_ID=<32 hex>)
 *   R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…  R2_BUCKET=…
 *
 *   npm run test:r2-live
 *
 * Every run writes under a fresh context / lookup, so runs never collide. Each
 * test pins one externally unchecked fact that the in-memory store assumes:
 * `If-None-Match: *` on an existing key is rejected (412, or 409 on a race),
 * `If-Match` with a stale ETag is rejected, a successful write returns a new
 * ETag, takeover after lease expiry works, and blobs round-trip with their
 * digest verified.
 */
import { Duration, Effect, Option, Redacted, Result } from "../src/fx/index.js"
import { describe, expect, it } from "vitest"
import { makeR2BlobStore } from "../src/cache/r2BlobStore.js"
import { digestBytes } from "../src/cache/digest.js"
import { publish } from "../src/cache/publish.js"
import { restore } from "../src/cache/restore.js"
import { makeScope } from "../src/cache/scope.js"
import { makeMemoryStaging } from "../src/cache/staging.js"
import { makeCobuildLock, makeR2Store } from "../src/index.js"
import { makeR2S3Client, makeS3BucketView, r2ConfigFromEnv } from "../src/r2Client.js"
import { handle, type LocksResponse } from "../src/worker/handler.js"
import { CacheKey, JobId } from "../src/ids.js"

const env = process.env
const r2 = r2ConfigFromEnv(env)
const configured = r2 !== null

// The same client configuration the CLI uses (`src/r2Client.ts`): the lock client has SDK retries off.
const client = (purpose: "lock" | "blob" = "lock") => makeR2S3Client(r2!, purpose)

const runId = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!configured)("real R2 (set R2_* to run)", () => {
  it("If-None-Match: * creates once, then is rejected; If-Match needs the current ETag", async () => {
    const store = makeR2Store(client(), r2!.bucket)
    const key = `v1/trusted/smoke/${runId}/cas/`
    const e1 = await Effect.runPromise(store.putIfNoneMatch(key, "{}"))
    await sleep(1100) // stay under 1 write / key / s
    const again = await Effect.runPromise(Effect.result(store.putIfNoneMatch(key, "{}")))
    expect(Result.isFailure(again) && again.failure._tag).toBe("PreconditionFailed")
    await sleep(1100)
    const e2 = await Effect.runPromise(store.putIfMatch(key, e1, '{"v":2}'))
    expect(e2).not.toBe(e1)
    await sleep(1100)
    const stale = await Effect.runPromise(Effect.result(store.putIfMatch(key, e1, '{"v":3}')))
    expect(Result.isFailure(stale) && stale.failure._tag).toBe("PreconditionFailed")
    const read = await Effect.runPromise(store.get(key))
    expect(Option.getOrThrow(read)).toEqual({ body: '{"v":2}', etag: e2 })
  }, 60_000)

  it("lock: second job is pending while the lease is live and takes over after it expires", async () => {
    const store = makeR2Store(client(), r2!.bucket)
    const cfg = { scope: "trusted", context: runId, lease: Duration.millis(6_000), renewInterval: Duration.millis(2_000), maxLatency: Duration.millis(1_500), maxSkew: Duration.millis(1_000) }
    const a = makeCobuildLock(store, { ...cfg, jobId: JobId("primary") })
    const b = makeCobuildLock(store, { ...cfg, jobId: JobId("extra1") })
    const first = await Effect.runPromise(a.acquire(CacheKey("op-1")))
    expect(first.state).toBe("obtained")
    await sleep(1100)
    expect((await Effect.runPromise(b.acquire(CacheKey("op-1")))).state).toBe("pending")
    await sleep(7_000) // primary "crashed": no renewal
    const taken = await Effect.runPromise(b.acquire(CacheKey("op-1")))
    expect(taken.state).toBe("obtained")
  }, 60_000)

  it("blob cache: publish then restore with digest verification", async () => {
    const blobs = makeR2BlobStore(client("blob"), r2!.bucket)
    const job = { scope: makeScope("trusted") }
    const lookup = digestBytes(new TextEncoder().encode(runId))
    const files = [{ path: "out/a.txt", bytes: new TextEncoder().encode(`hello ${runId}`) }]
    expect(await Effect.runPromise(publish({ store: blobs, job, lookup, files, buildMs: 1, now: Date.now() }))).toBe("published")
    const staging = makeMemoryStaging()
    const r = await Effect.runPromise(restore({ store: blobs, policy: { trusted: [job.scope] }, job, lookup, staging }))
    expect(r.outcome).toBe("hit")
    expect(new TextDecoder().decode(staging.committed()!.get("out/a.txt"))).toBe(`hello ${runId}`)
  }, 60_000)
})

describe.skipIf(!configured)("real R2: facts the design depends on (set R2_* to run)", () => {
  it("records what R2 answers to a second write to one key within 1 s (429, or accepted)", async () => {
    const store = makeR2Store(client(), r2!.bucket)
    const key = `v1/trusted/smoke/${runId}/rate/`
    const e1 = await Effect.runPromise(store.putIfNoneMatch(key, "{}"))
    const fast = await Effect.runPromise(Effect.result(store.putIfMatch(key, e1, '{"v":2}')))
    // Either outcome is handled by the lock (429 is retried after 1 s); print it for the review.
    console.log(`[r2-live] second write after <1 s: ${Result.isFailure(fast) ? fast.failure._tag : "accepted"}`)
    expect(Result.isSuccess(fast) || ["RateLimited", "PreconditionFailed"].includes(fast.failure._tag)).toBe(true)
  }, 60_000)

  it("the status view over the S3 API lists and decodes the lock objects the lock wrote", async () => {
    const store = makeR2Store(client(), r2!.bucket)
    const context = `${runId}-status`
    const a = makeCobuildLock(store, { scope: "trusted", context, jobId: JobId("primary") })
    expect((await Effect.runPromise(a.acquire(CacheKey("op-status")))).state).toBe("obtained")
    const res = await handle(new Request(`http://x/api/locks?context=${context}`, { headers: { authorization: "Bearer t" } }), makeS3BucketView(client("blob"), r2!.bucket), {
      scope: "trusted",
      token: Redacted.make("t"),
      now: () => Date.now()
    })
    const body = (await res.json()) as LocksResponse
    expect(body.locks).toHaveLength(1)
    expect(body.locks[0]).toMatchObject({ cacheKey: "op-status", owner: "primary", status: "building" })
  }, 60_000)
})

describe.runIf(!configured)("real R2", () => {
  it("is skipped: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are not all set", () => {
    expect(configured).toBe(false)
  })
})
