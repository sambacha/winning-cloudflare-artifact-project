/**
 * Shared harness for every randomized test (rules H1–H8 of
 * `docs/testing-guidelines.md`, section "Meaningfulness rules").
 *
 * - **Fresh randomness, replayable (H2, H8).** `SEED` is drawn from system
 *   entropy on every run unless `FC_SEED` is set. It is printed once per test
 *   file together with the exact command that replays the run, and fast-check
 *   adds `{ seed, path }` to every counterexample report. Setting
 *   `FC_SEED=<n>` reproduces a run bit for bit (`replay` below is the
 *   asserted form of that claim).
 * - **"It ran" vs "it was meaningful" (H1, H4, H6).** `law` runs a property
 *   and counts, for every generated case, whether the case satisfied the
 *   law's precondition non-trivially (`valid`) and whether it sat on a
 *   boundary of the input space (`boundary`). A run passes only if there was
 *   no counterexample **and** `valid / total ≥ minValidFraction` **and**
 *   `boundary ≥ minBoundary`. The three counts and the generator's domain are
 *   printed on every run.
 * - **Falsifiability (H3).** `mutantKilled` runs the same law against a
 *   deliberately broken implementation and returns whether it was refuted.
 *   Each core law has such a check next to it.
 */
import { webcrypto } from "node:crypto"
import fc from "fast-check"
import { expect } from "vitest"

const parseSeed = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(raw)}`)
  return n | 0
}

/** The seed of this run: `FC_SEED` if set, otherwise fresh entropy. */
export const SEED: number = parseSeed(process.env["FC_SEED"]) ?? webcrypto.getRandomValues(new Int32Array(1))[0]!

/** Command that replays this run of `file` (H8). */
export const replayCommand = (file: string): string =>
  `FC_SEED=${SEED} ESBUILD_BINARY_PATH=<executable esbuild> node node_modules/vitest/vitest.mjs run ${file}`

/** Print the seed and the replay command once per test file. */
export const announce = (file: string): void => {
  console.log(`[seed] ${file}: FC_SEED=${SEED}${process.env["FC_SEED"] ? " (from environment)" : " (fresh)"}`)
  console.log(`[replay] ${replayCommand(file)}`)
}

/** fast-check parameters for this run. */
export const params = <T>(numRuns: number, extra: Partial<fc.Parameters<T>> = {}): fc.Parameters<T> => ({
  seed: SEED,
  numRuns,
  ...extra
})

/** Classification of one generated case (H1, H4, H6). */
export interface Verdict {
  /** The precondition held and the law's conclusion was actually exercised. */
  readonly valid: boolean
  /** The case lies on a boundary of the input space (threshold, empty, equal endpoints, …). */
  readonly boundary: boolean
}

export interface Tally {
  readonly total: number
  readonly valid: number
  readonly boundary: number
}

export interface Meaningfulness {
  /** Human-readable description of the generator's domain (printed, H5). */
  readonly domain: string
  /** Minimum share of cases whose precondition held (H1). */
  readonly minValidFraction: number
  /** Minimum number of boundary cases (H6). */
  readonly minBoundary: number
}

const addVerdict = (t: Tally, v: Verdict): Tally => ({
  total: t.total + 1,
  valid: t.valid + (v.valid ? 1 : 0),
  boundary: t.boundary + (v.boundary ? 1 : 0)
})

const EMPTY: Tally = { total: 0, valid: 0, boundary: 0 }

/** Print the three counts and fail unless the run was meaningful. */
export const assertMeaningful = (name: string, t: Tally, m: Meaningfulness): Tally => {
  console.log(
    `[law] ${name} | seed=${SEED} | domain: ${m.domain} | total=${t.total} valid=${t.valid} boundary=${t.boundary}`
  )
  expect(t.total, `${name}: no cases ran`).toBeGreaterThan(0)
  expect(t.valid / t.total, `${name}: valid fraction`).toBeGreaterThanOrEqual(m.minValidFraction)
  expect(t.boundary, `${name}: boundary cases`).toBeGreaterThanOrEqual(m.minBoundary)
  return t
}

/**
 * Run `body` as a property over `arb`. `body` asserts the law (throws on a
 * counterexample) and returns the case's `Verdict`. Counts from shrinking are
 * irrelevant: shrinking only happens after a failure.
 */
export const law = <T>(
  name: string,
  arb: fc.Arbitrary<T>,
  body: (t: T) => Verdict,
  numRuns: number,
  m: Meaningfulness
): Tally => {
  let tally = EMPTY
  fc.assert(
    fc.property(arb, (x) => {
      tally = addVerdict(tally, body(x))
    }),
    params(numRuns)
  )
  return assertMeaningful(name, tally, m)
}

/** Asynchronous version of `law`. */
export const lawAsync = async <T>(
  name: string,
  arb: fc.Arbitrary<T>,
  body: (t: T) => Promise<Verdict>,
  numRuns: number,
  m: Meaningfulness
): Promise<Tally> => {
  let tally = EMPTY
  await fc.assert(
    fc.asyncProperty(arb, async (x) => {
      tally = addVerdict(tally, await body(x))
    }),
    params(numRuns)
  )
  return assertMeaningful(name, tally, m)
}

/** `true` iff `holds` is refuted on some generated case (H3: the mutant is killed). */
export const mutantKilled = <T>(arb: fc.Arbitrary<T>, holds: (t: T) => boolean, numRuns: number): boolean =>
  fc.check(
    fc.property(arb, (x) => {
      try {
        return holds(x)
      } catch {
        return false
      }
    }),
    params(numRuns)
  ).failed

/** Asynchronous version of `mutantKilled`. */
export const mutantKilledAsync = async <T>(
  arb: fc.Arbitrary<T>,
  holds: (t: T) => Promise<boolean>,
  numRuns: number
): Promise<boolean> =>
  (
    await fc.check(
      fc.asyncProperty(arb, async (x) => {
        try {
          return await holds(x)
        } catch {
          return false
        }
      }),
      params(numRuns)
    )
  ).failed

/** Number of distinct values of `f` over `xs` (H4: non-degeneracy). */
export const distinctCount = <T>(xs: ReadonlyArray<T>, f: (t: T) => unknown = (t) => t): number =>
  new Set(xs.map((x) => JSON.stringify(f(x)))).size

/**
 * Replay as an asserted property (H8): for fresh seeds, sampling `arb` twice
 * with the same seed and running `run` on the samples gives equal results.
 */
export const replay = <T, R>(arb: fc.Arbitrary<T>, run: (t: T) => R, samplesPerSeed: number, seeds: number): void => {
  fc.assert(
    fc.property(fc.integer(), (s) => {
      const a = fc.sample(arb, { seed: s, numRuns: samplesPerSeed })
      const b = fc.sample(arb, { seed: s, numRuns: samplesPerSeed })
      expect(b).toEqual(a)
      expect(b.map(run)).toEqual(a.map(run))
    }),
    params(seeds)
  )
}
