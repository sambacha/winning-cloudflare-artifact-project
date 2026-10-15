/**
 * Escaped, terminated, versioned object-key encoding (decision D-4).
 *
 *     encodeKey(["trusted", "k", "blake3:ab…"]) === "v1/trusted/k/blake3:ab…/"
 *
 * - Inside a component, `%`, `/` and control characters are percent-encoded,
 *   so an encoded component never contains `/`.
 * - Every component, including the last, ends with `/`.
 * - The first component is the layout version (`v1`), so a future layout can
 *   live next to this one without rewriting keys.
 *
 * Contract (Lean: `DesignReview/KeyEncoding.lean`, `enc_injective`,
 * `enc_prefix_iff`; property-tested in `test/cache/keyEncoding.test.ts`):
 *
 * - injective: different component lists give different keys;
 * - prefix-faithful: `encodeKey(p)` is a string prefix of `encodeKey(q)`
 *   exactly when `p` is a component-wise prefix of `q`. Prefix-scoped
 *   operations (lifecycle rules, listing, per-scope authorisation) therefore
 *   never reach into another scope, branch or repository.
 *
 * Naive `/`-joining has neither property (`naive_not_injective`,
 * `naive_prefix_collateral`).
 *
 * R2 limits object keys to 1024 bytes of UTF-8 (unchecked external fact, see
 * `docs/cache-path-review.md`); `encodeKey` refuses longer keys instead of
 * letting the request fail at R2.
 */
import { Data } from "../fx/index.js"

export const LAYOUT_VERSION = "v1"
export const MAX_KEY_BYTES = 1024

/**
 * A component that is not well-formed Unicode (a lone UTF-16 surrogate), or
 * not in NFC (see `isNfc`). R2 stores keys as NFC-normalized UTF-8, where
 * every lone surrogate becomes U+FFFD and canonically equivalent strings
 * coincide, so two different such strings would collide on the wire. They
 * are rejected.
 */
export class MalformedComponent extends Data.TaggedError("MalformedComponent")<{
  readonly index: number
}> {}

/**
 * True when `s` is already in Unicode Normalization Form C. R2 NFC-normalizes
 * object key names by default ("Unicode interoperability" in the R2 docs), so
 * two keys that differ only in normalization (`"e\u0301"` vs `"\u00e9"`)
 * would name the **same** R2 object. Such components are rejected (as
 * `MalformedComponent`) instead of silently colliding; NFC input is
 * unaffected, and every key this module produces is identical before and
 * after R2's normalization.
 */
export const isNfc = (s: string): boolean => s.normalize("NFC") === s

/** True when `s` has no lone UTF-16 surrogate (what `String.prototype.isWellFormed` checks). */
export const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

export class KeyTooLong extends Data.TaggedError("KeyTooLong")<{
  readonly bytes: number
  readonly limit: number
}> {}

const mustEscape = (code: number): boolean =>
  code === 0x25 /* % */ || code === 0x2f /* / */ || code < 0x20 || code === 0x7f

const hex2 = (code: number) => "%" + code.toString(16).toUpperCase().padStart(2, "0")

/** Percent-encode `%`, `/` and ASCII control characters; everything else is kept. */
export const encodeComponent = (c: string): string => {
  let out = ""
  for (const ch of c) {
    const code = ch.codePointAt(0)!
    out += code < 0x80 && mustEscape(code) ? hex2(code) : ch
  }
  return out
}

/** Inverse of `encodeComponent`; `null` if `s` is not in its image. */
export const decodeComponent = (s: string): string | null => {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === "/") return null
    if (ch !== "%") {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) return null
      out += ch
      continue
    }
    const h = s.slice(i + 1, i + 3)
    if (!/^[0-9A-F]{2}$/.test(h)) return null
    const code = parseInt(h, 16)
    // Only the canonical escapes are accepted, so decoding is the exact inverse.
    if (!mustEscape(code)) return null
    out += String.fromCharCode(code)
    i += 2
  }
  return out
}

/** The full object key for a component list (the layout version is prepended). */
export const encodeKey = (components: ReadonlyArray<string>): string => {
  components.forEach((c, index) => {
    if (!isWellFormed(c) || !isNfc(c)) throw new MalformedComponent({ index })
  })
  const key = [LAYOUT_VERSION, ...components].map((c) => encodeComponent(c) + "/").join("")
  const bytes = Buffer.byteLength(key, "utf8")
  if (bytes > MAX_KEY_BYTES) throw new KeyTooLong({ bytes, limit: MAX_KEY_BYTES })
  return key
}

/** The prefix under which every key starting with `components` lives (same string as `encodeKey`). */
export const encodePrefix = encodeKey

/**
 * Inverse of `encodeKey`; `null` for keys of another layout or not produced by `encodeKey`.
 *
 * `decodeKey(s) = cs` implies `encodeKey(cs) = s` (the inverse round trip in
 * `test/cache/keyLaws.test.ts`). That law found two kinds of keys this
 * function used to accept although `encodeKey` can never produce them: keys
 * longer than `MAX_KEY_BYTES`, and components containing a lone surrogate.
 * Both are rejected now.
 */
export const decodeKey = (key: string): Array<string> | null => {
  if (!key.endsWith("/")) return null
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) return null
  const parts = key.slice(0, -1).split("/")
  if (parts[0] !== LAYOUT_VERSION) return null
  const out: Array<string> = []
  for (const p of parts.slice(1)) {
    const c = decodeComponent(p)
    if (c === null || !isWellFormed(c) || !isNfc(c)) return null
    out.push(c)
  }
  return out
}

/** Component-wise prefix test (the abstract side of `enc_prefix_iff`). */
export const isComponentPrefix = (p: ReadonlyArray<string>, q: ReadonlyArray<string>): boolean =>
  p.length <= q.length && p.every((c, i) => c === q[i])
