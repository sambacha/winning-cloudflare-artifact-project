/**
 * Tagged, length-agnostic digests (decision D-5).
 *
 * A digest is serialised as `<alg>:<lowercase hex>`, e.g. `blake3:af13…`.
 * Parsing never assumes a length, and an unknown algorithm parses to `null`,
 * which every caller treats as a cache miss. Switching algorithm later is
 * then a miss, not a migration: old and new manifests simply never match.
 *
 * Collision resistance of BLAKE3 is an assumption, never a theorem: no
 * function from a larger to a smaller set is injective
 * (`no_compression_function_is_injective`).
 */
import { Blake3, blake3, toHex } from "./blake3.js"

export type DigestAlg = "blake3"
export const KNOWN_ALGS: ReadonlyArray<DigestAlg> = ["blake3"]

export interface Digest {
  readonly alg: DigestAlg
  /** Lowercase hex, even length, non-empty. */
  readonly hex: string
}

export const formatDigest = (d: Digest): string => `${d.alg}:${d.hex}`

const HEX = /^(?:[0-9a-f]{2})+$/

/** `null` for unknown algorithms, missing tag, upper-case or odd-length hex. Accepts any length. */
export const parseDigest = (s: string): Digest | null => {
  const i = s.indexOf(":")
  if (i <= 0) return null
  const alg = s.slice(0, i)
  const hex = s.slice(i + 1)
  if (!(KNOWN_ALGS as ReadonlyArray<string>).includes(alg)) return null
  if (!HEX.test(hex)) return null
  return { alg: alg as DigestAlg, hex }
}

export const digestEquals = (a: Digest, b: Digest): boolean => a.alg === b.alg && a.hex === b.hex

export const digestBytes = (bytes: Uint8Array): Digest => ({ alg: "blake3", hex: toHex(blake3(bytes)) })

/** Incremental digest + byte count, for verifying a blob while it streams (D-7). */
export class StreamingDigest {
  private readonly h = new Blake3()
  private n = 0

  update(chunk: Uint8Array): void {
    this.h.update(chunk)
    this.n += chunk.length
  }

  get size(): number {
    return this.n
  }

  finish(): Digest {
    return { alg: "blake3", hex: toHex(this.h.digest()) }
  }
}
