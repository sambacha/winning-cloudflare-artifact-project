/**
 * `SessionStore` over a Workers R2 binding.
 *
 * Sessions are stored at `encodeKey([scope, "bisect", id, "session"])` as JSON.
 * Writes are conditional, so concurrent runners cannot lose each other's
 * results:
 *
 * - create: `put(key, body, { onlyIf: new Headers({ "If-None-Match": "*" }) })`;
 * - update: `put(key, body, { onlyIf: { etagMatches: <etag read> } })`.
 *
 * The Workers R2 `put` resolves to `null` when an `onlyIf` precondition fails.
 * These calls follow the Workers R2 API but have **not** been run against a
 * real binding from this repository (no account); `test/worker/bisect.test.ts`
 * runs them against an in-memory bucket with the same contract.
 *
 * R2 allows one write per key per second. Two runners finishing within the
 * same second on one session can therefore see a rate-limit error; the route
 * layer turns it into `503` with `Retry-After: 1`.
 */
import { encodeKey } from "../cache/keyEncoding.js"
import { callUpstream, validate } from "../bisect/artifactsApi.js"
import { type BisectSession, parseSession, SessionError, type SessionStore } from "../bisect/session.js"
import { Effect } from "../fx/index.js"
import type { SessionId } from "../ids.js"

/** Options of a Workers R2 `put`, reduced to what the session store passes. */
export interface R2PutOptionsLike {
  readonly onlyIf?: { readonly etagMatches?: string } | Headers
  readonly httpMetadata?: { readonly contentType?: string }
}

/** A Workers R2 bucket binding, reduced to `get` and conditional `put`. */
export interface R2WritableBucketLike {
  readonly get: (key: string) => Promise<{ readonly etag: string; readonly text: () => Promise<string> } | null>
  readonly put: (key: string, value: string, options?: R2PutOptionsLike) => Promise<{ readonly etag: string } | null>
}

/**
 * Object key of a session.
 *
 * @param scope - Deployment scope (key prefix).
 * @param id - Session id.
 * @returns The encoded key.
 */
export const sessionKey = (scope: string, id: SessionId): string => encodeKey([scope, "bisect", id, "session"])

/**
 * A {@link SessionStore} over an R2 bucket. Bucket calls are lifted with
 * `callUpstream` (failures, including unreadable JSON, become
 * `UpstreamError`); the decoded value is checked with `parseSession`
 * (`SessionError`).
 *
 * @param bucket - The R2 binding.
 * @param scope - Key prefix.
 * @returns The store.
 */
export const makeR2SessionStore = (bucket: R2WritableBucketLike, scope: string): SessionStore => ({
  load: (id) =>
    Effect.gen(function* () {
      const stored = yield* callUpstream("r2.get", async () => {
        const obj = await bucket.get(sessionKey(scope, id))
        return obj === null ? null : { raw: JSON.parse(await obj.text()) as unknown, etag: obj.etag }
      })
      if (stored === null) return null
      const session = yield* validate<BisectSession, SessionError>(() => parseSession(stored.raw))
      return { session, version: stored.etag }
    }),
  create: (id, session) =>
    Effect.map(
      callUpstream("r2.put", () =>
        bucket.put(sessionKey(scope, id), JSON.stringify(session), {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: "application/json" }
        })
      ),
      (r) => r !== null
    ),
  update: (id, session, version) =>
    Effect.map(
      callUpstream("r2.put", () =>
        bucket.put(sessionKey(scope, id), JSON.stringify(session), {
          onlyIf: { etagMatches: version },
          httpMetadata: { contentType: "application/json" }
        })
      ),
      (r) => r !== null
    )
})
