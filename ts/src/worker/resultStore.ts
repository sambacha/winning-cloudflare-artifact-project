/**
 * The final manifest of a bisection, at `manifests/<sessionId>/result.json`
 * in R2: an immutable audit record of what was found, plus the one-time
 * review decision.
 *
 * - The bisection driver creates it with `If-None-Match: *` (create-only).
 *   A repeated create (a replayed Workflow step) finds it and returns it.
 * - The review gate (`approve` / `reject`) sets `review` exactly once, with
 *   a compare-and-swap on the ETag it read (`onlyIf: { etagMatches }`).
 *   A manifest that already has a review is never changed again.
 *
 * Like `bisectStore.ts`, every write is conditional; there is no plain put.
 */
import { callUpstream, type UpstreamError } from "../bisect/artifactsApi.js"
import type { SessionStatus } from "../bisect/session.js"
import { type BisectSession, sessionStatus } from "../bisect/session.js"
import { Data, Effect, Schema } from "../fx/index.js"
import type { SessionId } from "../ids.js"
import type { R2WritableBucketLike } from "./bisectStore.js"

const Commit = Schema.Struct({ oid: Schema.String, message: Schema.optional(Schema.String) })

/** A review decision. */
export const Review = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  principal: Schema.String,
  at: Schema.Number,
  /** On approval: the note written on the culprit commit. */
  note: Schema.NullOr(Schema.Struct({ ref: Schema.String, commit: Schema.String, text: Schema.String })),
  /** Free-text reason (rejection) or comment. */
  comment: Schema.String
})
export type Review = typeof Review.Type

/** Body of `manifests/<sessionId>/result.json`. */
export const BisectResultManifest = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  repo: Schema.String,
  goodRef: Schema.String,
  badRef: Schema.String,
  good: Commit,
  culprit: Commit,
  confidence: Schema.Number,
  stopReason: Schema.NullOr(Schema.String),
  observations: Schema.Number,
  skipped: Schema.Array(Schema.String),
  ranking: Schema.Array(Schema.Struct({ oid: Schema.String, probability: Schema.Number })),
  rates: Schema.Struct({ newMean: Schema.Number, oldMean: Schema.Number }),
  predicate: Schema.String,
  createdAt: Schema.Number,
  driver: Schema.String,
  review: Schema.NullOr(Review)
})
export type BisectResultManifest = typeof BisectResultManifest.Type

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(BisectResultManifest))

/** The stored manifest is unreadable (not JSON, or not a manifest). */
export class ResultCorrupt extends Data.TaggedError("ResultCorrupt")<{ readonly sessionId: string; readonly reason: string }> {}

/** The review was already decided (by this or another reviewer). */
export class AlreadyReviewed extends Data.TaggedError("AlreadyReviewed")<{ readonly sessionId: string; readonly review: Review }> {}

/** Object key of a session's result manifest. */
export const resultKey = (id: SessionId): string => `manifests/${id}/result.json`

/**
 * Build the manifest from a finished session.
 *
 * @param id - Session id.
 * @param s - The session.
 * @param extra - Predicate description, driver name and creation time.
 */
export const resultFromSession = (
  id: SessionId,
  s: BisectSession,
  extra: { readonly predicate: string; readonly driver: string; readonly createdAt: number }
): BisectResultManifest => {
  const st: SessionStatus = sessionStatus(s)
  return {
    version: 1,
    sessionId: id,
    repo: s.repo,
    goodRef: s.goodRef,
    badRef: s.badRef,
    good: { oid: s.good.oid, ...(s.good.message !== undefined ? { message: s.good.message } : {}) },
    culprit: { oid: st.culprit.oid, ...(st.culprit.message !== undefined ? { message: st.culprit.message } : {}) },
    confidence: st.confidence,
    stopReason: st.stopReason,
    observations: st.observations,
    skipped: [...st.skipped],
    ranking: st.ranking.map((r) => ({ oid: r.commit.oid, probability: r.probability })),
    rates: st.rates,
    predicate: extra.predicate,
    createdAt: extra.createdAt,
    driver: extra.driver,
    review: null
  }
}

/** Conditional reads and writes of result manifests. */
export interface ResultStore {
  readonly load: (id: SessionId) => Effect.Effect<{ readonly result: BisectResultManifest; readonly etag: string } | null, ResultCorrupt | UpstreamError>
  /** Create-only; returns the stored manifest (the existing one if it was already there). */
  readonly create: (r: BisectResultManifest) => Effect.Effect<BisectResultManifest, ResultCorrupt | UpstreamError>
  /**
   * Record the review once. `decide` runs with the stored manifest and
   * returns the review (it may do work, e.g. write a note); it is **not**
   * called if a review already exists.
   */
  readonly review: <E>(
    id: SessionId,
    decide: (r: BisectResultManifest) => Effect.Effect<Review, E>
  ) => Effect.Effect<BisectResultManifest | null, E | AlreadyReviewed | ResultCorrupt | UpstreamError>
}

/**
 * A {@link ResultStore} over an R2 bucket binding.
 *
 * @param bucket - The R2 binding (the same reduced shape as the session store's).
 */
export const makeR2ResultStore = (bucket: R2WritableBucketLike): ResultStore => {
  const load = (id: SessionId) =>
    Effect.gen(function* () {
      const obj = yield* callUpstream("r2.get", async () => {
        const o = await bucket.get(resultKey(id))
        return o === null ? null : { text: await o.text(), etag: o.etag }
      })
      if (obj === null) return null
      const result = yield* decode(obj.text).pipe(Effect.mapError(() => new ResultCorrupt({ sessionId: id, reason: "not a result manifest" })))
      return { result, etag: obj.etag }
    })
  return {
    load,
    create: (r) =>
      Effect.gen(function* () {
        const id = r.sessionId as SessionId
        const put = yield* callUpstream("r2.put", () =>
          bucket.put(resultKey(id), JSON.stringify(r), { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } })
        )
        if (put !== null) return r
        const existing = yield* load(id)
        if (existing === null) return yield* Effect.fail(new ResultCorrupt({ sessionId: id, reason: "create was refused but nothing is stored" }))
        return existing.result
      }),
    review: (id, decide) =>
      Effect.gen(function* () {
        const cur = yield* load(id)
        if (cur === null) return null
        if (cur.result.review !== null) return yield* Effect.fail(new AlreadyReviewed({ sessionId: id, review: cur.result.review }))
        const review = yield* decide(cur.result)
        const next: BisectResultManifest = { ...cur.result, review }
        const put = yield* callUpstream("r2.put", () =>
          bucket.put(resultKey(id), JSON.stringify(next), { onlyIf: { etagMatches: cur.etag }, httpMetadata: { contentType: "application/json" } })
        )
        if (put !== null) return next
        // Lost the race: someone else reviewed in between.
        const after = yield* load(id)
        if (after !== null && after.result.review !== null) return yield* Effect.fail(new AlreadyReviewed({ sessionId: id, review: after.result.review }))
        return yield* Effect.fail(new ResultCorrupt({ sessionId: id, reason: "review write was refused" }))
      })
  }
}
