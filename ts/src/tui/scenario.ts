/**
 * The deterministic scenario behind `--snapshot <sec> --seed <n>`: what the
 * Worker's read routes would return `sec` seconds into the demo, as a pure
 * function of `(seed, sec)` (no wall clock, no I/O, no global state).
 *
 * It stands in for the server, so it may compute what the server computes:
 * the bisect status comes from the real session code (`sessionStatus`,
 * `statusBody`) over a simulated run of the demo history (50 commits, an
 * 80% intermittent failure from commit 34, a hanging test at commit 22
 * that times out and is skipped), and the node_modules view from the real
 * aggregation (`aggregateNodeModules`). The dashboard itself computes no
 * posterior.
 */
import { createHash } from "node:crypto"
import { type BisectSession, makeSession, recordStep, sessionStatus } from "../bisect/session.js"
import { SessionId } from "../ids.js"
import type { NodeModulesEvent, NodeModulesManifest } from "../nodeModules/cache.js"
import { NODE_MODULES_PREFIX } from "../nodeModules/key.js"
import { statusBody } from "../worker/bisectRoutes.js"
import { aggregateNodeModules } from "../worker/nodeModulesView.js"
import { resultFromSession } from "../worker/resultStore.js"
import { MS_PER_SECOND, SCENARIO, SCENARIO_EPOCH_MS, SECONDS_PER_MINUTE } from "./constants.js"
import type { DashboardInput, DashEvent, LeaseRow, RepoRow } from "./model.js"

/** Seeded PRNG (mulberry32 over an FNV-1a hash of the seed and a stream name). */
export const rngFor = (seed: string, stream: string): (() => number) => {
  let h = 2166136261
  for (const ch of `${seed}:${stream}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hex = (s: string, len: number): string => createHash("sha256").update(s).digest("hex").slice(0, len)
const oidOf = (n: number): string => hex(`demo-commit-${n}`, 40)
const PKGS = ["core", "cli", "web"] as const
const messageOf = (n: number): string =>
  n === 1
    ? "01: scaffold three workspaces with passing tests"
    : n === SCENARIO.culprit
      ? `${n}: core: let drain() workers yield between jobs`
      : n === SCENARIO.hang
        ? `${n}: web: add dev-server smoke test`
        : `${String(n).padStart(2, "0")}: ${PKGS[n % PKGS.length]}: add feature${n}`
const lockfileIndex = (n: number): number => SCENARIO.lockfileBumps.filter((b) => n >= b).length
const at = (sec: number): number => SCENARIO_EPOCH_MS + sec * MS_PER_SECOND

/** The demo session before any observation. */
export const scenarioSession = (): BisectSession =>
  makeSession({
    repo: "demo",
    goodRef: oidOf(1),
    badRef: "main",
    good: { oid: oidOf(1), message: messageOf(1) },
    candidates: Array.from({ length: SCENARIO.commits - 1 }, (_, i) => ({ oid: oidOf(i + 2), message: messageOf(i + 2) })),
    newRate: { kind: "known", p: SCENARIO.flakeRate },
    oldRate: { kind: "known", p: 0 },
    now: SCENARIO_EPOCH_MS
  })

const SESSION_ID = SessionId("5eed0000c0b1d0000000000000000034")

/**
 * The dashboard input `sec` seconds into the scenario.
 *
 * @param seed - Seeds every random choice (flaky outcomes, timings).
 * @param sec - Scenario time in seconds (>= 0).
 */
export const scenarioInput = (seed: string, sec: number): DashboardInput => {
  const t = Math.max(0, sec)
  const events: Array<DashEvent> = []
  const ev = (s: number, kind: DashEvent["kind"], text: string) => {
    if (s <= t) events.push({ at: at(s), kind, text })
  }
  const head = oidOf(SCENARIO.commits)
  ev(0, "push", `demo: main -> ${head.slice(0, 7)} (agent-alpha)`)
  ev(1, "info", "ci: npm test at the new tip failed; re-running 4 times")
  ev(SCENARIO.bisectStartSec - 2, "info", "ci: 4 of 5 runs failed (intermittent); previous tip was green")

  // --- bisect: the real session code over simulated runs --------------------------------
  const outcomes = rngFor(seed, "bisect")
  const timings = rngFor(seed, "timings")
  let session: BisectSession | null = null
  let previousEntropy: number | null = null
  const manifests = new Map<number, NodeModulesManifest>()
  const nmEvents: Array<NodeModulesEvent> = []
  let testMs = 0
  if (t >= SCENARIO.bisectStartSec) {
    session = scenarioSession()
    ev(SCENARIO.bisectStartSec, "bisect", `session ${SESSION_ID.slice(0, 8)} started: ${SCENARIO.commits - 1} commits, good ${oidOf(1).slice(0, 7)}`)
    for (let k = 0; ; k++) {
      const stepAt = SCENARIO.bisectStartSec + (k + 1) * SCENARIO.bisectStepSec
      if (stepAt > t) break
      const st = sessionStatus(session)
      if (st.done || st.next === null) break
      const oid = st.next.oid
      const n = session.candidates.findIndex((c) => c.oid === oid) + (1 + 1)
      // node_modules for this checkout: miss the first time a lockfile is seen, then hit.
      const li = lockfileIndex(n)
      const cold = SCENARIO.coldInstallMs.min + Math.floor(timings() * SCENARIO.coldInstallMs.spread)
      const restore = SCENARIO.restoreMs.min + Math.floor(timings() * SCENARIO.restoreMs.spread)
      const size = SCENARIO.tarballBytes.min + Math.floor(timings() * SCENARIO.tarballBytes.spread)
      testMs += SCENARIO.testMs.min + Math.floor(timings() * SCENARIO.testMs.spread)
      const key = `${NODE_MODULES_PREFIX}${hex(`lockfile-${li}`, 64)}/127/linux-x64`
      const known = manifests.get(li)
      if (known === undefined) {
        manifests.set(li, {
          version: 1,
          key,
          lockfileSha256: hex(`lockfile-${li}`, 64),
          abi: "127",
          platform: "linux",
          arch: "x64",
          nodeVersion: "v22.20.0",
          npmVersion: "10.9.3",
          createdAt: at(stepAt),
          tarballSha256: hex(`tarball-${li}`, 64),
          tarballBytes: size,
          installedLockSha256: hex(`installed-${li}`, 64),
          coldInstallMs: cold
        })
        nmEvents.push({ version: 1, runId: `snap-${k}`, key, outcome: "miss", durationMs: cold, avoidedMs: 0, tarballBytes: size, at: at(stepAt) })
        ev(stepAt, "cache", `node_modules miss ${key.slice(NODE_MODULES_PREFIX.length, NODE_MODULES_PREFIX.length + 8)}: npm ci, published`)
      } else {
        nmEvents.push({ version: 1, runId: `snap-${k}`, key, outcome: "hit", durationMs: restore, avoidedMs: known.coldInstallMs, tarballBytes: known.tarballBytes, at: at(stepAt) })
        ev(stepAt, "cache", `node_modules hit ${key.slice(NODE_MODULES_PREFIX.length, NODE_MODULES_PREFIX.length + 8)}: restored`)
      }
      const outcome = n === SCENARIO.hang ? "skip" : n >= SCENARIO.culprit ? (outcomes() < SCENARIO.flakeRate ? "fail" : "pass") : "pass"
      previousEntropy = st.entropy
      session = recordStep(session, `snapshot:${k}`, oid, outcome, at(stepAt))
      ev(stepAt, "bisect", `${oid.slice(0, 7)} (${n}) -> ${outcome === "skip" ? "skip (timeout)" : outcome}`)
    }
    const done = sessionStatus(session)
    if (done.done) ev(Math.min(t, SCENARIO.bisectStartSec + (session.events.length + 1) * SCENARIO.bisectStepSec), "bisect", `culprit ${done.culprit.oid.slice(0, 7)} at ${(done.confidence * 100).toFixed(1)} %; awaiting review`)
  }

  // --- leases: three agents; alpha crashes and gamma takes over after the lease expires ----
  const L = SCENARIO.leaseSeconds
  const H = SCENARIO.heartbeatSeconds
  const [alpha, beta, gamma] = SCENARIO.agents
  const lastBeat = (from: number, until: number) => from + Math.floor(Math.max(0, until - from) / H) * H
  const leases: Array<LeaseRow> = []
  const crash = SCENARIO.crashAtSec
  if (t >= 1) {
    ev(1, "lease", `${alpha} acquired core:build (If-None-Match: *)`)
    const hb = lastBeat(1, Math.min(t, crash))
    const expiresAt = hb + L
    if (t < crash) leases.push({ cacheKey: "core:build", owner: alpha, status: "building", heartbeatAt: at(hb), expiresAt: at(expiresAt), leaseExpired: false })
    else if (t <= expiresAt) leases.push({ cacheKey: "core:build", owner: alpha, status: "building", heartbeatAt: at(hb), expiresAt: at(expiresAt), leaseExpired: false })
    else {
      ev(crash, "error", `${alpha} stopped heartbeating`)
      ev(expiresAt + 1, "lease", `${gamma} took over core:build after expiry (If-Match: etag)`)
      const ghb = lastBeat(expiresAt + 1, t)
      leases.push({ cacheKey: "core:build", owner: gamma, status: "building", heartbeatAt: at(ghb), expiresAt: at(ghb + L), leaseExpired: false })
    }
    if (t >= crash && t <= expiresAt) ev(crash, "error", `${alpha} stopped heartbeating`)
  }
  if (t >= 2) {
    ev(2, "lease", `${beta} acquired cli:build`)
    const finish = 2 + L + H
    if (t < finish) {
      const hb = lastBeat(2, t)
      leases.push({ cacheKey: "cli:build", owner: beta, status: "building", heartbeatAt: at(hb), expiresAt: at(hb + L), leaseExpired: false })
    } else {
      ev(finish, "lease", `${beta} finished cli:build (succeeded, cached)`)
      leases.push({ cacheKey: "cli:build", owner: beta, status: "succeeded", heartbeatAt: at(finish), expiresAt: at(finish), leaseExpired: false })
    }
  }
  if (t >= 3) {
    ev(3, "lease", `${gamma} acquired web:test`)
    const hb = lastBeat(3, t)
    leases.push({ cacheKey: "web:test", owner: gamma, status: "building", heartbeatAt: at(hb), expiresAt: at(hb + L), leaseExpired: false })
  }

  const repos: ReadonlyArray<RepoRow> = [
    { name: "demo", status: "ok", head, headAt: at(0), detail: "" },
    { name: "demo-agent-alpha", status: "ok", head: oidOf(SCENARIO.commits - 1), headAt: at(-SECONDS_PER_MINUTE), detail: "" },
    { name: "demo-agent-beta", status: "ok", head: oidOf(SCENARIO.commits - 1 - 1), headAt: at(-SECONDS_PER_MINUTE - SECONDS_PER_MINUTE), detail: "" }
  ]

  const nm = aggregateNodeModules([...manifests.values()], nmEvents, false)
  const steps = session?.events.length ?? 0
  const result = session !== null && sessionStatus(session).done ? resultFromSession(SESSION_ID, session, { predicate: "npm test", driver: "workflow:snapshot", createdAt: at(t) }) : null
  return {
    now: at(t),
    title: "cobuilds",
    repos,
    nodeModules: nm,
    leases,
    bisect: session === null ? null : { body: statusBody(SESSION_ID, session), previousEntropy, result },
    cost: {
      // Per step: one session CAS write + one event report (+ tarball and manifest on a miss); reads: session, manifest, tarball.
      r2ClassA: 1 + steps + nmEvents.length + nm.totals.misses * (1 + 1),
      r2ClassB: steps * (1 + 1 + 1),
      r2StoredBytes: nm.totals.storedBytes,
      ghaMinutes: (nmEvents.length * (nm.totals.meanColdInstallMs ?? 0) + testMs) / (MS_PER_SECOND * SECONDS_PER_MINUTE)
    },
    events: events.sort((a, b) => a.at - b.at)
  }
}
