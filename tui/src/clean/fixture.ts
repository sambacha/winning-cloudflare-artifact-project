/**
 * Illustrative data of the clean build-pipeline run (`--scenario clean`).
 * Every panel that shows it says ILLUSTRATIVE DATA.
 *
 * Nothing here is random and nothing reads the clock. Durations come from
 * constant lookup tables, so two runs with the same `--fixed-time` draw the
 * same bytes. The workload is a 12-file TypeScript project. The bisect
 * engine, lease locks and session store are not simulated here. The Bisect
 * panel shows status bodies in the shape the Worker's status route returns
 * (`bisectStatus.ts`).
 */

export const ENVIRONMENT = {
  namespace: "default",
  jurisdiction: "us",
  repo: "fame-xga-demo",
  status: "ready",
  branch: "main",
  commits: 50,
  r2: "connected",
  bucket: "fame-xga-deps"
} as const

/** The runner the caches are keyed for (ABI = `process.versions.modules`, not the full Node version). */
export const RUNNER = { abi: "127", platform: "linux", arch: "x64", node: "v22.21.1" } as const

export const DEPENDENCIES = {
  /** sha256(package-lock.json), illustrative. */
  lockfileSha256: "abc1234f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b",
  tarballMB: 148,
  /** Download + verify + extract on a hit. */
  restoreMs: 1800,
  /** The cold `npm ci` the manifest recorded (what a hit avoids). */
  coldInstallMs: 44_100,
  restoresThisSession: 1
} as const

/** The 12 source files of the workload; the two that changed since the cached build are marked. */
export const BUILD_SOURCES: ReadonlyArray<{ readonly path: string; readonly changed: boolean }> = [
  { path: "src/cli/main.ts", changed: false },
  { path: "src/cli/args.ts", changed: false },
  { path: "src/core/graph.ts", changed: true },
  { path: "src/core/scheduler.ts", changed: true },
  { path: "src/core/types.ts", changed: false },
  { path: "src/cache/key.ts", changed: false },
  { path: "src/cache/store.ts", changed: false },
  { path: "src/lock/lease.ts", changed: false },
  { path: "src/lock/renew.ts", changed: false },
  { path: "src/report/table.ts", changed: false },
  { path: "src/report/json.ts", changed: false },
  { path: "src/index.ts", changed: false }
]

export const BUILD = {
  /** sha256(sourceContents + toolVersion), illustrative. */
  inputSha256: "def4567a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
  toolVersion: "typescript@5.9.3",
  outputsEmitted: 12,
  /** Hashing the 12 sources and looking them up. */
  checkMs: 1000
} as const

/**
 * Rebuild durations, keyed on the input set (the sorted, comma-joined paths
 * of the modules that missed the cache). This table is the only source of
 * build durations.
 */
export const BUILD_DURATIONS_MS: Readonly<Record<string, number>> = {
  "": 0,
  "src/core/graph.ts,src/core/scheduler.ts": 1200,
  "src/core/graph.ts": 700,
  "src/core/scheduler.ts": 650
}

export const BISECT = {
  sessionId: "bs-7f3a9c",
  predicate: "npm test",
  /** Seconds of the run between two observations, as the panel replays them. */
  stepMs: 500,
  candidates: 50,
  culprit: 34,
  /** Observations in order: commit number (1-50) and whether the predicate failed. */
  observations: [
    { commit: 25, failed: false },
    { commit: 38, failed: true },
    { commit: 31, failed: false },
    { commit: 33, failed: false },
    { commit: 35, failed: false },
    { commit: 32, failed: false },
    { commit: 36, failed: false },
    { commit: 34, failed: true }
  ],
  /** The route's posterior summary after each observation (index 0 = before any). Computed by the Worker, not here. */
  posterior: [
    { culprit: 26, confidence: 0.04, entropy: 5.61, next: 25 },
    { culprit: 26, confidence: 0.07, entropy: 4.98, next: 38 },
    { culprit: 32, confidence: 0.11, entropy: 3.96, next: 31 },
    { culprit: 34, confidence: 0.19, entropy: 3.12, next: 33 },
    { culprit: 34, confidence: 0.31, entropy: 2.47, next: 35 },
    { culprit: 34, confidence: 0.44, entropy: 1.95, next: 32 },
    { culprit: 34, confidence: 0.58, entropy: 1.51, next: 36 },
    { culprit: 34, confidence: 0.79, entropy: 0.98, next: 34 },
    { culprit: 34, confidence: 0.962, entropy: 0.24, next: null }
  ],
  rates: { newMean: 0.71, oldMean: 0.03 }
} as const

export const LEASES: ReadonlyArray<{ readonly agent: string; readonly op: string; readonly ttlS: number; readonly heartbeatAgeS: number }> = [
  { agent: "agent-alpha", op: "op:build-core", ttlS: 42, heartbeatAgeS: 4 },
  { agent: "agent-beta", op: "op:test-suite", ttlS: 38, heartbeatAgeS: 3 },
  { agent: "agent-gamma", op: "op:lint", ttlS: 51, heartbeatAgeS: 2 }
]

/** Lease length and renewal interval of the lock protocol (`ts/src/lock.ts`). */
export const LEASE_POLICY = { leaseS: 60, renewS: 10, heartbeatShownAfterMs: 1000 } as const

export const COST = { cobuildsUsd: 0.033, githubActionsUsd: 1.32 } as const

/** Commit object id of commit number `n` (illustrative, deterministic). */
export const oidOf = (n: number): string => `c${String(n).padStart(3, "0")}${"5e1f0a9d".repeat(4).slice(0, 36)}`

/** Commit message of commit number `n`: the `#n` token is what the panel shows. */
export const messageOf = (n: number): string => (n === BISECT.culprit ? `#${n} perf: inline scheduler queue` : `#${n} chore: demo commit`)

const commitInfo = (n: number) => ({ oid: oidOf(n), message: messageOf(n) })

/**
 * The fixture's status bodies, one per observation (index k = after k
 * observations), in the exact shape of `GET /api/bisect/:id`. The posterior
 * summary is copied from the table above. Nothing here computes it.
 */
export const fixtureStatusBodies = (): ReadonlyArray<unknown> =>
  BISECT.posterior.map((p, k) => {
    const seen = BISECT.observations.slice(0, k)
    const done = p.next === null
    const tally = [...new Set(seen.map((o) => o.commit))]
      .sort((a, b) => a - b)
      .map((n) => ({
        ...commitInfo(n),
        fails: seen.filter((o) => o.commit === n && o.failed).length,
        passes: seen.filter((o) => o.commit === n && !o.failed).length,
        skips: 0
      }))
    return {
      id: BISECT.sessionId,
      repo: ENVIRONMENT.repo,
      good: commitInfo(0),
      badRef: ENVIRONMENT.branch,
      candidates: BISECT.candidates,
      status: {
        done,
        stopReason: done ? "confidence" : null,
        next: p.next === null ? null : commitInfo(p.next),
        culprit: commitInfo(p.culprit),
        confidence: p.confidence,
        entropy: p.entropy,
        observations: k,
        skipped: [],
        candidates: BISECT.candidates,
        ranking: [{ commit: commitInfo(p.culprit), probability: p.confidence }],
        rates: BISECT.rates
      },
      tally
    }
  })

