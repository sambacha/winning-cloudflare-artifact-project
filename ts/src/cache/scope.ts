/**
 * Writer trust scopes (decision D-1).
 *
 * Every cache object key starts `v1/<scope>/…`, and so does every cobuild lock
 * key. A job writes only into its own scope. Trusted jobs read only trusted
 * scopes; untrusted jobs read trusted scopes and then their own.
 *
 * Why this is the one decision that cannot be deferred: writes are
 * create-only, so a malicious *first* write under a key is permanent
 * (`first_write_poisons`), and a digest supplied by the same writer accepts
 * any payload (`self_attested_accepts_any`). Only keeping untrusted writes out
 * of the keys trusted jobs read prevents poisoning (`unscoped_serves_foreign`,
 * `scoped_lookup_respects_scope`).
 *
 * Scopes are trust levels (`trusted`, `fork-pr`, …), not branch names:
 * branch names are mutable and attacker-chosen.
 */
import { Data } from "../fx/index.js"

declare const ScopeBrand: unique symbol
export type Scope = string & { readonly [ScopeBrand]: true }

const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export class InvalidScope extends Data.TaggedError("InvalidScope")<{ readonly scope: string }> {}

export const isValidScope = (s: string): s is Scope => SCOPE_RE.test(s)

export const makeScope = (s: string): Scope => {
  if (!isValidScope(s)) throw new InvalidScope({ scope: s })
  return s as Scope
}

export interface TrustPolicy {
  /** Scopes whose writers are trusted, in read-preference order. */
  readonly trusted: ReadonlyArray<Scope>
}

export interface Job {
  /** The scope this job writes into (and the scope of its cobuild locks). */
  readonly scope: Scope
}

export const isTrusted = (policy: TrustPolicy, job: Job): boolean => policy.trusted.includes(job.scope)

/** Scopes a job may read, in the order they are tried. */
export const readScopes = (policy: TrustPolicy, job: Job): ReadonlyArray<Scope> =>
  isTrusted(policy, job) ? policy.trusted : [...policy.trusted, job.scope]

/** A job may write only into its own scope. */
export const canWrite = (job: Job, target: Scope): boolean => job.scope === target

export class WriteNotAllowed extends Data.TaggedError("WriteNotAllowed")<{
  readonly job: Scope
  readonly target: Scope
}> {}
