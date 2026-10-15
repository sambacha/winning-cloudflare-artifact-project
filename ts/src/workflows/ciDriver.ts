/**
 * The CI workflow body: what happens on `cf.artifacts.repo.pushed`.
 *
 * A push does **not** start a bisection by itself (the push payload has no
 * good / bad / predicate). Instead:
 *
 * 1. `test-0`: run the predicate (`npm test`) at the pushed commit in a fresh
 *    sandbox (`runPredicateStep`; non-zero exit is data).
 * 2. Green: `green` records the commit as the branch's last green tip
 *    (`ci/<repo>/<branch>/last-green.json`, conditional writes only). Done.
 * 3. Red: `rerun-1..R` run the predicate again at the same commit. If every
 *    run failed the failure is deterministic (not this workflow's business:
 *    a normal CI failure). If some passed it is **intermittent**: the
 *    observed failure fraction becomes the bisection's prior on the new-side
 *    failure rate.
 * 4. Intermittent **and the previous tip of the branch was green**
 *    (`ci/<repo>/<branch>/last-tip.json`): `start` creates the session (the
 *    existing start logic, `POST /api/bisect`, with the failing commit
 *    pinned as `bad` and the last green tip as `good`) and `launch` creates
 *    the BisectWorkflow instance. If the previous tip was already red, an
 *    earlier push started (or declined) the bisection; nothing new starts.
 *    Every finished run records the tip's status.
 *
 * Every step returns its result; nothing is mutated across steps.
 */
import { type BisectSession, type SessionStore, startSession } from "../bisect/session.js"
import type { Rate } from "../bisect/model.js"
import { type PredicateInfraError, type PredicateStepResult, runPredicateStep } from "../bisect/predicateStep.js"
import type { SandboxFactory } from "../bisect/sandbox.js"
import { type ArtifactsNamespaceLike, callUpstream, type UpstreamError, withRepo } from "../bisect/artifactsApi.js"
import { SessionId } from "../ids.js"
import { Clock, Data, Effect, runPromiseOrThrow, Schema } from "../fx/index.js"
import type { R2WritableBucketLike } from "../worker/bisectStore.js"
import type { StepLike } from "./bisectDriver.js"

/** A push, normalised. */
export interface PushEvent {
  readonly repo: string
  /** Full ref, `refs/heads/<branch>`. */
  readonly ref: string
  readonly branch: string
  readonly commit: string
}

/** The push payload could not be read. */
export class InvalidPushEvent extends Data.TaggedError("InvalidPushEvent")<{ readonly reason: string }> {}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const firstString = (o: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v.length > 0) return v
    if (isRecord(v) && typeof v["name"] === "string") return v["name"]
  }
  return undefined
}

/**
 * Read a push event: either the event envelope (`{ type, payload }` or
 * `{ type, data }`) or the payload alone. **The payload field names are
 * unverified** (no published schema was available here); accepted aliases:
 * repository `repo` / `repository` / `repoName` / `name`, ref `ref`, commit
 * `after` / `commit` / `head` / `sha`. Returns `null` for refs outside
 * `refs/heads/` (tags, notes: notes pushes by the review gate must not
 * trigger CI).
 *
 * @param raw - The event as delivered.
 */
export const parsePushEvent = (raw: unknown): PushEvent | null => {
  if (!isRecord(raw)) throw new InvalidPushEvent({ reason: "event is not an object" })
  const body = isRecord(raw["payload"]) ? raw["payload"] : isRecord(raw["data"]) ? raw["data"] : raw
  const repo = firstString(body, ["repo", "repository", "repoName", "name"])
  const ref = firstString(body, ["ref"])
  const commit = firstString(body, ["after", "commit", "head", "sha"])
  if (repo === undefined || ref === undefined || commit === undefined) throw new InvalidPushEvent({ reason: "missing repository, ref or commit" })
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new InvalidPushEvent({ reason: "commit is not a full object id" })
  if (!ref.startsWith("refs/heads/")) return null
  return { repo, ref, branch: ref.slice("refs/heads/".length), commit }
}

/** `ci/<repo>/<branch>/last-green.json` */
export const lastGreenKey = (repo: string, branch: string): string => `ci/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/last-green.json`

const LastGreen = Schema.Struct({ commit: Schema.String, at: Schema.Number })
type LastGreen = typeof LastGreen.Type
const decodeLastGreen = Schema.decodeUnknownEffect(Schema.fromJsonString(LastGreen))

/** `ci/<repo>/<branch>/last-tip.json`: the most recent tip CI judged, and how. */
export const lastTipKey = (repo: string, branch: string): string => `ci/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/last-tip.json`

const LastTip = Schema.Struct({ commit: Schema.String, status: Schema.Literals(["green", "red"]), at: Schema.Number })
type LastTip = typeof LastTip.Type
const decodeLastTip = Schema.decodeUnknownEffect(Schema.fromJsonString(LastTip))

/** Read the last judged tip (`null` if none or unreadable). */
export const readLastTip = (bucket: R2WritableBucketLike, repo: string, branch: string): Effect.Effect<LastTip | null, UpstreamError> =>
  Effect.gen(function* () {
    const o = yield* callUpstream("r2.get", async () => {
      const x = await bucket.get(lastTipKey(repo, branch))
      return x === null ? null : await x.text()
    })
    return o === null ? null : yield* decodeLastTip(o).pipe(Effect.catch(() => Effect.succeed(null)))
  })

/** Record the judged tip (create-only if absent, else compare-and-swap; retried on a lost race). */
export const writeLastTip = (bucket: R2WritableBucketLike, repo: string, branch: string, tip: LastTip, attempts = 5): Effect.Effect<boolean, UpstreamError> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const cur = yield* callUpstream("r2.get", async () => {
        const x = await bucket.get(lastTipKey(repo, branch))
        return x === null ? null : { etag: x.etag }
      })
      const onlyIf = cur === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: cur.etag }
      const put = yield* callUpstream("r2.put", () => bucket.put(lastTipKey(repo, branch), JSON.stringify(tip), { onlyIf, httpMetadata: { contentType: "application/json" } }))
      if (put !== null) return true
    }
    return false
  })

/** Read the last green tip (`null` if none or unreadable). */
export const readLastGreen = (bucket: R2WritableBucketLike, repo: string, branch: string): Effect.Effect<{ readonly value: LastGreen; readonly etag: string } | null, UpstreamError> =>
  Effect.gen(function* () {
    const o = yield* callUpstream("r2.get", async () => {
      const x = await bucket.get(lastGreenKey(repo, branch))
      return x === null ? null : { text: await x.text(), etag: x.etag }
    })
    if (o === null) return null
    const value = yield* decodeLastGreen(o.text).pipe(Effect.catch(() => Effect.succeed(null)))
    return value === null ? null : { value, etag: o.etag }
  })

/**
 * Record `commit` as the last green tip: create-only if absent, otherwise
 * compare-and-swap on the ETag read; retried a few times on a lost race.
 */
export const writeLastGreen = (bucket: R2WritableBucketLike, repo: string, branch: string, commit: string, at: number, attempts = 5): Effect.Effect<boolean, UpstreamError> =>
  Effect.gen(function* () {
    const body = JSON.stringify({ commit, at } satisfies LastGreen)
    for (let i = 0; i < attempts; i++) {
      const cur = yield* readLastGreen(bucket, repo, branch)
      if (cur !== null && cur.value.commit === commit) return true
      const onlyIf = cur === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: cur.etag }
      const put = yield* callUpstream("r2.put", () => bucket.put(lastGreenKey(repo, branch), body, { onlyIf, httpMetadata: { contentType: "application/json" } }))
      if (put !== null) return true
    }
    return false
  })

/** Everything the CI driver talks to. */
export interface CiDriverDeps {
  readonly bucket: R2WritableBucketLike
  readonly credentials: (repo: string) => Effect.Effect<{ readonly remote: string; readonly token: string }, unknown>
  readonly sandbox: SandboxFactory
  readonly predicate: { readonly command: string; readonly timeoutSec: number; readonly noInstall?: boolean; readonly workdir?: string }
  /** Starts the session (the existing `POST /api/bisect` logic) and returns its id and range. */
  readonly startBisect: (p: { readonly repo: string; readonly good: string; readonly bad: string; readonly newRate: Rate }) => Effect.Effect<{ readonly id: string; readonly session: BisectSession }, unknown>
  /** Creates the BisectWorkflow instance for a session; returns the instance id. */
  readonly launchBisect: (p: { readonly sessionId: string; readonly fallbackBranch: string }) => Effect.Effect<string, unknown>
  readonly freshId: () => string
  /** Extra runs after a failure (default 4, i.e. 5 runs in all). */
  readonly reruns?: number
  /** Shallow fetch depth for the pushed commit (default 1). */
  readonly depth?: number
}

/** A predicate run, as stored in a step output. */
export type CiRun = Pick<PredicateStepResult, "outcome" | "reason" | "exitCode" | "durationMs"> | { readonly outcome: "infra"; readonly detail: string }

/** What the CI workflow concluded. */
export type CiOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "green"; readonly commit: string }
  | { readonly kind: "red-deterministic"; readonly commit: string; readonly runs: number }
  | { readonly kind: "red-untestable"; readonly commit: string }
  | { readonly kind: "intermittent-no-baseline"; readonly commit: string; readonly failRate: number; readonly previousTip: "green" | "red" | null }
  | { readonly kind: "bisecting"; readonly commit: string; readonly good: string; readonly failRate: number; readonly sessionId: string; readonly instanceId: string }

const runOnce = (ev: PushEvent, deps: CiDriverDeps, k: number): Effect.Effect<CiRun, unknown> =>
  Effect.gen(function* () {
    const creds = yield* deps.credentials(ev.repo)
    return yield* runPredicateStep(deps.sandbox(`ci-${ev.commit.slice(0, 12)}-${k}-${deps.freshId()}`), {
      remote: creds.remote,
      token: creds.token,
      commit: ev.commit,
      branch: ev.branch,
      depth: deps.depth ?? 1,
      command: deps.predicate.command,
      timeoutSec: deps.predicate.timeoutSec,
      ...(deps.predicate.noInstall ? { noInstall: true } : {}),
      ...(deps.predicate.workdir ? { workdir: deps.predicate.workdir } : {})
    }).pipe(
      Effect.map((r): CiRun => ({ outcome: r.outcome, reason: r.reason, exitCode: r.exitCode, durationMs: r.durationMs })),
      Effect.catchTag("PredicateInfraError", (e: PredicateInfraError) => Effect.succeed<CiRun>({ outcome: "infra", detail: `${e.stage}: ${e.detail}` }))
    )
  })

/**
 * Run the CI workflow for one push event.
 *
 * @param raw - The delivered event.
 * @param step - Workflows `step` (or the local runner).
 * @param deps - Bucket, sandboxes, start / launch hooks.
 */
export const runCiDriver = async (raw: unknown, step: StepLike, deps: CiDriverDeps): Promise<CiOutcome> => {
  const ev = parsePushEvent(raw)
  if (ev === null) return { kind: "ignored", reason: "not a branch push" }
  // What the branch looked like before this push (read before this run records anything).
  const previous = await step.do("previous-tip", () => runPromiseOrThrow(readLastTip(deps.bucket, ev.repo, ev.branch)))
  const recordTip = (status: "green" | "red") =>
    step.do<boolean>(`tip-${status}`, () =>
      runPromiseOrThrow(Effect.flatMap(Clock.currentTimeMillis, (at) => writeLastTip(deps.bucket, ev.repo, ev.branch, { commit: ev.commit, status, at })))
    )
  const first = await step.do<CiRun>("test-0", () => runPromiseOrThrow(runOnce(ev, deps, 0)))
  if (first.outcome === "pass") {
    await step.do<boolean>("green", () =>
      runPromiseOrThrow(Effect.flatMap(Clock.currentTimeMillis, (at) => writeLastGreen(deps.bucket, ev.repo, ev.branch, ev.commit, at)))
    )
    await recordTip("green")
    return { kind: "green", commit: ev.commit }
  }
  if (first.outcome !== "fail") return { kind: "red-untestable", commit: ev.commit }
  const reruns = Math.max(1, deps.reruns ?? 4)
  const outcomes: Array<CiRun["outcome"]> = [first.outcome]
  for (let k = 1; k <= reruns; k++) {
    const r = await step.do<CiRun>(`rerun-${k}`, () => runPromiseOrThrow(runOnce(ev, deps, k)))
    outcomes.push(r.outcome)
  }
  await recordTip("red")
  const fails = outcomes.filter((o) => o === "fail").length
  const passes = outcomes.filter((o) => o === "pass").length
  if (passes === 0) return { kind: "red-deterministic", commit: ev.commit, runs: outcomes.length }
  const failRate = fails / (fails + passes)
  const green = await step.do("last-green", () => runPromiseOrThrow(readLastGreen(deps.bucket, ev.repo, ev.branch)))
  if (previous === null || previous.status !== "green" || green === null || green.value.commit === ev.commit) {
    return { kind: "intermittent-no-baseline", commit: ev.commit, failRate, previousTip: previous?.status ?? null }
  }
  // The reruns are the evidence for the new-side rate: Beta(1 + fails, 1 + passes).
  const newRate: Rate = { kind: "beta", alpha: 1 + fails, beta: 1 + passes }
  const started = await step.do<{ id: string }>("start", () =>
    runPromiseOrThrow(Effect.map(deps.startBisect({ repo: ev.repo, good: green.value.commit, bad: ev.commit, newRate }), (s) => ({ id: s.id })))
  )
  const instanceId = await step.do<string>("launch", () => runPromiseOrThrow(deps.launchBisect({ sessionId: started.id, fallbackBranch: ev.branch })))
  return { kind: "bisecting", commit: ev.commit, good: green.value.commit, failRate, sessionId: started.id, instanceId }
}

/**
 * Deterministic session id for the bisection of a failing push, so that a
 * repeated `start` step (a crash after its body ran but before Workflows
 * checkpointed it) finds the session it already created instead of making a
 * second one: the first 32 hex digits of sha256(`<repo>\n<commit>`).
 */
export const ciSessionId = (repo: string, commit: string): Effect.Effect<SessionId> =>
  Effect.promise(async () => {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo}\n${commit}`)))
    return SessionId(Array.from(d.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join(""))
  })

/**
 * The `startBisect` hook over the existing start logic (`startSession`, the
 * function behind `POST /api/bisect`, which resolves the range with
 * `commitRange`): create the session under {@link ciSessionId}, or load it
 * if a previous attempt already created it.
 */
export const startOrLoadSession =
  (artifacts: ArtifactsNamespaceLike, store: SessionStore) =>
  (p: { readonly repo: string; readonly good: string; readonly bad: string; readonly newRate: Rate }): Effect.Effect<{ readonly id: string; readonly session: BisectSession }, unknown> =>
    Effect.gen(function* () {
      const id = yield* ciSessionId(p.repo, p.bad)
      const existing = yield* store.load(id)
      if (existing !== null) return { id, session: existing.session }
      const now = yield* Clock.currentTimeMillis
      const session = yield* withRepo(artifacts, p.repo, (h) => startSession(h, { repo: p.repo, goodRef: p.good, badRef: p.bad, newRate: p.newRate, now }))
      if (yield* store.create(id, session)) return { id, session }
      const raced = yield* store.load(id)
      if (raced === null) return yield* Effect.fail(new InvalidPushEvent({ reason: `session ${id} could not be created or loaded` }))
      return { id, session: raced.session }
    })
