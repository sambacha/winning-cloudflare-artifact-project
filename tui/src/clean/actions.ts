/**
 * The simulated Cloudflare actions of the clean run (`--scenario clean`),
 * derived from the events the run has shown so far (`visibleEvents`), so they
 * follow the same panel-visit rules (M1) as the event stream.
 *
 * Each action names the R2 object or Artifacts repo it addresses. The texts
 * are worded differently from the panels', so no recording anchor of the
 * tape (I2) appears in the strip.
 */
import type { Derived } from "../derive.ts"
import type { Part } from "../scenario.ts"
import type { CleanEvent } from "./figures.ts"
import { BISECT, BUILD, DEPENDENCIES, ENVIRONMENT, RUNNER } from "./fixture.ts"
import { BUILD_CACHE_PREFIX, DIGEST_SHOWN, NM_CACHE_PREFIX, shortKey } from "./keys.ts"

export interface CleanAction {
  readonly at: Derived
  readonly channel: "R2" | "ARTIFACTS"
  readonly verb: string
  readonly target: string
  readonly detail: ReadonlyArray<Part>
}

const nmKey = shortKey(NM_CACHE_PREFIX, DEPENDENCIES.lockfileSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch, DIGEST_SHOWN)
const buildKey = shortKey(BUILD_CACHE_PREFIX, BUILD.inputSha256, RUNNER.abi, RUNNER.platform, RUNNER.arch, DIGEST_SHOWN)
const r2 = (key: string): string => `r2://${ENVIRONMENT.bucket}/${key}`
const repo = `${ENVIRONMENT.repo}.git`

/** The label an event's run time was derived with (`at(ms, label)` in figures.ts). */
const labelOf = (e: CleanEvent): string => e.at.formula.replace(/^run time of: /, "")

/** The action of one event, or null for events that are not a request to R2 or Artifacts. */
export const actionOf = (e: CleanEvent): CleanAction | null => {
  const label = labelOf(e)
  const ref = (r: string): Part => ({ ref: r })
  const a = (channel: CleanAction["channel"], verb: string, target: string, detail: ReadonlyArray<Part>): CleanAction => ({ at: e.at, channel, verb, target, detail })
  if (label === "r2") return a("R2", "HEAD", r2(""), ["bucket reachable -> ", ref("200")])
  if (label === "artifact") return a("ARTIFACTS", "FETCH", repo, ["clone of ", ref(ENVIRONMENT.branch), " for the run"])
  if (label === "deps lookup") return a("R2", "GET", r2(`${nmKey}/manifest.json`), ["manifest -> ", ref("200")])
  if (label === "restore start") return a("R2", "GET", r2(nmKey), ["tarball download started"])
  if (label === "restore hit") return a("R2", "GET", r2(nmKey), ["tarball -> ", ref("200"), ", node_modules restored"])
  if (label === "build checked") return a("R2", "GET", r2(buildKey), ["lookups: ", ...e.parts.slice(1)])
  if (label === "outputs published") return a("R2", "PUT", r2(buildKey), ["outputs (If-None-Match: *), manifest.json last"])
  if (label.startsWith("bisect step ")) {
    const commit = e.parts.find((p): p is { readonly ref: string } => typeof p !== "string" && "ref" in p && p.ref.startsWith("#"))
    return a("ARTIFACTS", "CHECKOUT", repo, [ref(commit?.ref ?? "?"), " probed with ", ref(BISECT.predicate)])
  }
  if (label === "converged") return a("R2", "PUT", r2(`bisect/${BISECT.sessionId}/state.json`), ["session state saved (If-Match)"])
  if (label === "approved") return a("ARTIFACTS", "PR", repo, ["approval recorded"])
  if (label === "note") return a("ARTIFACTS", "PUSH", repo, ["refs/notes/bisect updated"])
  return null
}

/** The actions of the events shown so far, in order. */
export const cleanActions = (events: ReadonlyArray<CleanEvent>): ReadonlyArray<CleanAction> => events.flatMap((e) => {
  const x = actionOf(e)
  return x === null ? [] : [x]
})
