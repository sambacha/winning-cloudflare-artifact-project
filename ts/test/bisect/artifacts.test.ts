/**
 * Cloudflare Artifacts adapters for bisection.
 *
 * Requirements (stated without reference to any test value):
 * A1 The candidate range is the first-parent chain of the bad ref, strictly
 *    after the good commit, oldest first — for any history (including
 *    merges), any page boundary, any accepted commit-id field name, and a
 *    good ref given either as a ref name or as a full hash.
 * A2 A good commit that is not on that chain, an unresolvable ref, or equal
 *    good/bad commits are errors, never an empty or wrong range.
 * A3 Every repository handle obtained through `withRepo` is disposed exactly
 *    once, whether the callback succeeds or throws.
 * A4 `normalizeCommit` accepts a commit id under any documented-candidate
 *    field and rejects records with none of them.
 * A5 The REST client returns the same data as the binding for the same
 *    repository, authenticates every request, and encodes every parameter.
 * A6 The REST client retries exactly the retriable failures (409 except
 *    ALREADY_EXISTS, 429, 5xx, IMPORT/FORK_IN_PROGRESS, UPSTREAM_UNAVAILABLE)
 *    up to its attempt budget, waits `Retry-After` when given and an
 *    exponential delay otherwise, and fails at once on anything else.
 * A7 Local validation follows the documented limits (repo names, namespace
 *    names, token TTL range, log page size).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilledAsync } from "../harness.js"
import {
  ArtifactsApiError,
  ArtifactsShapeError,
  ArtifactsTransportError,
  checkLogLimit,
  checkNamespaceName,
  checkRepoName,
  checkTokenTtl,
  COMMIT_ID_FIELDS,
  CommitRangeError,
  InvalidArtifactsName,
  LOG_PAGE_LIMIT,
  makeArtifactsRestClient,
  normalizeCommit,
  parseRetryAfter,
  TOKEN_TTL_MAX_S,
  TOKEN_TTL_MIN_S
} from "../../src/bisect/index.js"
import { checkoutCredentials, commitRange, runVirtual, withRepo } from "./run.js"
import { firstParentChain, type IdField, makeFakeNamespace, makeRepo, makeRestFetch } from "./fakeArtifacts.js"
import { Cause, Duration, Effect, Exit, Fiber, Option } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"

announce("test/bisect/artifacts.test.ts")

const idFields: ReadonlyArray<IdField> = ["oid", "id", "hash", "sha"]

/** A random history: main line length, merge positions, a good/bad pair on the main line. */
const historyArb = fc
  .record({
    len: fc.oneof(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 990, max: 2300 })),
    mergeEvery: fc.integer({ min: 2, max: 9 }),
    sideLength: fc.integer({ min: 1, max: 3 }),
    salt: fc.integer({ min: 1, max: 1_000_000 }),
    idField: fc.constantFrom(...idFields),
    goodAsHash: fc.boolean(),
    a: fc.double({ min: 0, max: 1, noNaN: true }),
    b: fc.double({ min: 0, max: 1, noNaN: true })
  })
  .map((h) => {
    const good = Math.min(h.len - 2, Math.floor(h.a * (h.len - 1)))
    const bad = Math.min(h.len - 1, good + 1 + Math.floor(h.b * (h.len - 1 - good)))
    return { ...h, good, bad }
  })

describe("commit range over the Artifacts binding (A1, A2, A3)", () => {
  it("law A1: range = first-parent commits after good up to bad, oldest first", async () => {
    await lawAsync(
      "commitRange = first-parent chain (bad, good]",
      historyArb,
      async (h) => {
        const mergesAt = Array.from({ length: h.len }, (_, i) => i).filter((i) => i > 0 && i % h.mergeEvery === 0)
        const { repo, mainline } = makeRepo(h.len, { mergesAt, sideLength: h.sideLength, salt: h.salt })
        repo.refs.set("good-ref", mainline[h.good]!)
        repo.refs.set("bad-ref", mainline[h.bad]!)
        const ns = makeFakeNamespace({ r: repo }, { idField: h.idField })
        const goodRef = h.goodAsHash ? mainline[h.good]! : "good-ref"
        const range = await withRepo(ns, "r", (handle) => commitRange(handle, goodRef, "bad-ref"))
        // Expected from the repository's own structure, not from the code under test.
        const chain = firstParentChain(repo, mainline[h.bad]!)
        const expected = chain.slice(0, chain.indexOf(mainline[h.good]!)).reverse()
        expect(range.map((c) => c.oid)).toEqual(expected)
        expect(ns.disposed()).toBe(ns.opened())
        for (const call of ns.logCalls) expect(call.limit ?? 50).toBeLessThanOrEqual(LOG_PAGE_LIMIT)
        return { valid: true, boundary: h.bad - h.good === 1 || h.bad - h.good >= LOG_PAGE_LIMIT }
      },
      60,
      { domain: "main line 2–60 or 990–2300 commits, merges every 2–9, good/bad anywhere, all id field names", minValidFraction: 1, minBoundary: 3 }
    )
  })

  it("law A2: off-chain good commits, unresolvable refs and equal endpoints are errors", async () => {
    await lawAsync(
      "commitRange rejects invalid ranges",
      fc.record({ len: fc.integer({ min: 3, max: 40 }), pick: fc.nat(), kind: fc.constantFrom("reversed", "side", "unknown-good", "unknown-bad", "equal") }),
      async ({ len, pick, kind }) => {
        const { repo, mainline, sideCommits } = makeRepo(len, { mergesAt: [2], sideLength: 2 })
        const ns = makeFakeNamespace({ r: repo })
        const i = 1 + (pick % (len - 1))
        const args: Record<string, [string, string]> = {
          reversed: [mainline[i]!, mainline[i - 1]!],
          side: [sideCommits[0]!, mainline.at(-1)!],
          "unknown-good": ["no-such-ref", "main"],
          "unknown-bad": [mainline[0]!, "no-such-ref"],
          equal: [mainline[i]!, mainline[i]!]
        }
        const [g, b] = args[kind]!
        await expect(withRepo(ns, "r", (h) => commitRange(h, g, b))).rejects.toThrow(CommitRangeError)
        expect(ns.disposed()).toBe(ns.opened())
        return { valid: true, boundary: kind === "equal" || kind === "side" }
      },
      60,
      { domain: "five kinds of invalid range on histories with a merge", minValidFraction: 1, minBoundary: 5 }
    )
  })

  it("law A3: withRepo disposes the handle exactly once, also when the callback throws", async () => {
    await lawAsync(
      "withRepo disposes",
      fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
      async (throws) => {
        const { repo } = makeRepo(3)
        const ns = makeFakeNamespace({ r: repo })
        for (const t of throws) {
          const p = withRepo(ns, "r", async (h) => {
            await h.log({ limit: 1 })
            if (t) throw new Error("callback failed")
            return 1
          })
          if (t) await expect(p).rejects.toThrow("callback failed")
          else await expect(p).resolves.toBe(1)
        }
        expect(ns.opened()).toBe(throws.length)
        expect(ns.disposed()).toBe(throws.length)
        return { valid: true, boundary: throws.every((t) => t) || throws.every((t) => !t) }
      },
      50,
      { domain: "1–12 sequential uses, each succeeding or throwing", minValidFraction: 1, minBoundary: 2 }
    )
  })

  it("withRepo refuses invalid repo names before calling get()", async () => {
    const ns = makeFakeNamespace({})
    await expect(withRepo(ns, "-bad", async () => 1)).rejects.toThrow(InvalidArtifactsName)
    expect(ns.opened()).toBe(0)
  })

  it("mutant: a range adapter that ignores the good commit's position is caught", async () => {
    const killed = await mutantKilledAsync(
      historyArb,
      async (h) => {
        const { repo, mainline } = makeRepo(h.len, { salt: h.salt })
        repo.refs.set("good-ref", mainline[h.good]!)
        repo.refs.set("bad-ref", mainline[h.bad]!)
        const ns = makeFakeNamespace({ r: repo })
        // Mutant: take the first page of the bad ref and drop the last entry (the proposal's sketch).
        const page = await withRepo(ns, "r", (r) => r.log({ ref: "bad-ref", limit: LOG_PAGE_LIMIT }))
        const mutant = page.slice(0, -1).map((c) => normalizeCommit(c).oid).reverse()
        const chain = firstParentChain(repo, mainline[h.bad]!)
        return JSON.stringify(mutant) === JSON.stringify(chain.slice(0, chain.indexOf(mainline[h.good]!)).reverse())
      },
      40
    )
    expect(killed).toBe(true)
  })
})

describe("commit record normalisation (A4)", () => {
  it("law A4: the id is read from any accepted field; records without one are rejected", () => {
    law(
      "normalizeCommit",
      fc.record({
        field: fc.constantFrom(...COMMIT_ID_FIELDS, "commit", "ref", "name"),
        id: fc.string({ minLength: 0, maxLength: 45 }),
        message: fc.option(fc.string(), { nil: undefined })
      }),
      ({ field, id, message }) => {
        const raw = { [field]: id, ...(message !== undefined ? { message } : {}) }
        const accepted = (COMMIT_ID_FIELDS as ReadonlyArray<string>).includes(field) && id.length > 0
        if (accepted) {
          const c = normalizeCommit(raw)
          expect(c.oid).toBe(id)
          if (message !== undefined && message.length > 0) expect(c.message).toBe(message)
        } else {
          expect(() => normalizeCommit(raw)).toThrow(ArtifactsShapeError)
        }
        return { valid: true, boundary: id.length === 0 || !accepted }
      },
      300,
      { domain: "id under 7 field names (4 accepted), empty and non-empty ids", minValidFraction: 1, minBoundary: 20 }
    )
    for (const bad of [null, 3, "x", [], [{ oid: "a" }]]) expect(() => normalizeCommit(bad)).toThrow(ArtifactsShapeError)
  })
})

describe("documented limits (A7)", () => {
  it("names, TTLs and page sizes are validated by the documented rules", () => {
    law(
      "validators match the documented rules",
      fc.record({
        name: fc.string({ minLength: 0, maxLength: 70 }),
        ttl: fc.oneof(fc.integer({ min: -10, max: 100 }), fc.integer({ min: TOKEN_TTL_MAX_S - 5, max: TOKEN_TTL_MAX_S + 5 }), fc.integer()),
        limit: fc.integer({ min: -5, max: 1100 })
      }),
      ({ name, ttl, limit }) => {
        const nameOk = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
        if (nameOk) expect(checkRepoName(name)).toBe(name)
        else expect(() => checkRepoName(name)).toThrow(InvalidArtifactsName)
        const nsOk = nameOk && name.length >= 2 && name.length <= 63
        if (nsOk) expect(checkNamespaceName(name)).toBe(name)
        else expect(() => checkNamespaceName(name)).toThrow(InvalidArtifactsName)
        const ttlOk = ttl >= TOKEN_TTL_MIN_S && ttl <= TOKEN_TTL_MAX_S
        if (ttlOk) expect(checkTokenTtl(ttl)).toBe(ttl)
        else expect(() => checkTokenTtl(ttl)).toThrow(RangeError)
        const limitOk = limit >= 1 && limit <= LOG_PAGE_LIMIT
        if (limitOk) expect(checkLogLimit(limit)).toBe(limit)
        else expect(() => checkLogLimit(limit)).toThrow(RangeError)
        return { valid: true, boundary: [TOKEN_TTL_MIN_S - 1, TOKEN_TTL_MIN_S, TOKEN_TTL_MAX_S, TOKEN_TTL_MAX_S + 1].includes(ttl) || limit === 1000 || limit === 1001 || limit === 0 }
      },
      500,
      { domain: "arbitrary strings ≤ 70 chars, TTLs around both bounds, limits −5…1100", minValidFraction: 1, minBoundary: 5 }
    )
  })
})

describe("REST client (A5, A6)", () => {
  const cfg = { accountId: "abc123", namespace: "default", apiToken: "cf-token-xyz" }

  it("law A5: REST results equal the binding's for the same repository; every request is authenticated", async () => {
    await lawAsync(
      "REST client ≡ binding",
      fc.record({
        len: fc.integer({ min: 2, max: 1500 }),
        idField: fc.constantFrom(...idFields),
        good: fc.nat(),
        ttl: fc.integer({ min: TOKEN_TTL_MIN_S, max: TOKEN_TTL_MAX_S })
      }),
      async ({ len, idField, good, ttl }) => {
        const { repo, mainline } = makeRepo(len, { mergesAt: [1], sideLength: 1 })
        const g = good % (len - 1)
        const ns = makeFakeNamespace({ "repo.name_1": repo }, { idField, accountId: cfg.accountId })
        const { fetch, requests } = makeRestFetch(ns, cfg)
        const rest = makeArtifactsRestClient({ ...cfg, fetch })
        const viaRest = await withRepo(rest, "repo.name_1", (h) => commitRange(h, mainline[g]!, "main"))
        const viaBinding = await withRepo(ns, "repo.name_1", (h) => commitRange(h, mainline[g]!, "main"))
        expect(viaRest).toEqual(viaBinding)
        const creds = await withRepo(rest, "repo.name_1", (h) => checkoutCredentials(h, "read", Duration.seconds(ttl)))
        expect(creds.remote).toContain("/repo.name_1.git")
        expect(ns.tokens.at(-1)).toMatchObject({ scope: "read", ttl })
        expect(creds.token.plaintext).toBe(ns.tokens.at(-1)!.plaintext)
        // The TTL is sent as whole seconds: a fractional number of seconds is refused before any token is minted.
        const minted = ns.tokens.length
        await expect(withRepo(rest, "repo.name_1", (h) => checkoutCredentials(h, "read", Duration.millis(ttl * 1000 + 500)))).rejects.toThrow(RangeError)
        expect(ns.tokens.length).toBe(minted)
        for (const r of requests) expect(r.headers["authorization"]).toBe(`Bearer ${cfg.apiToken}`)
        return { valid: true, boundary: len - g > LOG_PAGE_LIMIT || g === len - 2 }
      },
      30,
      { domain: "histories of 2–1500 commits with a merge, any id field, TTL in the documented range", minValidFraction: 1, minBoundary: 2 }
    )
  })

  it("readCommit returns null for a missing commit (404 / NOT_FOUND) and get() fails for a missing repo", async () => {
    const { repo } = makeRepo(3)
    const ns = makeFakeNamespace({ r: repo })
    const { fetch } = makeRestFetch(ns, cfg)
    const rest = makeArtifactsRestClient({ ...cfg, fetch })
    const h = await rest.get("r")
    await expect(h.readCommit!("f".repeat(40))).resolves.toBeNull()
    const err = await rest.get("missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ArtifactsApiError)
    expect((err as ArtifactsApiError).hasCode(10200)).toBe(true)
  })

  it("law A6: retriable failures are retried up to the budget with the documented delays; others fail at once", async () => {
    const retriable = new Set(["409", "429", "500", "503", "10302", "10303", "10401"])
    await lawAsync(
      "retry policy",
      fc.record({
        failure: fc.constantFrom("409", "409-exists", "429", "500", "503", "500-10400", "10302", "10303", "10401", "400", "401-code", "404", "10100"),
        failCount: fc.integer({ min: 0, max: 6 }),
        maxAttempts: fc.integer({ min: 1, max: 5 }),
        retryAfter: fc.option(fc.integer({ min: 0, max: 30 }), { nil: undefined }),
        base: fc.integer({ min: 1, max: 1000 })
      }),
      async ({ failure, failCount, maxAttempts, retryAfter, base }) => {
        const { repo } = makeRepo(2)
        const ns = makeFakeNamespace({ r: repo })
        let injected = 0
        const status = (f: string) =>
          f === "409-exists" ? { status: 409, code: 10201 } : f === "500-10400" ? { status: 500, code: 10400 } : /^\d{3}$/.test(f) ? { status: Number(f), code: 0 } : f === "401-code" ? { status: 403, code: 10000 } : { status: f === "10100" ? 400 : 409, code: Number(f) }
        const { fetch } = makeRestFetch(ns, {
          ...cfg,
          faults: () => (injected < failCount ? (injected++, { ...status(failure), ...(retryAfter !== undefined ? { retryAfter: String(retryAfter) } : {}) }) : null)
        })
        const delays: number[] = []
        const rest = makeArtifactsRestClient({
          ...cfg,
          fetch,
          maxAttempts,
          baseDelay: Duration.millis(base),
          onRetry: (retry) => {
            delays.push(Duration.toMillis(retry.delay))
          }
        })
        const isRetriable = retriable.has(failure)
        const exit = await runVirtual(rest.request("GET", "/repos/r"))
        const expectSuccess = failCount === 0 || (isRetriable && failCount < maxAttempts)
        expect(Exit.isSuccess(exit)).toBe(expectSuccess)
        if (Exit.isFailure(exit)) {
          const fails = exit.cause.reasons.filter(Cause.isFailReason)
          expect(fails.length > 0 && fails.every((r) => r.error instanceof ArtifactsApiError)).toBe(true)
        }
        const expectedRetries = isRetriable ? Math.min(failCount, maxAttempts - 1) : 0
        expect(delays.length).toBe(expectedRetries)
        delays.forEach((ms, i) => {
          expect(ms).toBe(retryAfter !== undefined ? Math.max(retryAfter * 1000, base * 2 ** i) : base * 2 ** i)
        })
        return { valid: failCount > 0, boundary: failCount === maxAttempts || failCount === maxAttempts - 1 }
      },
      300,
      { domain: "13 failure kinds (7 retriable; INTERNAL_ERROR at HTTP 500 is not), 0–6 injected failures, budget 1–5, with/without Retry-After", minValidFraction: 0.7, minBoundary: 20 }
    )
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter("-1")).toBeUndefined()
    expect(parseRetryAfter("2")).toEqual(Duration.seconds(2))
  })

  it("transport errors are not retried: one attempt, no planned retry, the typed transport error", async () => {
    let calls = 0
    const retries: number[] = []
    const rest = makeArtifactsRestClient({
      ...cfg,
      fetch: () => {
        calls++
        return Promise.reject(new Error("ECONNRESET"))
      },
      onRetry: (retry) => {
        retries.push(retry.attempt)
      }
    })
    const exit = await runVirtual(rest.request("GET", "/repos/r"))
    expect(calls).toBe(1)
    expect(retries).toEqual([])
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const fails = exit.cause.reasons.filter(Cause.isFailReason)
      expect(fails.map((r) => r.error instanceof ArtifactsTransportError)).toEqual([true])
    }
  })

  it("TestClock fork → adjust → join: two 429s with Retry-After 2 s over a 1 s backoff wait 2 s each; the planned delays are recorded before the waits", async () => {
    let attempts = 0
    const delays: number[] = []
    const { repo } = makeRepo(2)
    const { fetch } = makeRestFetch(makeFakeNamespace({ r: repo }), {
      ...cfg,
      faults: () => (attempts++ < 2 ? { status: 429, code: 0, retryAfter: "2" } : null)
    })
    const rest = makeArtifactsRestClient({
      ...cfg,
      fetch,
      baseDelay: Duration.seconds(1),
      onRetry: (retry) => {
        delays.push(Duration.toMillis(retry.delay))
      }
    })
    /** Lets the Promise-based fake fetch settle so the fiber reaches its next wait. */
    const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(rest.request("GET", "/repos/r"))
        yield* settle
        expect(delays).toEqual([2000]) // planned (tap runs before the wait), not yet waited
        // Less than the selected delay: the fiber is still waiting.
        yield* TestClock.adjust("1999 millis")
        yield* settle
        expect(Option.isNone(yield* Effect.sync(() => Option.fromUndefinedOr(fiber.pollUnsafe())))).toBe(true)
        expect(attempts).toBe(1)
        yield* TestClock.adjust("1 millis")
        yield* settle
        expect(attempts).toBe(2)
        expect(delays).toEqual([2000, 2000])
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(attempts).toBe(3)
    expect(delays).toEqual([2000, 2000])
    expect(result).toMatchObject({ name: "r" })
  })

  it("rejects malformed configuration before any request", () => {
    expect(() => makeArtifactsRestClient({ ...cfg, apiToken: "" })).toThrow()
    expect(() => makeArtifactsRestClient({ ...cfg, accountId: "../x" })).toThrow()
    expect(() => makeArtifactsRestClient({ ...cfg, namespace: "x" })).toThrow(InvalidArtifactsName)
  })
})
