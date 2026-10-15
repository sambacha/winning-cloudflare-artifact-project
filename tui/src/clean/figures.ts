/**
 * Every figure the clean scenario displays, as a `Derived` (value, unit,
 * formula, inputs), computed by pure functions from `fixture.ts`. The panels
 * show nothing numeric that does not come from here (or from a status body,
 * via `bisectFigures`).
 */
import { der, type Derived } from "../derive.ts"
import type { Part } from "../scenario.ts"
import { type BisectStatus, isConverged, parseBisectStatus } from "./bisectStatus.ts"
import { BISECT, BUILD, BUILD_DURATIONS_MS, BUILD_SOURCES, COST, DEPENDENCIES, ENVIRONMENT, fixtureStatusBodies, LEASE_POLICY, LEASES, RUNNER } from "./fixture.ts"
import { BUILD_CACHE_PREFIX, DIGEST_SHOWN, NM_CACHE_PREFIX, shortDigest, shortKey } from "./keys.ts"

export { buildCacheKey, DIGEST_SHOWN, nodeModulesKey, shortDigest } from "./keys.ts"
export { fixtureStatusBodies } from "./fixture.ts"

const MS_PER_S = 1000

/** Seconds as a figure (one decimal). */
const secs = (ms: number, formula: string, deps: ReadonlyArray<string>): Derived => der(ms / MS_PER_S, "s", formula, deps)

// ---------------------------------------------------------------------------
// Environment

export const environmentFigures = () => ({
  commits: der(ENVIRONMENT.commits, "commits", "fixture.ENVIRONMENT.commits", ["fixture.ENVIRONMENT.commits"])
})

// ---------------------------------------------------------------------------
// Dependencies

export const dependencyFigures = () => {
  const restore = secs(DEPENDENCIES.restoreMs, "manifest restore time (download + verify + extract)", ["fixture.DEPENDENCIES.restoreMs"])
  const savedMs = DEPENDENCIES.coldInstallMs - DEPENDENCIES.restoreMs
  return {
    size: der(DEPENDENCIES.tarballMB, "MB", "manifest.tarballBytes / 10^6", ["fixture.DEPENDENCIES.tarballMB"]),
    restore,
    saved: secs(savedMs, "manifest.coldInstallMs - restoreMs", ["fixture.DEPENDENCIES.coldInstallMs", "fixture.DEPENDENCIES.restoreMs"]),
    sessionSaved: secs(savedMs * DEPENDENCIES.restoresThisSession, "saved per restore x restores this session", ["fixture.DEPENDENCIES"]),
    restores: der(DEPENDENCIES.restoresThisSession, "restores", "restores this session", ["fixture.DEPENDENCIES.restoresThisSession"]),
    key: shortKey(NM_CACHE_PREFIX, DEPENDENCIES.lockfileSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch, DIGEST_SHOWN)
  }
}

// ---------------------------------------------------------------------------
// Build

/** The input set of the rebuild: sorted paths of the sources that missed the cache. */
export const rebuildInputSet = (sources: ReadonlyArray<{ readonly path: string; readonly changed: boolean }> = BUILD_SOURCES): string =>
  sources
    .filter((s) => s.changed)
    .map((s) => s.path)
    .sort()
    .join(",")

/** Rebuild duration in ms from the constant lookup table; an input set missing from the table is an error, never a guess. */
export const rebuildMs = (inputSet: string = rebuildInputSet()): number => {
  const ms = BUILD_DURATIONS_MS[inputSet]
  if (ms === undefined) throw new RangeError(`no build duration for input set ${JSON.stringify(inputSet)}`)
  return ms
}

export const buildFigures = () => {
  const misses = BUILD_SOURCES.filter((s) => s.changed).length
  return {
    sources: der(BUILD_SOURCES.length, "files", "count of BUILD_SOURCES", ["fixture.BUILD_SOURCES"]),
    hits: der(BUILD_SOURCES.length - misses, "hits", "sources whose digest is unchanged", ["fixture.BUILD_SOURCES"]),
    misses: der(misses, "misses", "sources whose digest changed", ["fixture.BUILD_SOURCES"]),
    affected: der(misses, "modules", "modules rebuilt = cache misses", ["fixture.BUILD_SOURCES"]),
    check: secs(BUILD.checkMs, "hash + lookup of the sources", ["fixture.BUILD.checkMs"]),
    rebuild: secs(rebuildMs(), "BUILD_DURATIONS_MS[input set]", ["fixture.BUILD_DURATIONS_MS", "fixture.BUILD_SOURCES"]),
    outputs: der(BUILD.outputsEmitted, "files", "files emitted by tsc", ["fixture.BUILD.outputsEmitted"]),
    key: shortKey(BUILD_CACHE_PREFIX, BUILD.inputSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch, DIGEST_SHOWN)
  }
}

// ---------------------------------------------------------------------------
// Bisect: status bodies in the route's shape, and the figures shown from them

/** The `#n` token of a commit message (what the panel shows for a commit); the oid if there is none. */
export const commitLabel = (c: { readonly oid: string; readonly message?: string }): string => /^#\d+/.exec(c.message ?? "")?.[0] ?? c.oid.slice(0, DIGEST_SHOWN)

/** Figures of one status body. */
export const bisectFigures = (s: BisectStatus) => {
  const passes = s.tally.reduce((n, t) => n + t.passes, 0)
  const fails = s.tally.reduce((n, t) => n + t.fails, 0)
  return {
    range: der(s.candidates, "commits", "status.candidates", ["status route"]),
    steps: der(s.status.observations, "steps", "status.observations", ["status route"]),
    maxSteps: der(BISECT.observations.length, "steps", "observations in the scripted run", ["fixture.BISECT.observations"]),
    confidence: der(s.status.confidence, "probability", "status.confidence (posterior of the culprit, from the Worker)", ["status route"]),
    passes: der(passes, "passes", "sum of tally[].passes", ["status route"]),
    fails: der(fails, "fails", "sum of tally[].fails", ["status route"]),
    culprit: commitLabel(s.status.culprit),
    culpritMessage: s.status.culprit.message ?? s.status.culprit.oid,
    next: s.status.next === null ? null : commitLabel(s.status.next),
    converged: isConverged(s)
  }
}

// ---------------------------------------------------------------------------
// Coordination

export const leaseFigures = () =>
  LEASES.map((l) => ({
    agent: l.agent,
    op: l.op,
    ttl: der(l.ttlS, "s", "lease expiresAt - now", ["fixture.LEASES"]),
    heartbeat: der(l.heartbeatAgeS, "s", "now - last renewal", ["fixture.LEASES"])
  }))

export const leasePolicyFigures = () => ({
  renew: der(LEASE_POLICY.renewS, "s", "renewal interval", ["fixture.LEASE_POLICY.renewS"]),
  lease: der(LEASE_POLICY.leaseS, "s", "lease length", ["fixture.LEASE_POLICY.leaseS"]),
  agents: der(LEASES.length, "agents", "count of LEASES", ["fixture.LEASES"]),
  fresh: der(LEASES.filter((l) => l.heartbeatAgeS < LEASE_POLICY.renewS).length, "agents", "agents whose last renewal is younger than the renewal interval", ["fixture.LEASES", "fixture.LEASE_POLICY"])
})

// ---------------------------------------------------------------------------
// Cost

export const costFigures = () => ({
  cobuilds: der(COST.cobuildsUsd, "USD", "fixture.COST.cobuildsUsd", ["fixture.COST.cobuildsUsd"]),
  gha: der(COST.githubActionsUsd, "USD", "fixture.COST.githubActionsUsd", ["fixture.COST.githubActionsUsd"])
})

// ---------------------------------------------------------------------------
// The event stream: 25 rows, each with a run-time label derived from the durations

export type CleanKind = "SYSTEM" | "ENV" | "ARTIFACT" | "DEPS" | "BUILD" | "BISECT" | "REVIEW" | "NOTES" | "COST"

/** What must have happened for a row to be shown. */
export type Trigger =
  | { readonly on: "launch" }
  | { readonly on: "deps"; readonly phase: "restoring" | "hit" }
  | { readonly on: "build"; readonly phase: "checking" | "checked" | "published" }
  | { readonly on: "bisect"; readonly step: number }
  | { readonly on: "approved" }
  | { readonly on: "note" }

export interface CleanEvent {
  /** Run time of the row in seconds (label `T+...`), derived from the fixture's durations. */
  readonly at: Derived
  readonly kind: CleanKind
  readonly parts: ReadonlyArray<Part>
  readonly trigger: Trigger
}

/** Run-time offsets of the illustrative run, in ms (the constants of the timeline are listed here once). */
export const RUN_OFFSETS_MS = {
  env: 200,
  r2: 400,
  artifact: 600,
  depsStart: 1000,
  restoreStart: 1100,
  buildStart: 3000,
  publishAfterRebuild: 100,
  bisectStart: 6000,
  stepEvery: 2000,
  convergedAfterLastStep: 100,
  reviewAfterConverged: 400,
  approved: 24_000,
  note: 24_500,
  complete: 25_000
} as const

const fig = (d: Derived): Part => ({ fig: d })
const ref = (r: string): Part => ({ ref: r })
const at = (ms: number, what: string): Derived => der(ms / MS_PER_S, "s", `run time of: ${what}`, ["fixture", "RUN_OFFSETS_MS"])

export const cleanEvents = (): ReadonlyArray<CleanEvent> => {
  const o = RUN_OFFSETS_MS
  const d = dependencyFigures()
  const b = buildFigures()
  const c = costFigures()
  const bodies = fixtureStatusBodies()
  const last = bisectFigures(parseLast(bodies))
  const hitAt = o.restoreStart + DEPENDENCIES.restoreMs
  const checkedAt = o.buildStart + BUILD.checkMs
  const rebuiltAt = checkedAt + rebuildMs()
  const n = BISECT.observations.length
  const lastStepAt = o.bisectStart + n * o.stepEvery
  const convergedAt = lastStepAt + o.convergedAfterLastStep
  const steps = BISECT.observations.map(
    (ob, i): CleanEvent => ({
      at: at(o.bisectStart + (i + 1) * o.stepEvery, `bisect step ${i + 1}`),
      kind: "BISECT",
      parts: [
        "step ",
        { fig: der(i + 1, "steps", "observation index", ["fixture.BISECT.observations"]), opts: { bare: true } },
        " of ",
        fig(der(n, "steps", "observations in the scripted run", ["fixture.BISECT.observations"])),
        ": ",
        ref(`#${ob.commit}`),
        ob.failed ? " FAIL" : " PASS"
      ],
      trigger: { on: "bisect", step: i + 1 }
    })
  )
  return [
    { at: at(0, "launch"), kind: "SYSTEM", parts: ["run started: session ", ref(BISECT.sessionId), ", ILLUSTRATIVE DATA"], trigger: { on: "launch" } },
    { at: at(o.env, "env"), kind: "ENV", parts: [`namespace ${ENVIRONMENT.namespace} ready, jurisdiction ${ENVIRONMENT.jurisdiction}`], trigger: { on: "launch" } },
    { at: at(o.r2, "r2"), kind: "ENV", parts: [`R2 ${ENVIRONMENT.r2}: bucket ${ENVIRONMENT.bucket}`], trigger: { on: "launch" } },
    {
      at: at(o.artifact, "artifact"),
      kind: "ARTIFACT",
      parts: [`repo ${ENVIRONMENT.repo}: `, fig(environmentFigures().commits), ` on ${ENVIRONMENT.branch}`],
      trigger: { on: "launch" }
    },
    {
      at: at(o.depsStart, "deps lookup"),
      kind: "DEPS",
      parts: ["lockfile ", ref(shortDigest(DEPENDENCIES.lockfileSha256, DIGEST_SHOWN)), " hashed (", ref(`${RUNNER.platform}-${RUNNER.arch}`), ", abi ", ref(RUNNER.abi), ")"],
      trigger: { on: "deps", phase: "restoring" }
    },
    { at: at(o.restoreStart, "restore start"), kind: "DEPS", parts: ["restoring nm-cache entry (", { fig: d.size, opts: { digits: 0 } }, ")"], trigger: { on: "deps", phase: "restoring" } },
    { at: at(hitAt, "restore hit"), kind: "DEPS", parts: ["restore hit in ", fig(d.restore), ", ", fig(d.saved), " saved"], trigger: { on: "deps", phase: "hit" } },
    { at: at(o.buildStart, "build start"), kind: "BUILD", parts: [fig(b.sources), " hashed with ", ref(BUILD.toolVersion)], trigger: { on: "build", phase: "checking" } },
    { at: at(checkedAt, "build checked"), kind: "BUILD", parts: ["cache lookup: ", fig(b.hits), ", ", fig(b.misses)], trigger: { on: "build", phase: "checked" } },
    { at: at(rebuiltAt, "rebuild done"), kind: "BUILD", parts: [fig(b.affected), " rebuilt in ", fig(b.rebuild)], trigger: { on: "build", phase: "published" } },
    {
      at: at(rebuiltAt + o.publishAfterRebuild, "outputs published"),
      kind: "BUILD",
      parts: ["outputs PUT with If-None-Match, then manifest.json"],
      trigger: { on: "build", phase: "published" }
    },
    {
      at: at(o.bisectStart, "bisect start"),
      kind: "BISECT",
      parts: ["session ", ref(BISECT.sessionId), " over ", fig(last.range), ", predicate ", ref(BISECT.predicate)],
      trigger: { on: "bisect", step: 0 }
    },
    ...steps,
    {
      at: at(convergedAt, "converged"),
      kind: "BISECT",
      parts: ["converged: culprit=", ref(last.culprit), " confidence=", fig(last.confidence)],
      trigger: { on: "bisect", step: n }
    },
    { at: at(convergedAt + o.reviewAfterConverged, "review requested"), kind: "REVIEW", parts: ["awaiting approval"], trigger: { on: "bisect", step: n } },
    { at: at(o.approved, "approved"), kind: "REVIEW", parts: ["approved by user"], trigger: { on: "approved" } },
    { at: at(o.note, "note"), kind: "NOTES", parts: ["git note written on ", ref(last.culprit)], trigger: { on: "note" } },
    { at: at(o.complete, "complete"), kind: "COST", parts: ["clean run complete: ", { fig: c.cobuilds, opts: { digits: 3 } }, " (vs ", fig(c.gha), " GitHub Actions)"], trigger: { on: "note" } }
  ]
}

const parseLast = (bodies: ReadonlyArray<unknown>): BisectStatus => parseBisectStatus(bodies[bodies.length - 1])
