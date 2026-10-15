/**
 * Secrets read from configuration (API tokens, R2 access keys).
 *
 * @remarks
 * Every secret is wrapped in `Redacted` at the point where it is decoded from
 * the environment or a Worker binding, and unwrapped with `Redacted.value`
 * only at the boundary that needs the raw string (signing a request, setting
 * an `Authorization` header, a constant-time comparison). A `Redacted` prints
 * as `<redacted>` through `toString`, `JSON.stringify` and `util.inspect`, so
 * a configuration object that is logged or serialized does not leak it.
 *
 * @packageDocumentation
 */
import { Redacted, Result, Schema } from "./fx/index.js"

/**
 * The schema of a secret decoded from configuration: a non-empty string
 * wrapped in `Redacted`. Encoding is refused (`disallowEncode`), so a
 * secret cannot be written back out through a schema by accident.
 */
export const Secret = Schema.RedactedFromValue(Schema.NonEmptyString, { disallowEncode: true })

/**
 * Decode an optional raw configuration value into a secret.
 *
 * @param raw - The raw value (an environment variable or binding); `undefined`
 *   and the empty string mean "not set".
 * @returns The secret, or `undefined` when the value is not set.
 */
export const secretFromConfig = (raw: string | undefined): Redacted.Redacted<string> | undefined => {
  if (raw === undefined || raw === "") return undefined
  const decoded = Schema.decodeUnknownResult(Secret)(raw)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/**
 * Wrap a secret that originates in code (for example a token minted by this
 * process) — `Redacted.make`, re-exported here so call sites read alike.
 */
export const secret = (value: string): Redacted.Redacted<string> => Redacted.make(value)

/**
 * The raw string of a secret. Call only where the raw value is required.
 */
export const reveal = (value: Redacted.Redacted<string>): string => Redacted.value(value)
