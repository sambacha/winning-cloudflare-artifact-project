/**
 * Bayesian bisection over the first-parent history of a Cloudflare
 * Artifacts repository.
 *
 * History comes from `repo.log({ ref, limit, offset })` (see
 * `artifactsApi.ts` for the documented semantics: first-parent chain, newest
 * first, `limit ≤ 1000`, empty array for an unresolved ref). The same
 * `CommitLog` interface is implemented by the Workers binding, by the REST
 * client (`artifactsRest.ts`) and by a local Git checkout (`localGit.ts`), so
 * the range logic below is shared by all three.
 *
 * Because `log()` follows first parents only, the candidates are the
 * first-parent commits of the bad ref. A culprit that entered through a
 * merge is reported as that merge commit (the same granularity as
 * `git bisect --first-parent`).
 *
 * Fixes relative to the proposal's `start()`:
 * - the good commit is the newest commit of `goodRef`
 *   (`log({ ref: goodRef, limit: 1 })[0]`), or `readCommit(goodRef)` when
 *   `goodRef` is a full hash and the handle can read commits. The sketch used
 *   the *last* entry of a 1000-commit page, i.e. the oldest commit in that
 *   window;
 * - the bad ref's history is paged with `offset` until the good commit is
 *   found, instead of assuming it lies in the first 1000 commits;
 * - if the good commit is not a first-parent ancestor of the bad one the
 *   range is an error. The sketch's `findIndex` then returned `-1` and the
 *   filter silently produced an empty range;
 * - the range is reversed to oldest-first, the indexing of `model.ts`.
 */
import type { BisectModel, Rate } from "./model.js"
import { type BisectOptions, type BisectResult, bisectEffect, type RunOutcome } from "./engine.js"
import {
  ArtifactsShapeError,
  callUpstream,
  type CommitInfo,
  isFullHash,
  LOG_PAGE_LIMIT,
  normalizeCommit,
  UpstreamError,
  validate
} from "./artifactsApi.js"
import { Data, Effect, Option } from "../fx/index.js"
import { CommitOid } from "../ids.js"

export { type CommitInfo, LOG_PAGE_LIMIT } from "./artifactsApi.js"

/** Options of one `log()` page request. */
export interface RefLogOptions {
  readonly ref: string
  readonly limit?: number
  readonly offset?: number
}

/**
 * The part of an Artifacts repository handle that bisection needs. The
 * methods are Promise-shaped because they are the external boundary (the
 * Workers binding, the REST client, a local Git checkout); this module lifts
 * every call with {@link callUpstream}.
 */
export interface CommitLog {
  readonly log: (opts: RefLogOptions) => Promise<ReadonlyArray<unknown>>
  readonly readCommit?: (hash: string) => Promise<unknown | null>
}

/** The good/bad refs do not delimit a first-parent range. */
export class CommitRangeError extends Data.TaggedError("CommitRangeError")<{ readonly message: string }> {
  override readonly name = "CommitRangeError"
  /** @param message - Why the range is invalid. */
  constructor(message: string) {
    super({ message })
  }
}

/** Failures of the history queries below. */
export type HistoryError = CommitRangeError | ArtifactsShapeError | UpstreamError

const normalize = (raw: unknown): Effect.Effect<CommitInfo, ArtifactsShapeError> =>
  validate<CommitInfo, ArtifactsShapeError>(() => normalizeCommit(raw))

/**
 * Resolve a ref to its commit (newest first-parent commit of the ref).
 *
 * @param repo - History source.
 * @param ref - Branch, tag or full commit hash.
 * @returns The commit.
 */
export const resolveRef = (repo: CommitLog, ref: string): Effect.Effect<CommitInfo, HistoryError> =>
  Effect.gen(function* () {
    const { readCommit } = repo
    // A full hash (any case) is read directly; the id is branded `CommitOid` after normalising to lower case.
    const oid = isFullHash(ref) ? Option.getOrUndefined(CommitOid.option(ref.toLowerCase())) : undefined
    if (oid !== undefined && readCommit !== undefined) {
      const raw = yield* callUpstream("repo.readCommit", () => readCommit.call(repo, oid))
      if (raw === null || raw === undefined) return yield* Effect.fail(new CommitRangeError(`commit ${ref} does not exist`))
      return yield* normalize(raw)
    }
    const [raw] = yield* callUpstream("repo.log", () => repo.log({ ref, limit: 1 }))
    if (raw === undefined) {
      return yield* Effect.fail(new CommitRangeError(`ref ${JSON.stringify(ref)} cannot be resolved (log() returned no commits)`))
    }
    return yield* normalize(raw)
  })

/** Pinning attempts when the bad ref has to be paged by name (see {@link commitRange}). */
export const PIN_ATTEMPTS = 3

/**
 * Page the first-parent history of `ref` (newest first) until `good` is
 * found. `expectHead` is the commit the first entry must be; a page 0 that
 * is empty or starts elsewhere returns `null` (the caller decides).
 */
const pageUntilGood = (
  repo: CommitLog,
  ref: string,
  expectHead: string,
  good: CommitInfo,
  goodRef: string,
  badRef: string,
  maxCommits: number
): Effect.Effect<ReadonlyArray<CommitInfo> | null, HistoryError> =>
  Effect.gen(function* () {
    const newestFirst: Array<CommitInfo> = []
    for (let offset = 0; ; offset += LOG_PAGE_LIMIT) {
      const rawPage = yield* callUpstream("repo.log", () => repo.log({ ref, limit: LOG_PAGE_LIMIT, offset }))
      const page = yield* Effect.forEach(rawPage, normalize)
      if (offset === 0 && (page.length === 0 || page[0]!.oid !== expectHead)) return null
      for (const c of page) {
        if (c.oid === good.oid) {
          if (newestFirst.length === 0) return yield* Effect.fail(new CommitRangeError("good and bad refs point at the same commit"))
          return newestFirst.reverse()
        }
        newestFirst.push(c)
        if (newestFirst.length > maxCommits) {
          return yield* Effect.fail(new CommitRangeError(`good commit not found within ${maxCommits} first-parent commits of ${badRef}`))
        }
      }
      if (page.length < LOG_PAGE_LIMIT) {
        return yield* Effect.fail(new CommitRangeError(`${goodRef} (${good.oid}) is not a first-parent ancestor of ${badRef}`))
      }
    }
  })

/**
 * The candidate commits for a search, oldest first: every first-parent
 * commit after the good commit, up to and including the bad commit.
 *
 * The bad ref is resolved to a commit **before** paging, and the pages are
 * requested for that commit id, so a push to the branch between two pages
 * cannot shift the offsets (which would duplicate or skip commits). Paging
 * by a commit id is not documented for `log()`. If the first page for the
 * id is empty or does not start at it, the branch is paged by name instead
 * and re-resolved afterwards; if it moved meanwhile the whole range is
 * recomputed (at most {@link PIN_ATTEMPTS} times), and a branch that keeps
 * moving is an error rather than a silently inconsistent range.
 *
 * @param repo - History source.
 * @param goodRef - A ref known not to show the bug.
 * @param badRef - A ref known to show the bug.
 * @param maxCommits - Upper bound on the range length.
 * @returns The range, oldest first.
 */
export const commitRange = (
  repo: CommitLog,
  goodRef: string,
  badRef: string,
  maxCommits = 10_000
): Effect.Effect<ReadonlyArray<CommitInfo>, HistoryError> =>
  Effect.gen(function* () {
    const good = yield* resolveRef(repo, goodRef)
    for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt++) {
      const head = yield* resolveRef(repo, badRef).pipe(
        Effect.mapError((e) => (e instanceof CommitRangeError ? new CommitRangeError(`ref ${JSON.stringify(badRef)} cannot be resolved`) : e))
      )
      if (head.oid === good.oid) return yield* Effect.fail(new CommitRangeError("good and bad refs point at the same commit"))
      const pinned = yield* pageUntilGood(repo, head.oid, head.oid, good, goodRef, badRef, maxCommits)
      if (pinned !== null) return pinned
      if (head.oid === badRef) return yield* Effect.fail(new CommitRangeError(`ref ${JSON.stringify(badRef)} cannot be resolved`))
      const byName = yield* pageUntilGood(repo, badRef, head.oid, good, goodRef, badRef, maxCommits)
      const after = yield* resolveRef(repo, badRef)
      if (byName !== null && after.oid === head.oid) return byName
    }
    return yield* Effect.fail(new CommitRangeError(`${badRef} moved while its history was being read (${PIN_ATTEMPTS} attempts); retry`))
  })

/** Configuration of {@link bisectRepo}. */
export interface RepoBisectConfig<E, R> {
  readonly repo: CommitLog
  readonly goodRef: string
  readonly badRef: string
  readonly newRate: Rate
  readonly oldRate: Rate
  /** Optional prior weight per candidate commit (e.g. higher for commits touching suspicious files). */
  readonly priorWeight?: (commit: CommitInfo) => number
  /** Runs the test at a commit; `true` = the bug showed, `"skip"` = untestable. */
  readonly predicate: (commit: CommitInfo) => Effect.Effect<RunOutcome, E, R>
  readonly options: BisectOptions
}

/** A search result together with the commit range it ran over. */
export interface RepoBisectResult extends BisectResult {
  readonly range: ReadonlyArray<CommitInfo>
  readonly culpritCommit: CommitInfo
}

/**
 * Compute the range between the refs and run a Bayesian search over it.
 *
 * @param cfg - Repository, refs, model rates and predicate.
 * @returns The result and the most likely culprit commit.
 */
export const bisectRepo = <E, R>(cfg: RepoBisectConfig<E, R>): Effect.Effect<RepoBisectResult, E | HistoryError | RangeError, R> =>
  Effect.gen(function* () {
    const range = yield* commitRange(cfg.repo, cfg.goodRef, cfg.badRef)
    const model: BisectModel = {
      n: range.length,
      newRate: cfg.newRate,
      oldRate: cfg.oldRate,
      ...(cfg.priorWeight ? { prior: range.map(cfg.priorWeight) } : {})
    }
    const result = yield* bisectEffect(model, (i) => cfg.predicate(range[i]!), cfg.options)
    return { ...result, range, culpritCommit: range[result.culprit]! }
  })
