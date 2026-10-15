/**
 * Worker additions for the Option A+ demo and the audit (B-3b, B-7):
 * `/healthz`, token roles, structured request logs, failure containment, and
 * the read-only Artifacts view `GET /api/artifacts`.
 *
 * Every oracle is written from the requirement, not from the handler:
 *
 * | Law | Requirement | Oracle |
 * |---|---|---|
 * | H1 | `/healthz` answers without credentials and never reads the bucket | 200 `{status:"ok"}`, 0 bucket calls |
 * | R1 | a request is served iff its token grants the route's role | `expectedStatusClass` |
 * | L1 | exactly one log entry per request, with the response's status, the bare path, the granted role, and no secret | entry fields vs request/response |
 * | E1 | a bucket exception becomes a bare 500; its message reaches neither the client nor the log | body and log contents |
 * | A1 | `/api/artifacts` returns the first-parent history of the ref, newest first, cut to `limit`, with the repo's remote; the handle is always disposed; no token field ever appears | `firstParentChain` of the fake repo |
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, lawAsync, mutantKilledAsync } from "../harness.js"
import type { ArtifactsNamespaceLike } from "../../src/bisect/artifactsApi.js"
import { handle, type HandlerConfig, type RequestLogEntry, requiredRole, roleOf } from "../../src/worker/handler.js"
import type { R2BucketLike } from "../../src/worker/r2Bucket.js"
import { workerConfig } from "../../src/worker/index.js"
import { type ArtifactsQuery, viewArtifactsRepo } from "../../src/worker/artifactsView.js"
import { firstParentChain, type FakeRepo, makeFakeNamespace, makeRepo } from "../bisect/fakeArtifacts.js"
import { Effect, Redacted } from "../../src/fx/index.js"

announce("test/worker/observability.test.ts")

const READ = "read-token-AAAA"
const WRITE = "write-token-BBBB"

/** A bucket that counts every call and holds no objects. */
const countingBucket = () => {
  let calls = 0
  const bucket: R2BucketLike = {
    list: async () => {
      calls++
      return { objects: [], truncated: false }
    },
    get: async () => {
      calls++
      return null
    }
  }
  return { bucket, calls: () => calls }
}

const request = (path: string, token: string | null, method = "GET") =>
  new Request(`https://cobuilds.example${path}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } })

const collect = () => {
  const entries: Array<RequestLogEntry> = []
  return { entries, log: (e: RequestLogEntry) => void entries.push(e) }
}

describe("GET /healthz (H1)", () => {
  it("answers 200 without credentials and without touching the bucket; other methods are 405", async () => {
    for (const token of [null, "wrong", READ]) {
      const b = countingBucket()
      const { entries, log } = collect()
      const res = await handle(request("/healthz", token), b.bucket, { scope: "trusted", token: Redacted.make(READ), now: () => 0, log })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: "ok" })
      expect(b.calls()).toBe(0)
      expect(entries).toEqual([{ level: "info", msg: "request", method: "GET", path: "/healthz", status: 200, durationMs: 0, scope: "trusted", auth: "public" }])
    }
    const res = await handle(request("/healthz", null, "POST"), countingBucket().bucket, { scope: "trusted", token: Redacted.make(READ), now: () => 0 })
    expect(res.status).toBe(405)
  })

  it("reports a misconfigured Worker as unhealthy (500), so a health check catches it", async () => {
    const res = await handle(request("/healthz", null), countingBucket().bucket, { scope: "Not A Scope", token: Redacted.make(READ), now: () => 0 })
    expect(res.status).toBe(500)
  })
})

/** Requirement oracle for authentication and roles. */
const expectedAuth = (writeConfigured: boolean, presented: "read" | "write" | "wrong" | "none", path: string): "401" | "403" | "served" => {
  if (presented === "wrong" || presented === "none") return "401"
  if (presented === "write" && !writeConfigured) return "401" // there is no write token to match
  // The bisection API is `/api/bisect` and everything below it; `/api/bisectx` is a different (unknown) route.
  const pathname = path.split("?")[0]!
  const needsWrite = pathname === "/api/bisect" || pathname.startsWith("/api/bisect/")
  if (needsWrite && writeConfigured && presented === "read") return "403"
  return "served"
}

const PATHS = ["/api/locks?context=ctx", "/api/cache", "/api/artifacts?repo=demo", "/api/bisect", "/api/bisect/abc", "/api/bisectx", "/nope"]

describe("roles and request logs (R1, L1)", () => {
  it("unit: requiredRole and roleOf", () => {
    expect(requiredRole("/api/bisect")).toBe("write")
    expect(requiredRole("/api/bisect/x/y")).toBe("write")
    expect(requiredRole("/api/bisectx")).toBe("read")
    expect(requiredRole("/api/locks")).toBe("read")
    expect(roleOf(`Bearer ${READ}`, { token: Redacted.make(READ) })).toBe("write")
    expect(roleOf(`Bearer ${READ}`, { token: Redacted.make(READ), writeToken: Redacted.make(WRITE) })).toBe("read")
    expect(roleOf(`Bearer ${WRITE}`, { token: Redacted.make(READ), writeToken: Redacted.make(WRITE) })).toBe("write")
    expect(roleOf(`Bearer ${WRITE}`, { token: Redacted.make(READ) })).toBeNull()
    expect(roleOf(`Bearer `, { token: Redacted.make(READ), writeToken: Redacted.make("") })).toBeNull()
  })

  it("R1 + L1 law: served iff the token grants the role; one log entry per request with the response's status and no secret", async () => {
    const ns = makeFakeNamespace({ demo: makeRepo(3).repo })
    await lawAsync(
      "roles and logs",
      fc.record({
        writeConfigured: fc.boolean(),
        presented: fc.constantFrom("read", "write", "wrong", "none") as fc.Arbitrary<"read" | "write" | "wrong" | "none">,
        path: fc.constantFrom(...PATHS),
        method: fc.constantFrom("GET", "POST"),
        now0: fc.integer({ min: 0, max: 1e9 }),
        dt: fc.integer({ min: 0, max: 5_000 })
      }),
      async ({ writeConfigured, presented, path, method, now0, dt }) => {
        const { entries, log } = collect()
        let t = now0
        let clockReads = 0
        const cfg: HandlerConfig = {
          scope: "trusted",
          token: Redacted.make(READ),
          ...(writeConfigured ? { writeToken: Redacted.make(WRITE) } : {}),
          artifacts: ns,
          log,
          now: () => {
            clockReads++
            const v = t
            t += dt
            return v
          }
        }
        const token = presented === "read" ? READ : presented === "write" ? WRITE : presented === "wrong" ? "nope" : null
        const res = await handle(request(path, token, method), countingBucket().bucket, cfg)
        const want = expectedAuth(writeConfigured, presented, path)
        if (want === "401") expect(res.status).toBe(401)
        else if (want === "403") expect(res.status).toBe(403)
        else expect([401, 403]).not.toContain(res.status)
        expect(entries).toHaveLength(1)
        const e = entries[0]!
        expect(e.status).toBe(res.status)
        expect(e.method).toBe(method)
        expect(e.path).toBe(new URL(`https://x${path}`).pathname)
        // The handler reads the clock first and last; routes may read it in between (lease expiry).
        expect(e.durationMs).toBe((clockReads - 1) * dt)
        expect(e.auth).toBe(want === "served" ? (presented === "read" && writeConfigured ? "read" : "write") : "denied")
        const line = JSON.stringify(e)
        expect(line).not.toContain(READ)
        expect(line).not.toContain(WRITE)
        expect(line).not.toContain("?")
        return { valid: true, boundary: want === "403" }
      },
      300,
      { domain: "write token on/off × presented token × 7 paths × GET/POST", minValidFraction: 1, minBoundary: 3 }
    )
  })

  it("workerConfig: BISECT_API_TOKEN becomes the write token and must differ from API_TOKEN", () => {
    const bucket = countingBucket().bucket
    // `toEqual` cannot see inside a `Redacted` (the value is not an own property), so unwrap explicitly.
    const revealed = (c: ReturnType<typeof workerConfig>) =>
      typeof c === "string"
        ? c
        : { ...c, token: Redacted.value(c.token), ...(c.writeToken !== undefined ? { writeToken: Redacted.value(c.writeToken) } : {}) }
    const both = workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: READ, COBUILD_SCOPE: "trusted", BISECT_API_TOKEN: WRITE })
    expect(revealed(both)).toEqual({ scope: "trusted", token: READ, writeToken: WRITE })
    expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: READ, COBUILD_SCOPE: "trusted", BISECT_API_TOKEN: READ })).toBe("string")
    expect(revealed(workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: READ, COBUILD_SCOPE: "trusted", BISECT_API_TOKEN: "" }))).toEqual({ scope: "trusted", token: READ })
    // The decoded tokens are Redacted: a logged or serialized configuration does not contain them.
    const printed = `${JSON.stringify(both)} ${String(typeof both === "string" ? both : both.token)}`
    expect(printed).not.toContain(READ)
    expect(printed).not.toContain(WRITE)
  })
})

describe("failure containment (E1)", () => {
  it("law: any bucket exception gives 500 {error:'internal error'}; neither body nor log contains its message", async () => {
    await lawAsync(
      "exceptions are contained",
      fc.record({ secret: fc.string({ minLength: 8, maxLength: 24 }).filter((s) => !/[\\"]/.test(s)), path: fc.constantFrom("/api/locks?context=c", "/api/cache") }),
      async ({ secret, path }) => {
        const failing: R2BucketLike = {
          list: async () => {
            throw new TypeError(`connection reset ${secret}`)
          },
          get: async () => null
        }
        const { entries, log } = collect()
        const res = await handle(request(path, READ), failing, { scope: "trusted", token: Redacted.make(READ), now: () => 0, log })
        expect(res.status).toBe(500)
        const body = await res.text()
        expect(JSON.parse(body)).toEqual({ error: "internal error" })
        expect(body).not.toContain(secret)
        expect(entries).toHaveLength(1)
        expect(entries[0]!.error).toBe("TypeError")
        expect(entries[0]!.level).toBe("error")
        expect(JSON.stringify(entries)).not.toContain(secret)
        return { valid: true, boundary: false }
      },
      50,
      { domain: "random secret in the exception message, both bucket routes", minValidFraction: 1, minBoundary: 0 }
    )
  })
})

/** A namespace whose `info()` also returns a token-bearing field, as `create()` results do. */
const leakyNamespace = (ns: ArtifactsNamespaceLike, secret: string): ArtifactsNamespaceLike => ({
  get: async (name) => {
    const repo = await ns.get(name)
    const info = repo.info
    return Object.assign(Object.create(Object.getPrototypeOf(repo) as object) as object, repo, {
      info: async () => ({ ...((await info!()) as object), token: secret, plaintext: secret })
    })
  }
})

describe("GET /api/artifacts (A1)", () => {
  const repoArb = fc.record({
    length: fc.integer({ min: 0, max: 30 }),
    merges: fc.uniqueArray(fc.integer({ min: 1, max: 29 }), { maxLength: 4 }),
    limit: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
    refKind: fc.constantFrom("default", "main", "HEAD", "commit", "unknown") as fc.Arbitrary<"default" | "main" | "HEAD" | "commit" | "unknown">,
    pick: fc.nat()
  })

  /** Build a repo; `length` 0 is a repo created but never pushed (no refs). */
  const build = (length: number, merges: ReadonlyArray<number>): { repo: FakeRepo; mainline: string[] } => {
    if (length === 0) return { repo: { commits: new Map(), refs: new Map(), defaultBranch: "main" }, mainline: [] }
    const r = makeRepo(length, { mergesAt: merges.filter((m) => m < length) })
    return { repo: r.repo, mainline: r.mainline }
  }

  it("A1 law: commits = first-parent chain of the ref, newest first, cut to limit; remote from info(); handle disposed; no token field", async () => {
    await lawAsync(
      "artifacts view",
      repoArb,
      async ({ length, merges, limit, refKind, pick }) => {
        const { repo, mainline } = build(length, merges)
        const ns = makeFakeNamespace({ demo: repo })
        const secret = "art_v1_SECRET_SHOULD_NOT_LEAK"
        const commitRef = mainline.length > 0 ? mainline[pick % mainline.length]! : "0".repeat(40)
        const ref = refKind === "default" ? null : refKind === "commit" ? commitRef : refKind === "unknown" ? "no-such-branch" : refKind
        const qs = new URLSearchParams({ repo: "demo", ...(ref !== null ? { ref } : {}), ...(limit !== undefined ? { limit: String(limit) } : {}) })
        const res = await handle(request(`/api/artifacts?${qs}`, READ), countingBucket().bucket, {
          scope: "trusted",
          token: Redacted.make(READ),
          artifacts: leakyNamespace(ns, secret),
          now: () => 0
        })
        expect(res.status).toBe(200)
        const text = await res.text()
        expect(text).not.toContain(secret)
        const body = JSON.parse(text) as { repo: string; remote: string; ref: string; defaultBranch: string; commits: Array<{ oid: string; message: string | null }> }
        const effectiveRef = ref ?? "main"
        const start = effectiveRef === "HEAD" || effectiveRef === "main" ? repo.refs.get("main") : repo.commits.has(effectiveRef) ? effectiveRef : undefined
        const chain = start === undefined ? [] : firstParentChain(repo, start)
        expect(body.repo).toBe("demo")
        expect(body.ref).toBe(effectiveRef)
        expect(body.defaultBranch).toBe("main")
        expect(body.remote).toBe("https://acct.artifacts.cloudflare.net/git/default/demo.git")
        expect(body.commits.map((c) => c.oid)).toEqual(chain.slice(0, limit ?? 10))
        expect(body.commits.map((c) => c.message)).toEqual(chain.slice(0, limit ?? 10).map((o) => repo.commits.get(o)!.message))
        expect(ns.opened()).toBe(1)
        expect(ns.disposed()).toBe(1)
        return { valid: chain.length > 0, boundary: chain.length === 0 || (limit !== undefined && limit <= chain.length && limit >= chain.length - 1) }
      },
      200,
      { domain: "0–30 commits with merges, limit 1–40 or default, ref default/main/HEAD/commit/unknown", minValidFraction: 0.5, minBoundary: 5 }
    )
  })

  it("unknown repo → 404 (get() throws); bad name or limit → 400; no binding → 404; never a 500", async () => {
    const ns = makeFakeNamespace({ demo: makeRepo(2).repo })
    const cfg: HandlerConfig = { scope: "trusted", token: Redacted.make(READ), artifacts: ns, now: () => 0 }
    const status = async (qs: string, c: HandlerConfig = cfg) => (await handle(request(`/api/artifacts${qs}`, READ), countingBucket().bucket, c)).status
    expect(await status("?repo=missing")).toBe(404)
    expect(ns.opened()).toBe(ns.disposed())
    for (const bad of ["", "?repo=", "?repo=-x", "?repo=a/b", "?repo=demo&limit=0", "?repo=demo&limit=1001", "?repo=demo&limit=1.5", "?repo=demo&limit=abc", "?repo=demo&ref="]) {
      expect(await status(bad), bad).toBe(400)
    }
    expect(await status("?repo=demo&limit=1000")).toBe(200)
    expect(await status("?repo=demo", { scope: "trusted", token: Redacted.make(READ), now: () => 0 })).toBe(404)
  })

  it("a log() failure is a 502 and the handle is still disposed", async () => {
    const ns = makeFakeNamespace({ demo: makeRepo(2).repo })
    const broken: ArtifactsNamespaceLike = {
      get: async (n) => {
        const r = await ns.get(n)
        return Object.assign(r, { log: async () => Promise.reject(new Error("upstream unavailable")) })
      }
    }
    const res = await handle(request("/api/artifacts?repo=demo", READ), countingBucket().bucket, { scope: "trusted", token: Redacted.make(READ), artifacts: broken, now: () => 0 })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "artifacts read failed" })
    expect(ns.disposed()).toBe(1)
  })

  it("A1 negation: the proposal's approach (log({ limit: 1 }) on the default ref) is refuted by the law", async () => {
    const proposal = (artifacts: ArtifactsNamespaceLike, q: ArtifactsQuery) =>
      Effect.promise(async () => {
        const repo = await artifacts.get(q.repo)
        const log = await repo.log({ limit: 1 })
        return log.length
      })
    const killed = await mutantKilledAsync(
      fc.record({ length: fc.integer({ min: 2, max: 20 }), limit: fc.integer({ min: 2, max: 20 }) }),
      async ({ length, limit }) => {
        const ns = makeFakeNamespace({ demo: makeRepo(length).repo })
        const want = await Effect.runPromise(viewArtifactsRepo(ns, { repo: "demo", ref: null, limit }))
        const got = await Effect.runPromise(proposal(ns, { repo: "demo", ref: null, limit }))
        return got === want.commits.length
      },
      20
    )
    expect(killed).toBe(true)
  })

  it("law: existing repos are always readable and the handle is always disposed", async () => {
    await lawAsync(
      "existing repos are readable",
      fc.record({ n: fc.integer({ min: 1, max: 12 }), limit: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 13 }), fc.integer({ min: 1, max: 1000 })) }),
      async ({ n, limit }) => {
        const ns = makeFakeNamespace({ demo: makeRepo(n).repo })
        const r = await Effect.runPromise(Effect.result(viewArtifactsRepo(ns, { repo: "demo", ref: null, limit })))
        expect(r._tag).toBe("Success")
        if (r._tag === "Success") expect(r.success.commits).toHaveLength(Math.min(n, limit))
        expect(ns.disposed()).toBe(ns.opened())
        return { valid: true, boundary: limit === n || limit === 1 }
      },
      60,
      { domain: "1–12 commits, limit 1–1000 (biased to 1 and to the history length)", minValidFraction: 1, minBoundary: 5 }
    )
  })
})
