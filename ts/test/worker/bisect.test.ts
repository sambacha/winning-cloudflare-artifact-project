/**
 * Bisection routes of the Worker (`src/worker/bisectRoutes.ts`) and the R2
 * session store (`src/worker/bisectStore.ts`).
 *
 * Requirements (abstract):
 * W1 A runner that only talks HTTP to the Worker (status → test `next` →
 *    post result) ends with the true culprit for a deterministic test, for
 *    any repository history and culprit.
 * W2 Results posted concurrently by several runners are all kept.
 * W3 `credentials` mints a *read* token through the Artifacts binding,
 *    returns the repo's remote, and disposes every handle.
 * W4 Every route requires the bearer token; malformed input is a 4xx with
 *    no state change; unknown sessions/repos are 404; invalid ranges 422.
 * W5 The R2 store creates only when absent and updates only when the stored
 *    ETag still matches (the Workers R2 `onlyIf` contract).
 * W6 Without an Artifacts binding the bisection routes do not exist and the
 *    read-only routes keep their GET-only behaviour.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilled, mutantKilledAsync } from "../harness.js"
import { handle, type HandlerConfig } from "../../src/worker/handler.js"
import { makeR2SessionStore, type R2PutOptionsLike, type R2WritableBucketLike, sessionKey } from "../../src/worker/bisectStore.js"
import { makeMemorySessionStore, makeSession, type SessionStore } from "../../src/bisect/session.js"
import { makeBisectApiClient } from "../../src/bisect/drive.js"
import { makeFakeNamespace, makeRepo } from "../bisect/fakeArtifacts.js"
import type { R2BucketLike } from "../../src/worker/r2Bucket.js"
import { errorResponse, handleBisect } from "../../src/worker/bisectRoutes.js"
import { ArtifactsApiError, CommitRangeError, InvalidModel, SessionConflict, SessionError } from "../../src/bisect/index.js"
import { Effect, Exit, Redacted, runPromiseOrThrow } from "../../src/fx/index.js"
import { SessionId } from "../../src/ids.js"
import { runVirtual } from "../bisect/run.js"

announce("test/worker/bisect.test.ts")

const TOKEN = "secret-token"
const emptyBucket: R2BucketLike = {
  list: async () => ({ objects: [], truncated: false }),
  get: async () => null
}

const req = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  new Request(`https://worker.example${path}`, {
    method,
    headers: { ...(token !== null ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  })

const setup = (len: number, store: SessionStore = makeMemorySessionStore()) => {
  const { repo, mainline } = makeRepo(len, { mergesAt: len > 4 ? [3] : [] })
  const artifacts = makeFakeNamespace({ proj: repo }, { idField: "id" })
  let ids = 0
  const cfg: HandlerConfig = {
    scope: "trusted",
    token: Redacted.make(TOKEN),
    now: () => 1000,
    bisect: { artifacts, store, now: () => 1000, newId: () => SessionId((++ids).toString(16).padStart(16, "0")) }
  }
  const call = async (method: string, path: string, body?: unknown, token?: string | null) => {
    const r = await handle(req(method, path, body, token), emptyBucket, cfg)
    return { status: r.status, body: (await r.json()) as Record<string, any>, headers: r.headers }
  }
  const cfgFetch = (url: string, init: RequestInit) => handle(new Request(url, init), emptyBucket, cfg)
  return { repo, mainline, artifacts, call, store, cfgFetch }
}

describe("bisection over HTTP", () => {
  it("law W1: an HTTP-only runner finds the culprit with a deterministic test", async () => {
    await lawAsync(
      "HTTP runner → culprit",
      fc.record({ len: fc.integer({ min: 3, max: 120 }), g: fc.nat(), c: fc.nat() }),
      async ({ len, g, c }) => {
        const { mainline, call, artifacts } = setup(len)
        const good = g % (len - 1)
        const culprit = good + 1 + (c % (len - 1 - good))
        const isBad = (oid: string) => mainline.indexOf(oid) >= culprit
        const start = await call("POST", "/api/bisect", {
          repo: "proj",
          good: mainline[good],
          bad: "main",
          newRate: { kind: "known", p: 1 },
          oldRate: { kind: "known", p: 0 },
          confidence: 1
        })
        expect(start.status).toBe(201)
        const id = start.body["id"] as SessionId
        let st = start.body["status"]
        let runs = 0
        while (!st.done) {
          runs++
          const r = await call("POST", `/api/bisect/${id}/results`, { commit: st.next.oid, result: isBad(st.next.oid) ? "fail" : "pass" })
          expect(r.status).toBe(200)
          st = r.body["status"]
        }
        expect(st.culprit.oid).toBe(mainline[culprit])
        expect(runs).toBeLessThanOrEqual(Math.ceil(Math.log2(len - 1 - good)))
        expect((await call("GET", `/api/bisect/${id}`)).body["status"]).toEqual(st)
        expect(artifacts.disposed()).toBe(artifacts.opened())
        return { valid: true, boundary: culprit === good + 1 || culprit === len - 1 }
      },
      40,
      { domain: "histories of 3–120 commits (with a merge), any good commit and culprit", minValidFraction: 1, minBoundary: 4 }
    )
  })

  it("law W2: concurrent posts never lose a result; with the retrying client all land", async () => {
    await lawAsync(
      "concurrent posts",
      fc.oneof(fc.constantFrom(2, 10), fc.integer({ min: 2, max: 10 })),
      async (k) => {
        const { mainline, call, cfgFetch } = setup(30)
        const id = (await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main" })).body["id"] as SessionId
        // (a) Raw requests: each one is either recorded (200) or refused with 409 + Retry-After, never silently dropped.
        const res = await Promise.all(
          Array.from({ length: k }, (_, i) => call("POST", `/api/bisect/${id}/results`, { commit: mainline[1 + i]!.slice(0, 10), result: i % 2 ? "fail" : "pass" }))
        )
        res.forEach((r) => {
          expect([200, 409]).toContain(r.status)
          if (r.status === 409) expect(r.headers.get("retry-after")).toBe("1")
        })
        const accepted = res.filter((r) => r.status === 200).length
        expect((await call("GET", `/api/bisect/${id}`)).body["status"].observations).toBe(accepted)
        // (b) Through the client, which retries 409/503: all k land.
        const client = makeBisectApiClient({ baseUrl: "https://worker.example", token: TOKEN, fetch: cfgFetch })
        const posted = await runVirtual(
          Effect.all(
            Array.from({ length: k }, (_, i) => client.result(id, mainline[1 + i]!, i % 2 ? "fail" : "pass")),
            { concurrency: "unbounded" }
          )
        )
        expect(Exit.isSuccess(posted)).toBe(true)
        expect((await runPromiseOrThrow(client.status(id))).status.observations).toBe(accepted + k)
        return { valid: true, boundary: k === 2 || k === 10 }
      },
      20,
      { domain: "2–10 simultaneous posts on one session", minValidFraction: 1, minBoundary: 1 }
    )
  })

  it("law W3: credentials are a read token for the session's repo, with its remote", async () => {
    const { mainline, call, artifacts } = setup(10)
    const id = (await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main" })).body["id"] as SessionId
    const r = await call("POST", `/api/bisect/${id}/credentials`)
    expect(r.status).toBe(200)
    expect(artifacts.tokens.at(-1)).toMatchObject({ repo: "proj", scope: "read", ttl: 3600 })
    expect(r.body["token"]).toBe(artifacts.tokens.at(-1)!.plaintext)
    expect(r.body["remote"]).toMatch(/\/proj\.git$/)
    expect(r.body["commit"]).toBe((await call("GET", `/api/bisect/${id}`)).body["status"].next.oid)
    expect(artifacts.disposed()).toBe(artifacts.opened())
  })

  it("regression W4 (recorded): validation and error statuses of the bisection routes (auth: see the law below)", async () => {
    const { mainline, call, store } = setup(10)
    expect((await call("POST", "/api/bisect", "not json")).status).toBe(400)
    expect((await call("POST", "/api/bisect", { repo: "proj", good: 1, bad: "main" })).status).toBe(400)
    expect((await call("POST", "/api/bisect", { repo: "-x", good: mainline[0], bad: "main" })).status).toBe(400)
    expect((await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main", newRate: { kind: "known", p: 3 } })).status).toBe(400)
    expect((await call("POST", "/api/bisect", { repo: "nosuch", good: mainline[0], bad: "main" })).status).toBe(404)
    expect((await call("POST", "/api/bisect", { repo: "proj", good: mainline[5], bad: mainline[2] })).status).toBe(422)
    const id = (await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main" })).body["id"] as SessionId
    const before = await runPromiseOrThrow(store.load(id))
    expect((await call("POST", `/api/bisect/${id}/results`, { commit: "zzzzzzzz", result: "fail" })).status).toBe(400)
    expect((await call("POST", `/api/bisect/${id}/results`, { commit: mainline[3], result: "maybe" })).status).toBe(400)
    expect((await call("POST", `/api/bisect/${id}/undo`)).status).toBe(400)
    expect(await runPromiseOrThrow(store.load(id))).toEqual(before)
    expect((await call("GET", "/api/bisect/0123456789abcdef")).status).toBe(404)
    expect((await call("GET", "/api/bisect/NOT-AN-ID")).status).toBe(400)
    expect((await call("DELETE", `/api/bisect/${id}`)).status).toBe(405)
    expect((await call("POST", `/api/bisect/${id}/frobnicate`)).status).toBe(404)
  })
})

/** In-memory bucket implementing the Workers R2 `onlyIf` contract used by the store. */
const makeConditionalBucket = () => {
  const objects = new Map<string, { body: string; etag: string }>()
  let n = 0
  const bucket: R2WritableBucketLike = {
    get: async (key) => {
      const o = objects.get(key)
      return o === undefined ? null : { etag: o.etag, text: async () => o.body }
    },
    put: async (key: string, value: string, options?: R2PutOptionsLike) => {
      const cur = objects.get(key)
      const c = options?.onlyIf
      if (c instanceof Headers) {
        if (c.get("If-None-Match") === "*" && cur !== undefined) return null
      } else if (c?.etagMatches !== undefined && cur?.etag !== c.etagMatches) return null
      const etag = `etag-${++n}`
      objects.set(key, { body: value, etag })
      return { etag }
    }
  }
  return { bucket, objects }
}

describe("R2 session store (W5)", () => {
  it("law W5: create-if-absent and update-if-ETag-matches", async () => {
    await lawAsync(
      "conditional store",
      fc.array(fc.constantFrom("create", "update-fresh", "update-stale"), { minLength: 1, maxLength: 15 }),
      async (ops) => {
        const { bucket, objects } = makeConditionalBucket()
        const store = makeR2SessionStore(bucket, "trusted")
        const s = makeSession({ repo: "r", goodRef: "g", badRef: "b", good: { oid: "g".repeat(8) }, candidates: [{ oid: "c".repeat(8) }], now: 0 })
        let exists = false
        const SID = SessionId("abcdef0123")
        let staleVersion = "never"
        for (const op of ops) {
          const cur = await runPromiseOrThrow(store.load(SID))
          if (op === "create") {
            expect(await runPromiseOrThrow(store.create(SID, s))).toBe(!exists)
            exists = true
          } else if (cur === null) {
            expect(await runPromiseOrThrow(store.update(SID, s, "x"))).toBe(false)
          } else if (op === "update-fresh") {
            staleVersion = cur.version
            expect(await runPromiseOrThrow(store.update(SID, { ...s, createdAt: cur.session.createdAt + 1 }, cur.version))).toBe(true)
          } else {
            expect(await runPromiseOrThrow(store.update(SID, s, staleVersion))).toBe(false)
          }
        }
        if (exists) expect([...objects.keys()]).toEqual([sessionKey("trusted", SID)])
        return { valid: ops.includes("create"), boundary: ops.length === 1 }
      },
      100,
      { domain: "≤ 15 create / fresh update / stale update operations", minValidFraction: 0.5, minBoundary: 1 }
    )
  })
})

describe("routes without an Artifacts binding (W6)", () => {
  it("law W6: /api/bisect is 405/404 territory of the read-only API", async () => {
    const cfg: HandlerConfig = { scope: "trusted", token: Redacted.make(TOKEN), now: () => 0 }
    expect((await handle(req("POST", "/api/bisect", { repo: "x" }), emptyBucket, cfg)).status).toBe(405)
    expect((await handle(req("GET", "/api/bisect/abcdef01"), emptyBucket, cfg)).status).toBe(404)
  })
})

/*
 * W4 (auth) as a rule: EVERY request — any method, any path, inside or
 * outside the bisection routes — without exactly `Authorization: Bearer
 * <token>` is answered 401 and changes nothing (no session written, no
 * repository opened). The previous test checked one route (POST
 * /api/bisect) with two bad tokens, i.e. an example standing in for "every
 * route".
 */
const ROUTES = ["/api/bisect", "/api/bisect/{id}", "/api/bisect/{id}/results", "/api/bisect/{id}/undo", "/api/bisect/{id}/credentials", "/api/bisect/{id}/x", "/api/locks?context=c", "/api/cache", "/api/other", "/"]
const authCase = fc.record({
  method: fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH"),
  route: fc.constantFrom(...ROUTES),
  header: fc.oneof(
    fc.constant<string | null>(null),
    fc.constantFrom(`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, TOKEN, `Bearer  ${TOKEN}`, `Bearer ${TOKEN}\u00a0`, "Bearer "),
    fc.string({ maxLength: 30 }).map((t) => `Bearer ${t}`)
  )
  // HTTP strips leading/trailing whitespace from header values (Fetch "normalize"), so a value that
  // trims to the exact credential IS the credential; such values are not "other tokens".
}).filter((c) => c.header === null || c.header.replace(/^[\t ]+|[\t ]+$/g, "") !== `Bearer ${TOKEN}`)
type Handler = typeof handle
/** Mutant 1: the bisection routes are dispatched before the token check. */
const bisectBeforeAuth: Handler = async (request, bucket, cfg) => {
  if (cfg.bisect !== undefined) {
    const r = await handleBisect(request.clone() as Request, cfg.bisect)
    if (r !== null) return r
  }
  return handle(request, bucket, cfg)
}
/** Mutant 2: the token is compared as a prefix. */
const prefixToken: Handler = async (request, bucket, cfg) => {
  const h = request.headers.get("authorization") ?? ""
  if (h !== `Bearer ${Redacted.value(cfg.token)}` && h.startsWith(`Bearer ${Redacted.value(cfg.token)}`)) {
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${Redacted.value(cfg.token)}`)
    return handle(new Request(request, { headers }), bucket, cfg)
  }
  return handle(request, bucket, cfg)
}

/** Run one unauthenticated request through `impl`; true iff it was refused with 401 and nothing changed. */
const refusedWithoutEffect = async (impl: Handler, c: { method: string; route: string; header: string | null }): Promise<boolean> => {
  const { mainline, call, store, artifacts } = setup(8)
  const id = (await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main" })).body["id"] as SessionId
  const before = JSON.stringify(await runPromiseOrThrow(store.load(id)))
  const opened = artifacts.opened()
  const path = c.route.replace("{id}", id)
  const body = c.method === "GET" ? undefined : JSON.stringify(path.endsWith("/results") ? { commit: mainline[3], result: "fail" } : { repo: "proj", good: mainline[0], bad: "main" })
  const headers: Record<string, string> = c.header === null ? {} : { authorization: c.header }
  const cfg: HandlerConfig = { scope: "trusted", token: Redacted.make(TOKEN), now: () => 1000, bisect: { artifacts, store, now: () => 1000 } }
  const r = await impl(new Request(`https://worker.example${path}`, { method: c.method, headers, ...(body !== undefined ? { body } : {}) }), emptyBucket, cfg)
  return r.status === 401 && JSON.stringify(await runPromiseOrThrow(store.load(id))) === before && artifacts.opened() === opened
}

describe("authentication on every route (W4)", () => {
  it("law W4: any method × any route × any token other than the configured one → 401, no state change", async () => {
    await lawAsync(
      "every route requires the exact bearer token",
      authCase,
      async (c) => {
        expect(await refusedWithoutEffect(handle, c), JSON.stringify(c)).toBe(true)
        return { valid: true, boundary: c.header !== null && c.header.includes(TOKEN) }
      },
      200,
      { domain: "5 methods × 10 routes (bisection, read-only, unknown) × missing / near-miss / random tokens", minValidFraction: 1, minBoundary: 20 }
    )
    // Control: with the exact token the same routes are not refused.
    const { call } = setup(5)
    for (const r of ["/api/cache", "/api/bisect/0123456789abcdef", "/api/other"]) expect((await call("GET", r)).status).not.toBe(401)
  })

  it("W4 counterexample 1 (mutant: bisection routes before auth): POST /api/bisect/<id>/undo without a token", async () => {
    const c = { method: "POST", route: "/api/bisect/{id}/undo", header: null }
    expect(await refusedWithoutEffect(handle, c)).toBe(true)
    expect(await refusedWithoutEffect(bisectBeforeAuth, c)).toBe(false)
  })

  it("W4 counterexample 2 (mutant: prefix comparison): GET /api/cache with the token plus one character", async () => {
    const c = { method: "GET", route: "/api/cache", header: `Bearer ${TOKEN}x` }
    expect(await refusedWithoutEffect(handle, c)).toBe(true)
    expect(await refusedWithoutEffect(prefixToken, c)).toBe(false)
  })

  it("W4 negation 1: the law is refuted for the bisection-before-auth mutant", async () => {
    expect(await mutantKilledAsync(authCase, (c) => refusedWithoutEffect(bisectBeforeAuth, c), 100)).toBe(true)
  })

  it("W4 negation 2: the law is refuted for the prefix-comparison mutant", async () => {
    expect(await mutantKilledAsync(authCase, (c) => refusedWithoutEffect(prefixToken, c), 100)).toBe(true)
  })
})

/*
 * Error classification as a rule: protocol errors map by type (409
 * conflict, 400 invalid input, 422 invalid range); an upstream error is 404
 * iff it carries the documented NOT_FOUND / 10200 identifier, 503 (retry)
 * iff it is a 429 / "too many requests" / "rate limit", and 502 otherwise.
 *
 * The previous mapping matched free text that the test fake happens to
 * produce: `/NOT_FOUND|10200|does not exist/` and `/rate|429|too many/i`.
 * Any upstream message containing "rate" ("generate", "separate", a repo
 * named "rate-tools") became a retryable 503, and any "does not exist" a
 * 404. No test exercised a message outside the fake's vocabulary.
 */
const WORDS = ["generate", "separate", "accurate", "rate-tools", "does not exist", "NOT_FOUND", "10200", "429", "too many requests", "rate limit", "Rate-Limited", "timeout", "pack", "internal", "bucket", "NOT_FOUNDATION", "104290"]
const upstreamError = fc.record({
  kind: fc.constantFrom("plain", "coded", "rest"),
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }),
  code: fc.constantFrom<unknown>(undefined, "NOT_FOUND", 10200, 429, "INTERNAL", 10401),
  status: fc.constantFrom(400, 404, 409, 429, 500, 503),
  entry: fc.constantFrom(10200, 10401, 10100)
})
type UpstreamCase = { kind: string; words: string[]; code: unknown; status: number; entry: number }
const buildError = (u: UpstreamCase): Error => {
  const msg = u.words.join(" ")
  if (u.kind === "rest") return new ArtifactsApiError(u.status, [{ code: u.entry, message: msg }], "GET", "/repos/x")
  const e = new Error(msg)
  if (u.kind === "coded") (e as Error & { code?: unknown }).code = u.code
  return e
}
/** Oracle from the rule, written independently of the implementation. */
const expectedStatus = (u: UpstreamCase): number => {
  const msg = u.kind === "rest" ? `GET /repos/x failed with HTTP ${u.status}: ${u.entry} ${u.words.join(" ")}` : u.words.join(" ")
  const words = msg.split(/[^A-Za-z0-9_]+/)
  const code = u.kind === "coded" ? u.code : undefined
  const notFound = u.kind === "rest" ? u.status === 404 || u.entry === 10200 : code === "NOT_FOUND" || code === 10200 || words.includes("NOT_FOUND") || words.includes("10200")
  if (notFound) return 404
  const limited = u.kind === "rest" ? u.status === 429 : code === 429 || words.includes("429") || /too many requests|rate[- ]?limit/i.test(msg)
  return limited ? 503 : 502
}
/** Mutant 1: the previous free-text classifier. */
const oldClassifier = (e: unknown): number => {
  const msg = e instanceof Error ? e.message : String(e)
  if (/NOT_FOUND|10200|does not exist/.test(msg)) return 404
  if (/rate|429|too many/i.test(msg)) return 503
  return 502
}
/** Mutant 2: no classification of upstream errors (every one is 502). */
const noClassifier = (_e: unknown): number => 502

describe("upstream error classification", () => {
  it("law: 404 iff NOT_FOUND/10200, 503 iff 429/rate limit, else 502 — for any message text", async () => {
    let free = 0
    law(
      "errorResponse classifies by documented identifiers only",
      upstreamError,
      (u) => {
        const got = errorResponse(buildError(u)).status
        expect(got, JSON.stringify(u)).toBe(expectedStatus(u))
        if (expectedStatus(u) === 502) free++
        return { valid: true, boundary: u.words.some((w) => ["generate", "separate", "does not exist", "NOT_FOUNDATION", "104290"].includes(w)) }
      },
      400,
      { domain: "plain / coded / REST errors whose messages mix documented identifiers with look-alike free text", minValidFraction: 1, minBoundary: 50 }
    )
    expect(free).toBeGreaterThan(20)
    // Protocol errors keep their type-based mapping.
    expect(errorResponse(new SessionConflict("x")).status).toBe(409)
    expect(errorResponse(new SessionError("rate limit")).status).toBe(400)
    expect(errorResponse(new InvalidModel("x")).status).toBe(400)
    expect(errorResponse(new CommitRangeError("NOT_FOUND")).status).toBe(422)
  })

  it("counterexample 1 (mutant: free-text classifier): \"failed to generate pack\" is a 502, not a retryable 503", () => {
    const e = new Error("failed to generate pack for repo separate-tools")
    expect(errorResponse(e).status).toBe(502)
    expect(oldClassifier(e)).toBe(503)
    const missingBinding = new Error("bucket binding COBUILD_BUCKET does not exist")
    expect(errorResponse(missingBinding).status).toBe(502)
    expect(oldClassifier(missingBinding)).toBe(404)
  })

  it("counterexample 2 (mutant: no classification): a REST 429 must be a retryable 503", () => {
    const e = new ArtifactsApiError(429, [], "GET", "/repos/x/log")
    expect(errorResponse(e).status).toBe(503)
    expect(errorResponse(e).headers.get("retry-after")).toBe("1")
    expect(noClassifier(e)).toBe(502)
  })

  it("negation 1: the law is refuted for the free-text classifier", () => {
    expect(mutantKilled(upstreamError, (u) => oldClassifier(buildError(u)) === expectedStatus(u), 300)).toBe(true)
  })

  it("negation 2: the law is refuted for the non-classifying mapping", () => {
    expect(mutantKilled(upstreamError, (u) => noClassifier(buildError(u)) === expectedStatus(u), 300)).toBe(true)
  })
})
