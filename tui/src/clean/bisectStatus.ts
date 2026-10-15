/**
 * The bisect status the Bisect panel draws: the body of the Worker's status
 * route (`GET /api/bisect/:id`, `ts/src/worker/bisectRoutes.ts` `statusBody`).
 *
 * The dashboard never computes a posterior. The Worker computes `status`
 * (culprit, confidence, ranking) and the panel only displays it. The source
 * is chosen once, at startup, by `loadBisectStatus`:
 * - `--autoplay` and snapshots use the scripted fixture (`fixture.ts`), with
 *   one status body per observation, in the route's exact shape;
 * - `--live <worker> --session <id>` fetches the route itself.
 *
 * The dashboard cannot import `ts/` (a test enforces this), so the type below
 * mirrors `StatusBody`. `ts/test/worker/tuiBisectContract.test.ts` checks
 * that every body the real route produces is accepted by `parseBisectStatus`.
 */

export interface StatusCommit {
  readonly oid: string
  readonly message?: string
}

export interface StatusRanked {
  readonly commit: StatusCommit
  readonly probability: number
}

export interface StatusTally {
  readonly oid: string
  readonly message?: string
  readonly fails: number
  readonly passes: number
  readonly skips: number
}

export type StopReason = "confidence" | "maxSteps" | "noTestableCommit"

/** `SessionStatus` of `ts/src/bisect/session.ts`. */
export interface SessionStatusBody {
  readonly done: boolean
  readonly stopReason: StopReason | null
  readonly next: StatusCommit | null
  readonly culprit: StatusCommit
  readonly confidence: number
  readonly entropy: number
  readonly observations: number
  readonly skipped: ReadonlyArray<string>
  readonly candidates: number
  readonly ranking: ReadonlyArray<StatusRanked>
  readonly rates: { readonly newMean: number; readonly oldMean: number }
}

/** `StatusBody` of `ts/src/worker/bisectRoutes.ts`. */
export interface BisectStatus {
  readonly id: string
  readonly repo: string
  readonly good: StatusCommit
  readonly badRef: string
  readonly candidates: number
  readonly status: SessionStatusBody
  readonly tally: ReadonlyArray<StatusTally>
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

const fail = (path: string, what: string): never => {
  throw new TypeError(`bisect status: ${path} must be ${what}`)
}

const commit = (x: unknown, path: string): StatusCommit => {
  if (!isRecord(x) || typeof x["oid"] !== "string" || x["oid"].length === 0) return fail(path, "a commit { oid, message? }")
  const m = x["message"]
  if (m !== undefined && typeof m !== "string") return fail(`${path}.message`, "a string")
  return m === undefined ? { oid: x["oid"] } : { oid: x["oid"], message: m }
}

const STOP: ReadonlyArray<StopReason> = ["confidence", "maxSteps", "noTestableCommit"]

/**
 * Validate a status route body. Throws `TypeError` that names the first bad
 * field. Unknown extra fields are ignored, so the route may add fields.
 */
export const parseBisectStatus = (x: unknown): BisectStatus => {
  if (!isRecord(x)) return fail("body", "an object")
  const st = x["status"]
  if (!isRecord(st)) return fail("status", "an object")
  const str = (v: unknown, p: string): string => (typeof v === "string" ? v : fail(p, "a string"))
  const num = (v: unknown, p: string): number => (isNum(v) ? v : fail(p, "a finite number"))
  const stop = st["stopReason"]
  if (stop !== null && !STOP.includes(stop as StopReason)) fail("status.stopReason", `null or one of ${STOP.join(", ")}`)
  const ranking = st["ranking"]
  if (!Array.isArray(ranking)) return fail("status.ranking", "an array")
  const skipped = st["skipped"]
  if (!Array.isArray(skipped) || !skipped.every((s) => typeof s === "string")) return fail("status.skipped", "an array of strings")
  const rates = st["rates"]
  if (!isRecord(rates)) return fail("status.rates", "an object")
  const tally = x["tally"]
  if (!Array.isArray(tally)) return fail("tally", "an array")
  if (typeof st["done"] !== "boolean") fail("status.done", "a boolean")
  const confidence = num(st["confidence"], "status.confidence")
  if (confidence < 0 || confidence > 1) fail("status.confidence", "in [0, 1]")
  return {
    id: str(x["id"], "id"),
    repo: str(x["repo"], "repo"),
    good: commit(x["good"], "good"),
    badRef: str(x["badRef"], "badRef"),
    candidates: num(x["candidates"], "candidates"),
    status: {
      done: st["done"] as boolean,
      stopReason: stop as StopReason | null,
      next: st["next"] === null ? null : commit(st["next"], "status.next"),
      culprit: commit(st["culprit"], "status.culprit"),
      confidence,
      entropy: num(st["entropy"], "status.entropy"),
      observations: num(st["observations"], "status.observations"),
      skipped: skipped as string[],
      candidates: num(st["candidates"], "status.candidates"),
      ranking: ranking.map((r: unknown, i) => {
        if (!isRecord(r)) return fail(`status.ranking[${i}]`, "an object")
        return { commit: commit(r["commit"], `status.ranking[${i}].commit`), probability: num(r["probability"], `status.ranking[${i}].probability`) }
      }),
      rates: { newMean: num(rates["newMean"], "status.rates.newMean"), oldMean: num(rates["oldMean"], "status.rates.oldMean") }
    },
    tally: tally.map((t: unknown, i) => {
      if (!isRecord(t)) return fail(`tally[${i}]`, "an object")
      const c = commit(t, `tally[${i}]`)
      return { ...c, fails: num(t["fails"], `tally[${i}].fails`), passes: num(t["passes"], `tally[${i}].passes`), skips: num(t["skips"], `tally[${i}].skips`) }
    })
  }
}

/** The converged state the storyboard anchors on: the route says the session is done because the confidence target was met. */
export const isConverged = (s: BisectStatus): boolean => s.status.done && s.status.stopReason === "confidence"

/** Where the Bisect panel's status comes from (chosen once at startup). */
export type BisectSource =
  | { readonly kind: "fixture"; readonly bodies: ReadonlyArray<unknown> }
  | { readonly kind: "live"; readonly url: string; readonly token: string; readonly session: string }

/**
 * Load the status bodies for a source: the scripted fixture (one body per
 * observation, validated), or the current body of the live route.
 */
export const loadBisectStatus = async (src: BisectSource, fetchImpl: typeof fetch = fetch): Promise<ReadonlyArray<BisectStatus>> => {
  if (src.kind === "fixture") return src.bodies.map(parseBisectStatus)
  const res = await fetchImpl(`${src.url.replace(/\/+$/, "")}/api/bisect/${encodeURIComponent(src.session)}`, {
    headers: { authorization: `Bearer ${src.token}` }
  })
  if (!res.ok) throw new Error(`bisect status route returned HTTP ${res.status}`)
  return [parseBisectStatus(await res.json())]
}
