/**
 * The JSON body of a cobuild lock object (`v1/<scope>/<prefix>/<context>/<cacheKey>/lock/`).
 * The manifest is the object *body*; no custom metadata is written.
 */
import { Schema } from "./fx/index.js"

const Building = Schema.Struct({ status: Schema.Literal("building") })
const Succeeded = Schema.Struct({
  status: Schema.Literal("succeeded"),
  buildCacheKey: Schema.String
})
const Failed = Schema.Struct({
  status: Schema.Literal("failed"),
  /** When the failure was published. The shelf life starts here, not at `acquiredAt`. */
  failedAt: Schema.Number,
  logKey: Schema.NullOr(Schema.String)
})
export const Outcome = Schema.Union([Building, Succeeded, Failed])
export type Outcome = typeof Outcome.Type

export const Manifest = Schema.Struct({
  owner: Schema.String,
  /** Fresh per write: distinct versions never have identical content. */
  nonce: Schema.String,
  acquiredAt: Schema.Number,
  heartbeatAt: Schema.Number,
  expiresAt: Schema.Number,
  outcome: Outcome
})
export type Manifest = typeof Manifest.Type

export const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))
export const encodeManifest = (m: Manifest): string => JSON.stringify(m)
