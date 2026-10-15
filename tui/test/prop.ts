/**
 * Minimal property-test harness for the TUI tests (no dependencies), following
 * rules H1–H8 of `docs/testing-guidelines.md`:
 * - fresh seed from system entropy unless `TUI_SEED` is set; printed with a
 *   replay command, and included in every failure message;
 * - `law` counts total / valid / boundary cases, prints them with the domain,
 *   and fails on a counterexample, a low valid fraction or too few boundary cases;
 * - `refutes` runs a law's check against a deliberately broken variant and
 *   reports whether some generated case rejects it.
 */
import assert from "node:assert/strict"
import { webcrypto } from "node:crypto"

const parse = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new Error(`TUI_SEED must be an integer, got ${JSON.stringify(raw)}`)
  return n >>> 0
}

export const SEED: number = parse(process.env["TUI_SEED"]) ?? webcrypto.getRandomValues(new Uint32Array(1))[0]!

export const announce = (file: string): void => {
  console.log(`[seed] ${file}: TUI_SEED=${SEED}${process.env["TUI_SEED"] ? " (from environment)" : " (fresh)"}`)
  console.log(`[replay] TUI_SEED=${SEED} node --test ${file}`)
}

/** mulberry32: a small deterministic PRNG. */
export interface Rng {
  readonly next: () => number // [0, 1)
  readonly int: (lo: number, hi: number) => number // inclusive
  readonly pick: <T>(xs: ReadonlyArray<T>) => T
  readonly chance: (p: number) => boolean
}

export const rng = (seed: number): Rng => {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    chance: (p) => next() < p
  }
}

export interface Verdict {
  readonly valid: boolean
  readonly boundary: boolean
}

export interface Meaning {
  readonly domain: string
  readonly minValidFraction: number
  readonly minBoundary: number
}

/**
 * Run `check` on `n` generated cases. `check` throws on a violation and returns
 * the case's classification.
 */
export const law = <T>(name: string, n: number, gen: (r: Rng) => T, check: (x: T) => Verdict, m: Meaning, seed = SEED): void => {
  const r = rng(seed)
  let valid = 0
  let boundary = 0
  for (let i = 0; i < n; i++) {
    const x = gen(r)
    let v: Verdict
    try {
      v = check(x)
    } catch (e) {
      throw new Error(`[law] ${name}: counterexample at case ${i} (TUI_SEED=${seed}): ${JSON.stringify(x)}\n${(e as Error).message}`)
    }
    valid += v.valid ? 1 : 0
    boundary += v.boundary ? 1 : 0
  }
  console.log(`[law] ${name} | seed=${seed} | domain: ${m.domain} | total=${n} valid=${valid} boundary=${boundary}`)
  assert.ok(valid / n >= m.minValidFraction, `${name}: valid fraction ${valid}/${n} < ${m.minValidFraction} (TUI_SEED=${seed})`)
  assert.ok(boundary >= m.minBoundary, `${name}: boundary cases ${boundary} < ${m.minBoundary} (TUI_SEED=${seed})`)
}

/** True if some generated case makes `holds` false (the broken variant is caught). */
export const refutes = <T>(n: number, gen: (r: Rng) => T, holds: (x: T) => boolean, seed = SEED): boolean => {
  const r = rng(seed ^ 0x9e3779b9)
  for (let i = 0; i < n; i++) {
    let ok: boolean
    try {
      ok = holds(gen(r))
    } catch {
      ok = false
    }
    if (!ok) return true
  }
  return false
}
