/**
 * Secrets decoded from configuration (`src/secrets.ts`): wrapped in
 * `Redacted` at decode, never printed or serialized, and not encodable back
 * through the schema.
 */
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import { Redacted, Result, Schema } from "../src/fx/index.js"
import { reveal, Secret, secret, secretFromConfig } from "../src/secrets.js"

describe("secrets", () => {
  it("secretFromConfig wraps a set value in Redacted; unset and empty mean absent", () => {
    const s = secretFromConfig("tok-123")
    expect(s !== undefined && Redacted.isRedacted(s)).toBe(true)
    expect(reveal(s!)).toBe("tok-123")
    expect(secretFromConfig(undefined)).toBeUndefined()
    expect(secretFromConfig("")).toBeUndefined()
  })

  it("a Redacted secret does not appear in toString, JSON or inspect output", () => {
    for (const s of [secretFromConfig("tok-123")!, secret("tok-123")]) {
      const out = [String(s), `${s}`, JSON.stringify({ s }), inspect({ s }, { depth: 5 })].join(" ")
      expect(out).not.toContain("tok-123")
      expect(out).toContain("<redacted>")
    }
  })

  it("the Secret schema decodes non-empty strings and refuses to encode (disallowEncode)", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(Secret)(""))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Secret)(42))).toBe(true)
    const ok = Schema.decodeUnknownResult(Secret)("tok-123")
    expect(Result.isSuccess(ok) && Redacted.value(ok.success)).toBe("tok-123")
    expect(() => Schema.encodeSync(Secret)(Redacted.make("tok-123"))).toThrow(/Cannot encode Redacted/)
  })

  it("without disallowEncode, RedactedFromValue round-trips the raw value", () => {
    const schema = Schema.RedactedFromValue(Schema.String)
    const decoded = Schema.decodeSync(schema)("abc")
    expect(Redacted.value(decoded)).toBe("abc")
    expect(Schema.encodeSync(schema)(decoded)).toBe("abc")
  })
})
