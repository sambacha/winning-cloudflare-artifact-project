/**
 * The contract between the Worker's bisect status route
 * (`src/worker/bisectRoutes.ts` `statusBody`) and the clean scenario of the
 * dashboard (`tui/src/clean/bisectStatus.ts`). The dashboard cannot import
 * this package, so the check lives here.
 *
 * T1 For every session the real route can describe (any history, any
 *    sequence of observations and skips), `parseBisectStatus` accepts the
 *    body. Its culprit, confidence and observation count are those the
 *    route computed: the dashboard displays them and computes no posterior.
 * T2 The dashboard's fixture bodies (its `--autoplay` source) have the same
 *    shape: re-validating them through the real route's field set loses
 *    nothing.
 * T3 The R2 keys the dashboard displays are the keys the cache modules
 *    write (`src/nodeModules/key.ts`, `src/buildCache/key.ts`).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law } from "../harness.js"
import { makeSession, recordResult, recordSkip, sessionStatus } from "../../src/bisect/session.js"
import { statusBody } from "../../src/worker/bisectRoutes.js"
import { buildCacheKey as tsBuildCacheKey } from "../../src/buildCache/key.js"
import { nodeModulesKey as tsNodeModulesKey } from "../../src/nodeModules/key.js"
import { parseBisectStatus } from "../../../tui/src/clean/bisectStatus.js"
import { BUILD, DEPENDENCIES, fixtureStatusBodies, RUNNER } from "../../../tui/src/clean/fixture.js"
import { buildCacheKey, nodeModulesKey } from "../../../tui/src/clean/keys.js"

announce("test/worker/tuiBisectContract.test.ts")

describe("bisect status route -> dashboard contract", () => {
  it("law T1: every status body the route produces is accepted and shown unchanged", () => {
    law(
      "parseBisectStatus(statusBody(session)) preserves culprit, confidence and observations",
      fc.record({
        n: fc.integer({ min: 2, max: 30 }),
        events: fc.array(fc.record({ at: fc.nat(), failed: fc.boolean(), skip: fc.boolean() }), { maxLength: 12 })
      }),
      ({ n, events }) => {
        const commits = Array.from({ length: n + 1 }, (_, i) => ({ oid: `c${String(i).padStart(4, "0")}`, message: `#${i} commit` }))
        let s = makeSession({ repo: "demo", goodRef: commits[0]!.oid, badRef: "main", good: commits[0]!, candidates: commits.slice(1), now: 0 })
        for (const e of events) {
          const c = commits[1 + (e.at % n)]!
          s = e.skip ? recordSkip(s, c.oid, 1) : recordResult(s, c.oid, e.failed, 1)
        }
        const body = JSON.parse(JSON.stringify(statusBody("bs-1", s))) as unknown
        const parsed = parseBisectStatus(body)
        const st = sessionStatus(s)
        expect(parsed.status.culprit.oid).toBe(st.culprit.oid)
        expect(parsed.status.confidence).toBe(st.confidence)
        expect(parsed.status.observations).toBe(st.observations)
        expect(parsed.status.done).toBe(st.done)
        expect(parsed.candidates).toBe(n)
        return { valid: true, boundary: events.length === 0 || st.done }
      },
      150,
      { domain: "histories of 2-30 commits x up to 12 observations/skips", minValidFraction: 1, minBoundary: 3 }
    )
  })

  it("T2: the dashboard's fixture bodies validate and end converged at the fixture's confidence", () => {
    const bodies = fixtureStatusBodies().map(parseBisectStatus)
    expect(bodies.length).toBe(9)
    const last = bodies[bodies.length - 1]!
    expect(last.status.done).toBe(true)
    expect(last.status.stopReason).toBe("confidence")
    expect(last.status.confidence).toBe(0.962)
    // Same field set as the real route's body.
    const real = statusBody(
      "x",
      makeSession({ repo: "r", goodRef: "g", badRef: "b", good: { oid: "g" }, candidates: [{ oid: "a" }, { oid: "b" }], now: 0 })
    )
    expect(Object.keys(fixtureStatusBodies()[0] as object).sort()).toEqual(Object.keys(real).sort())
    expect(Object.keys((fixtureStatusBodies()[0] as { status: object }).status).sort()).toEqual(Object.keys(real.status).sort())
  })

  it("T3: the keys the dashboard shows are the keys the caches write", () => {
    expect(nodeModulesKey(DEPENDENCIES.lockfileSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch)).toBe(
      tsNodeModulesKey({ lockfileSha256: DEPENDENCIES.lockfileSha256, abi: RUNNER.abi, platform: RUNNER.platform, arch: RUNNER.arch })
    )
    expect(buildCacheKey(BUILD.inputSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch)).toBe(
      tsBuildCacheKey({ inputSha256: BUILD.inputSha256, abi: RUNNER.abi, platform: RUNNER.platform, arch: RUNNER.arch })
    )
  })
})
