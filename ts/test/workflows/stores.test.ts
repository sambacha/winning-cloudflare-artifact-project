/**
 * Idempotent session steps and the result manifest store.
 */
import { describe, expect, it } from "vitest"
import { hasStep, makeMemorySessionStore, makeSession, modifySession, recordStep, SessionError } from "../../src/bisect/session.js"
import { Effect } from "../../src/fx/index.js"
import { SessionId } from "../../src/ids.js"
import { AlreadyReviewed, makeR2ResultStore, resultFromSession, resultKey, type Review } from "../../src/worker/resultStore.js"
import { makeConditionalBucket, oid } from "./fakes.js"

const session = () =>
  makeSession({ repo: "r", goodRef: oid(0), badRef: "main", good: { oid: oid(0) }, candidates: [1, 2, 3, 4].map((i) => ({ oid: oid(i) })), now: 0 })

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("recordStep", () => {
  it("records once per key and returns the same object on a repeat", () => {
    const s0 = session()
    const s1 = recordStep(s0, "i:0", oid(2), "fail", 1)
    expect(hasStep(s1, "i:0")).toBe(true)
    expect(s1.events).toEqual([{ kind: "observe", oid: oid(2), failed: true, at: 1, step: "i:0" }])
    expect(recordStep(s1, "i:0", oid(3), "pass", 2)).toBe(s1)
    const s2 = recordStep(s1, "i:1", oid(1), "skip", 3)
    expect(s2.events[1]).toEqual({ kind: "skip", oid: oid(1), at: 3, step: "i:1" })
  })

  it("rejects an empty key and an unknown commit", () => {
    expect(() => recordStep(session(), "", oid(1), "pass", 0)).toThrow(SessionError)
    expect(() => recordStep(session(), "k", oid(99), "pass", 0)).toThrow(SessionError)
  })

  it("modifySession does not write when the step is already recorded", async () => {
    const store = makeMemorySessionStore()
    const id = SessionId("s")
    await run(store.create(id, session()))
    await run(modifySession(store, id, (s) => recordStep(s, "i:0", oid(1), "pass", 0)))
    const v1 = (await run(store.load(id)))!.version
    await run(modifySession(store, id, (s) => recordStep(s, "i:0", oid(1), "pass", 0)))
    expect((await run(store.load(id)))!.version).toBe(v1)
  })
})

describe("result store", () => {
  const id = SessionId("s-res")
  const manifest = () => resultFromSession(id, recordStep(session(), "i:0", oid(3), "fail", 5), { predicate: "npm test", driver: "test", createdAt: 7 })
  const approve = (r: { culprit: { oid: string } }): Review => ({
    decision: "approved",
    principal: "alice",
    at: 9,
    note: { ref: "refs/notes/commits", commit: r.culprit.oid, text: "bisect: culprit" },
    comment: ""
  })

  it("create is create-only and returns the stored manifest on a repeat", async () => {
    const b = makeConditionalBucket()
    const store = makeR2ResultStore(b)
    const m = manifest()
    expect(await run(store.create(m))).toEqual(m)
    const etag = b.objects.get(resultKey(id))!.etag
    expect(await run(store.create({ ...m, createdAt: 99 }))).toEqual(m)
    expect(b.objects.get(resultKey(id))!.etag).toBe(etag)
    expect(b.unconditional).toEqual([])
  })

  it("review is decided exactly once; the decision callback is not re-run", async () => {
    const b = makeConditionalBucket()
    const store = makeR2ResultStore(b)
    await run(store.create(manifest()))
    let calls = 0
    const r = await run(store.review(id, (m) => Effect.sync(() => (calls++, approve(m)))))
    expect(r!.review!.decision).toBe("approved")
    const second = await Effect.runPromise(Effect.flip(store.review(id, (m) => Effect.sync(() => (calls++, approve(m))))))
    expect(second).toBeInstanceOf(AlreadyReviewed)
    expect(calls).toBe(1)
    expect(b.unconditional).toEqual([])
  })

  it("a concurrent reviewer that loses the CAS gets AlreadyReviewed", async () => {
    const b = makeConditionalBucket()
    const store = makeR2ResultStore(b)
    await run(store.create(manifest()))
    const exit = await Effect.runPromise(
      Effect.flip(
        store.review(id, (m) =>
          // While this reviewer is deciding, another one commits a rejection.
          Effect.flatMap(
            Effect.promise(() => run(store.review(id, () => Effect.succeed<Review>({ decision: "rejected", principal: "bob", at: 8, note: null, comment: "wrong" })))),
            () => Effect.succeed(approve(m))
          )
        )
      )
    )
    expect(exit).toBeInstanceOf(AlreadyReviewed)
    const stored = JSON.parse(b.objects.get(resultKey(id))!.body)
    expect(stored.review.decision).toBe("rejected")
  })

  it("review of a missing manifest is null", async () => {
    const store = makeR2ResultStore(makeConditionalBucket())
    expect(await run(store.review(SessionId("nope"), (m) => Effect.succeed(approve(m))))).toBeNull()
  })
})
