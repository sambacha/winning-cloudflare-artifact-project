/**
 * The dashboard's live feed (`tui/src/liveFeed.ts`) against the real Worker
 * (`src/worker/handler.ts`) reading objects written by the real lock code.
 *
 * | Law | Requirement (Option A+ plan, "Events ← REAL (poll R2)", honest labels) | Oracle |
 * |---|---|---|
 * | E1 | after every lock action, diffing the Worker snapshots before and after gives exactly the event of that action (or none, if the action wrote nothing) | a model of the protocol driven by the same action list |
 * | E2 | pure laws of `diffLocks` on arbitrary snapshots: identity, first poll reports each lock once, ≤ 1 event per object, an unchanged ETag yields only `LEASE_EXPIRED` | set arithmetic on keys |
 * | C1 | `/api/cache` → `parseLiveCache` preserves the counts and byte totals of the objects under `b/` and `m/` | sums over the generated objects |
 * | A1 | `/api/artifacts` → `parseLiveArtifacts` preserves repo, remote and the commit list | the fake repo's first-parent chain |
 * | P1 | a panel is LIVE / MEASURED only if its source actually arrived; cost is never LIVE | all 16 source combinations (exhaustive) |
 * | M1 | `parseLeanAudit` returns the last audit line of a log, `null` without one | generated logs with noise |
 *
 * Negations: a diff that ignores the acquisition time (reports a takeover as
 * a renewal) and a diff that reports every ETag change as `RENEWED` are both
 * refuted by E1.
 */
import { Clock, Duration, Effect, Redacted } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilledAsync } from "../harness.js"
import { type HeldLock, makeCobuildLock, makeMemoryStore } from "../../src/index.js"
import { encodeKey } from "../../src/cache/keyEncoding.js"
import { handle } from "../../src/worker/handler.js"
import { parseLiveLocks, type LiveLock } from "../../../tui/src/live.js"
import {
  diffLocks,
  type LockEvent,
  type LockSnapshotEntry,
  parseLeanAudit,
  parseLiveArtifacts,
  parseLiveCache,
  provenance,
  formatBytes
} from "../../../tui/src/liveFeed.js"
import { makeFakeBucket } from "./fakeBucket.js"
import { firstParentChain, makeFakeNamespace, makeRepo } from "../bisect/fakeArtifacts.js"
import { CacheKey, JobId } from "../../src/ids.js"

announce("test/worker/liveFeedContract.test.ts")

const LEASE = 30_000
const SHELF = 30 * 60_000
const JOBS = ["primary", "extra1", "extra2"] as const
const KEYS = ["mathlib-import", "build-core", "lint-lean"] as const
type Act = "acquire" | "renew" | "abandon" | "succeed" | "fail" | "wait"
interface Step {
  readonly act: Act
  readonly job: (typeof JOBS)[number]
  readonly key: (typeof KEYS)[number]
}

type ModelEntry =
  | { readonly st: "building"; readonly owner: string; readonly expiresAt: number; readonly abandoned: boolean }
  | { readonly st: "succeeded"; readonly owner: string }
  | { readonly st: "failed"; readonly owner: string; readonly failedAt: number }

/** What a step should show in the event stream, from the protocol rules alone. */
interface Expected {
  readonly kind: LockEvent["kind"]
  readonly cacheKey: string
  readonly owner: string
  readonly prevOwner: string | null
}

type Diff = (prev: ReadonlyArray<LockSnapshotEntry>, next: ReadonlyArray<LockSnapshotEntry>) => ReadonlyArray<LockEvent>

const snapshot = (bucket: ReturnType<typeof makeFakeBucket>, now: number) =>
  Effect.promise(async () => {
    const res = await handle(new Request("https://w.example/api/locks?context=demo", { headers: { authorization: "Bearer t" } }), bucket, {
      scope: "trusted",
      token: Redacted.make("t"),
      now: () => now
    })
    return parseLiveLocks(await res.json()).locks.filter((l): l is LiveLock => !("error" in l))
  })

/**
 * Run `steps` with the real lock code (one lock per job, memory store without
 * rate limit), snapshot through the Worker after each step, and compare
 * `diff(before, after)` with the model's expectation. Returns the number of
 * steps that wrote something (for the meaningfulness counts).
 */
const runScenario = (steps: ReadonlyArray<Step>, diff: Diff) =>
  Effect.gen(function* () {
    const store = makeMemoryStore(0)
    const bucket = makeFakeBucket({ locks: store })
    const locks = Object.fromEntries(
      JOBS.map((j) => [j, makeCobuildLock(store, { scope: "trusted", context: "demo", jobId: JobId(j), rateLimit: Duration.millis(0), maxLatency: Duration.millis(0), maxSkew: Duration.millis(0), lease: Duration.millis(LEASE), failureShelf: Duration.millis(SHELF) })])
    ) as Record<string, ReturnType<typeof makeCobuildLock>>
    const model = new Map<string, ModelEntry>()
    const held = new Map<string, HeldLock>() // `${key}|${job}` → the job's latest handle (possibly stale)
    let prev = yield* snapshot(bucket, 0)
    let writes = 0
    for (const s of steps) {
      yield* TestClock.adjust(Duration.millis(s.act === "wait" ? LEASE + 1 : 1))
      const now = yield* Clock.currentTimeMillis
      const m = model.get(s.key)
      const h = held.get(`${s.key}|${s.job}`)
      let expected: ReadonlyArray<Expected> = []
      switch (s.act) {
        case "wait": {
          for (const k of KEYS) {
            const e = model.get(k)
            if (e?.st === "building" && !e.abandoned && e.expiresAt >= now - (LEASE + 1) && e.expiresAt < now) {
              expected = [...expected, { kind: "LEASE_EXPIRED", cacheKey: k, owner: e.owner, prevOwner: null }]
            }
          }
          break
        }
        case "acquire": {
          const r = yield* locks[s.job]!.acquire(CacheKey(s.key))
          const stealable =
            m === undefined ||
            (m.st === "building" && m.expiresAt < now) ||
            (m.st === "failed" && m.failedAt + SHELF < now)
          expect(r.state === "obtained").toBe(stealable)
          if (r.state === "obtained") {
            held.set(`${s.key}|${s.job}`, r.lock)
            expected = [{ kind: m === undefined ? "ACQUIRED" : "TAKEOVER", cacheKey: s.key, owner: s.job, prevOwner: m === undefined ? null : m.owner }]
            model.set(s.key, { st: "building", owner: s.job, expiresAt: now + LEASE, abandoned: false })
          }
          break
        }
        default: {
          if (h === undefined) break
          // Current iff this job's handle still names the stored version.
          const current = store.peek(h.objectKey)?.etag === h.etag
          const eff =
            s.act === "renew"
              ? Effect.map(locks[s.job]!.renewOnce(h), (nh) => void held.set(`${s.key}|${s.job}`, nh))
              : s.act === "abandon"
                ? locks[s.job]!.abandon(h)
                : locks[s.job]!.markCompleted(h, s.act === "succeed" ? { status: "succeeded", buildCacheKey: `bk-${s.key}` } : { status: "failed", logKey: null })
          const r = yield* Effect.result(eff)
          expect(r._tag === "Success").toBe(current)
          if (r._tag === "Failure") expect(r.failure._tag).toBe("LockLost")
          if (!current) break
          if (s.act !== "renew") held.delete(`${s.key}|${s.job}`)
          if (s.act === "renew") {
            expected = [{ kind: "RENEWED", cacheKey: s.key, owner: s.job, prevOwner: null }]
            model.set(s.key, { st: "building", owner: s.job, expiresAt: now + LEASE, abandoned: false })
          } else if (s.act === "abandon") {
            expected = [{ kind: "ABANDONED", cacheKey: s.key, owner: s.job, prevOwner: null }]
            model.set(s.key, { st: "building", owner: s.job, expiresAt: now - 1, abandoned: true })
          } else if (s.act === "succeed") {
            expected = [{ kind: "SUCCEEDED", cacheKey: s.key, owner: s.job, prevOwner: null }]
            model.set(s.key, { st: "succeeded", owner: s.job })
          } else {
            expected = [{ kind: "FAILED", cacheKey: s.key, owner: s.job, prevOwner: null }]
            model.set(s.key, { st: "failed", owner: s.job, failedAt: now })
          }
        }
      }
      const next = yield* snapshot(bucket, now)
      const got = diff(prev, next).map((e) => ({ kind: e.kind, cacheKey: e.cacheKey, owner: e.owner, prevOwner: e.prevOwner }))
      const byKey = (a: Expected, b: Expected) => (a.cacheKey < b.cacheKey ? -1 : a.cacheKey > b.cacheKey ? 1 : 0)
      expect([...got].sort(byKey)).toEqual([...expected].sort(byKey))
      if (s.act !== "wait" && expected.length > 0) writes++
      prev = next
    }
    return writes
  })

const stepArb = fc.record({
  act: fc.constantFrom<Act>("acquire", "acquire", "renew", "abandon", "succeed", "fail", "wait"),
  job: fc.constantFrom(...JOBS),
  key: fc.constantFrom(...KEYS)
})

const runE1 = (steps: ReadonlyArray<Step>, diff: Diff) => Effect.runPromise(runScenario(steps, diff).pipe(Effect.provide(TestClock.layer())))

describe("events from consecutive Worker snapshots (E1)", () => {
  it("regression (the Option A+ crash-and-takeover scenario): acquire, renew, crash, lease expiry, takeover, publish", async () => {
    const steps: Step[] = [
      { act: "acquire", job: "primary", key: "build-core" },
      { act: "renew", job: "primary", key: "build-core" },
      { act: "acquire", job: "extra2", key: "build-core" }, // pending: no write, no event
      { act: "wait", job: "primary", key: "build-core" }, // primary crashed: no renewal, lease expires
      { act: "acquire", job: "extra2", key: "build-core" }, // takeover via If-Match
      { act: "renew", job: "primary", key: "build-core" }, // the zombie's write is fenced: LockLost, no event
      { act: "succeed", job: "extra2", key: "build-core" }
    ]
    expect(await runE1(steps, diffLocks)).toBe(4)
  })

  it("E1 law: every action's net change is exactly the modelled event", async () => {
    await lawAsync(
      "snapshot diff = protocol events",
      fc.array(stepArb, { minLength: 1, maxLength: 25 }),
      async (steps) => {
        const writes = await runE1(steps, diffLocks)
        return { valid: writes > 0, boundary: steps.some((s) => s.act === "wait") && steps.some((s) => s.act === "acquire") }
      },
      120,
      { domain: "1–25 steps of acquire/renew/abandon/succeed/fail/wait by 3 jobs on 3 keys", minValidFraction: 0.6, minBoundary: 25 }
    )
  })

  it("E1 negations: diffs that miss takeovers or classify every change as a renewal are refuted", async () => {
    const ignoresAcquisition: Diff = (p, n) =>
      diffLocks(p, n).map((e) => (e.kind === "TAKEOVER" && p.some((x) => x.key === e.key && x.status === "building") ? { ...e, kind: "RENEWED", prevOwner: null } : e))
    const allRenewals: Diff = (p, n) => diffLocks(p, n).map((e) => (p.some((x) => x.key === e.key) && e.kind !== "LEASE_EXPIRED" ? { ...e, kind: "RENEWED", prevOwner: null } : e))
    for (const mutant of [ignoresAcquisition, allRenewals]) {
      const killed = await mutantKilledAsync(fc.array(stepArb, { minLength: 4, maxLength: 25 }), async (steps) => {
        await runE1(steps, mutant)
        return true
      }, 80)
      expect(killed).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------

const entryArb = (key: string): fc.Arbitrary<LockSnapshotEntry> =>
  fc.record({
    key: fc.constant(key),
    cacheKey: fc.constant(key),
    etag: fc.constantFrom('"e1"', '"e2"', '"e3"'),
    owner: fc.constantFrom(...JOBS),
    status: fc.constantFrom("building" as const, "succeeded" as const, "failed" as const),
    acquiredAt: fc.integer({ min: 0, max: 3 }),
    heartbeatAt: fc.integer({ min: 0, max: 3 }),
    expiresAt: fc.integer({ min: -1, max: 4 }),
    leaseExpired: fc.boolean()
  })

const snapArb = fc.subarray(["a", "b", "c", "d"]).chain((keys) => fc.tuple(...keys.map(entryArb)))

describe("diffLocks pure laws (E2)", () => {
  it("E2 law: identity, first-poll completeness, ≤ 1 event per object, unchanged ETag ⇒ only LEASE_EXPIRED", () => {
    law(
      "diff structure",
      fc.tuple(snapArb, snapArb),
      ([p, n]) => {
        expect(diffLocks(n, n)).toEqual([])
        const first = diffLocks([], n)
        expect(first.map((e) => e.key)).toEqual(n.map((l) => l.key))
        expect(first.every((e) => e.kind === (n.find((l) => l.key === e.key)!.status === "building" ? "ACQUIRED" : n.find((l) => l.key === e.key)!.status === "succeeded" ? "SUCCEEDED" : "FAILED"))).toBe(true)
        const d = diffLocks(p, n)
        const keys = d.map((e) => e.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (const e of d) {
          const before = p.find((l) => l.key === e.key)
          const after = n.find((l) => l.key === e.key)
          if (after === undefined) expect(e.kind).toBe("REMOVED")
          else if (before === undefined) expect(["ACQUIRED", "SUCCEEDED", "FAILED"]).toContain(e.kind)
          else if (before.etag === after.etag) expect(e.kind).toBe("LEASE_EXPIRED")
        }
        // Completeness: every object that appeared, disappeared or changed ETag has its event.
        for (const l of n) {
          const before = p.find((x) => x.key === l.key)
          if (before === undefined || before.etag !== l.etag) expect(keys).toContain(l.key)
        }
        for (const l of p) if (!n.some((x) => x.key === l.key)) expect(keys).toContain(l.key)
        const changed = n.filter((l) => p.some((x) => x.key === l.key && x.etag !== l.etag)).length
        return { valid: d.length > 0, boundary: changed > 0 && d.length < n.length }
      },
      400,
      { domain: "two snapshots of ≤ 4 objects with colliding ETags, owners and times", minValidFraction: 0.5, minBoundary: 5 }
    )
  })
})

describe("cache, artifacts, provenance, Lean audit (C1, A1, P1, M1)", () => {
  it("C1 law: /api/cache → parseLiveCache keeps the counts and byte totals of b/ and m/", async () => {
    await lawAsync(
      "cache summary",
      fc.record({ blobs: fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 12 }), manifests: fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 6 }) }),
      async ({ blobs, manifests }) => {
        const bucket = makeFakeBucket({})
        blobs.forEach((size, i) => bucket.extra.set(encodeKey(["trusted", "b", `blake3-${i}`]), "x".repeat(size)))
        manifests.forEach((size, i) => bucket.extra.set(encodeKey(["trusted", "m", `k-${i}`]), "y".repeat(size)))
        bucket.extra.set(encodeKey(["other", "b", "z"]), "not in scope")
        const res = await handle(new Request("https://w.example/api/cache", { headers: { authorization: "Bearer t" } }), bucket, { scope: "trusted", token: Redacted.make("t"), now: () => 0 })
        const c = parseLiveCache(await res.json())
        expect(c).toEqual({
          scope: "trusted",
          blobCount: blobs.length,
          blobBytes: blobs.reduce((a, b) => a + b, 0),
          manifestCount: manifests.length,
          manifestBytes: manifests.reduce((a, b) => a + b, 0),
          truncated: false
        })
        return { valid: blobs.length > 0, boundary: blobs.length === 0 || manifests.length === 0 }
      },
      80,
      { domain: "0–12 blobs, 0–6 manifests, one object of another scope", minValidFraction: 0.7, minBoundary: 3 }
    )
  })

  it("C1 unit: malformed cache bodies are rejected", () => {
    const ok = { scope: "s", blobCount: 1, blobBytes: 2, manifestCount: 0, manifestBytes: 0, truncated: false }
    expect(parseLiveCache(ok)).toEqual(ok)
    for (const bad of [null, [], { ...ok, blobCount: -1 }, { ...ok, blobBytes: 1.5 }, { ...ok, truncated: "no" }, { ...ok, scope: 3 }]) {
      expect(() => parseLiveCache(bad)).toThrow()
    }
  })

  it("A1 law: /api/artifacts → parseLiveArtifacts keeps repo, remote and the newest-first commit list", async () => {
    await lawAsync(
      "artifacts panel",
      fc.record({ n: fc.integer({ min: 1, max: 25 }), limit: fc.integer({ min: 1, max: 30 }) }),
      async ({ n, limit }) => {
        const { repo } = makeRepo(n)
        const ns = makeFakeNamespace({ "cobuilds-run": repo })
        const res = await handle(new Request(`https://w.example/api/artifacts?repo=cobuilds-run&limit=${limit}`, { headers: { authorization: "Bearer t" } }), makeFakeBucket({}), {
          scope: "trusted",
          token: Redacted.make("t"),
          artifacts: ns,
          now: () => 0
        })
        const a = parseLiveArtifacts(await res.json())
        expect(a.repo).toBe("cobuilds-run")
        expect(a.remote).toMatch(/\/cobuilds-run\.git$/)
        expect(a.commits.map((c) => c.oid)).toEqual(firstParentChain(repo, repo.refs.get("main")!).slice(0, limit))
        return { valid: true, boundary: limit >= n }
      },
      60,
      { domain: "1–25 commits, limit 1–30", minValidFraction: 1, minBoundary: 5 }
    )
  })

  it("P1 (exhaustive): LIVE/MEASURED only when the source arrived; cost and absent sources are DEMO", () => {
    for (let mask = 0; mask < 16; mask++) {
      const s = { locks: (mask & 1) !== 0, cache: (mask & 2) !== 0, artifacts: (mask & 4) !== 0, leanAudit: (mask & 8) !== 0 }
      const p = provenance(s)
      expect(p.locks === "LIVE").toBe(s.locks)
      expect(p.events === "LIVE").toBe(s.locks)
      expect(p.cache === "LIVE").toBe(s.cache)
      expect(p.artifacts === "LIVE").toBe(s.artifacts)
      expect(p.lean === "MEASURED").toBe(s.leanAudit)
      expect(p.cost).toBe("DEMO")
      for (const v of Object.values(p)) expect(["LIVE", "MEASURED", "DEMO"]).toContain(v)
    }
  })

  it("M1 law: parseLeanAudit returns the last audit line among arbitrary noise, null without one", () => {
    const auditLine = fc.record({ n: fc.nat({ max: 100_000 }), m: fc.nat({ max: 50 }), pfx: fc.constantFrom<string>("RequestProject", "Cobuilds.Tests") })
    law(
      "lean audit",
      fc.record({ lines: fc.array(fc.oneof(auditLine, fc.string({ maxLength: 30 }).filter((s) => !s.includes("axiom audit"))), { maxLength: 8 }) }),
      ({ lines }) => {
        const text = lines.map((l) => (typeof l === "string" ? l : `info: axiom audit: ${l.n} theorems in modules under ${l.pfx}, ${l.m} violations`)).join("\n")
        const audits = lines.filter((l): l is { n: number; m: number; pfx: string } => typeof l !== "string")
        const last = audits.at(-1)
        expect(parseLeanAudit(text)).toEqual(last === undefined ? null : { theorems: last.n, violations: last.m, prefix: last.pfx })
        return { valid: last !== undefined, boundary: audits.length > 1 }
      },
      300,
      { domain: "≤ 8 lines mixing audit lines and noise", minValidFraction: 0.5, minBoundary: 20 }
    )
    expect(parseLeanAudit("axiom audit: 1798 theorem in modules under RequestProject, 0 violations")).toBeNull()
  })

  it("formatBytes: exact below 1 KiB, one decimal above, monotone", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1024)).toBe("1.0 KiB")
    expect(formatBytes(45.2 * 1024 * 1024)).toBe("45.2 MiB")
    expect(() => formatBytes(-1)).toThrow(RangeError)
  })
})
