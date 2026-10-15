/**
 * Branded identifiers used at the package's API boundaries (`skills.md`
 * § 12): a job id, a cobuild cache key, a bisection session id and a Git
 * commit id are all strings on the wire, but they are not interchangeable.
 *
 * @remarks
 * - {@link JobId}, {@link CacheKey} and {@link SessionId} are
 *   `Brand.nominal`: compile-time tags without runtime validation. Values
 *   that arrive from outside (CLI flags, HTTP paths, manifests) are validated
 *   where they enter (`checkCobuildConfig`, the session-id pattern of the
 *   bisection routes) and branded there.
 * - {@link CommitOid} is `Brand.make` (the facade's v4 constructor) with a check: exactly 40 lowercase
 *   hexadecimal characters (a full SHA-1 commit id as Git prints it). The
 *   constructor throws the facade's `BrandError` otherwise; `CommitOid.is`,
 *   `CommitOid.option` and `CommitOid.either` do not throw.
 *
 * The brands are type-level only: a branded value is the same string at run
 * time, so encoding (JSON, object keys, URLs) is unchanged.
 *
 * @packageDocumentation
 */
import { Brand } from "./fx/index.js"

/** Identifier of one cobuild job (one CI leg / VM). */
export type JobId = string & Brand.Brand<"JobId">
/** Brands a string as a {@link JobId} (no runtime check). */
export const JobId = Brand.nominal<JobId>()

/** A cobuild cache key: the operation identity a lock is taken on. */
export type CacheKey = string & Brand.Brand<"CacheKey">
/** Brands a string as a {@link CacheKey} (no runtime check). */
export const CacheKey = Brand.nominal<CacheKey>()

/** Identifier of a remote bisection session (validated by the routes before branding). */
export type SessionId = string & Brand.Brand<"SessionId">
/** Brands a string as a {@link SessionId} (no runtime check). */
export const SessionId = Brand.nominal<SessionId>()

/** A full SHA-1 Git commit id: 40 lowercase hexadecimal characters. */
export type CommitOid = string & Brand.Brand<"CommitOid">
/** Validating constructor of {@link CommitOid}; throws `BrandError` for anything else. */
export const CommitOid = Brand.make<CommitOid>(
  (s) => /^[0-9a-f]{40}$/.test(s) || `Expected a 40-character lowercase hex commit id, got ${JSON.stringify(s)}`
)
