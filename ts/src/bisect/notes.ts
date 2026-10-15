/**
 * Context notes: the "why" of a bisection result, attached to the culprit
 * commit as a Git note (`refs/notes/commits`, the default notes ref, so a
 * plain `git notes show <sha>` / `git log --notes` displays it).
 *
 * Written only when a reviewer approves a result (`POST
 * /api/bisect/:id/approve`), with a short-lived **write** token, from a fresh
 * sandbox:
 *
 * 1. fetch the culprit commit (by id; fallback: shallow fetch of the branch)
 *    and the current notes ref, if there is one;
 * 2. if the note on the culprit already carries this session's line, stop
 *    (a retried approval must not append twice);
 * 3. `git notes append`, then push the notes ref;
 * 4. a rejected push (someone else pushed notes in between: not a fast
 *    forward) restarts from 1, up to `attempts` times.
 *
 * The token travels in `ARTIFACTS_TOKEN` and reaches Git as an
 * `http.extraHeader`, as in the predicate step.
 */
import { Data, Effect } from "../fx/index.js"
import type { BisectResultManifest } from "../worker/resultStore.js"
import { type SandboxLike, sandboxCall, shq } from "./sandbox.js"

/** The notes ref written by approvals. */
export const NOTES_REF = "refs/notes/commits"

/** Writing the note failed (Git or the sandbox). */
export class NoteWriteFailed extends Data.TaggedError("NoteWriteFailed")<{ readonly stage: string; readonly detail: string }> {}

/** Fields recorded in a note. */
export interface NoteFields {
  readonly result: Pick<BisectResultManifest, "sessionId" | "culprit" | "confidence" | "predicate" | "observations" | "skipped" | "driver">
  readonly principal: string
  /** Approval time (ms since the epoch, from the Clock). */
  readonly at: number
  readonly comment: string
}

/** First line of every note written for a session (the idempotency marker). */
export const noteMarker = (sessionId: string): string => `bisect-session: ${sessionId}`

/**
 * The note text: `key: value` lines (stable, greppable).
 *
 * @param f - Session result, approver and time.
 */
export const formatNote = (f: NoteFields): string =>
  [
    noteMarker(f.result.sessionId),
    `culprit: ${f.result.culprit.oid}`,
    `confidence: ${f.result.confidence.toFixed(4)}`,
    `predicate: ${f.result.predicate}`,
    `observations: ${f.result.observations}`,
    `skipped: ${f.result.skipped.length}`,
    `driver: ${f.result.driver}`,
    `approved-by: ${f.principal}`,
    `approved-at: ${new Date(f.at).toISOString()}`,
    ...(f.comment.length > 0 ? [`comment: ${f.comment.replaceAll("\n", " ")}`] : [])
  ].join("\n")

/** What {@link writeNote} needs. */
export interface WriteNoteInput {
  readonly remote: string
  /** A **write** token. */
  readonly token: string
  readonly commit: string
  /** Branch used for the fallback fetch. */
  readonly branch: string
  readonly depth: number
  readonly sessionId: string
  readonly text: string
  readonly workdir?: string
  /** Push attempts (default 3). */
  readonly attempts?: number
}

/** Outcome of {@link writeNote}. */
export interface WriteNoteResult {
  readonly ref: string
  readonly commit: string
  /** `false` if the note already carried this session (nothing pushed). */
  readonly appended: boolean
  readonly attempts: number
}

/**
 * Append the note on `commit` and push the notes ref; destroys the sandbox.
 *
 * @param sandbox - A fresh sandbox.
 * @param input - Remote, write token, commit, text.
 */
export const writeNote = (sandbox: SandboxLike, input: WriteNoteInput): Effect.Effect<WriteNoteResult, NoteWriteFailed> =>
  Effect.ensuring(
    Effect.gen(function* () {
      const root = input.workdir ?? "/workspace/notes"
      const env = {
        ARTIFACTS_TOKEN: input.token,
        ARTIFACTS_REMOTE: input.remote,
        GIT_AUTHOR_NAME: "cobuild-review",
        GIT_AUTHOR_EMAIL: "review@cobuild.invalid",
        GIT_COMMITTER_NAME: "cobuild-review",
        GIT_COMMITTER_EMAIL: "review@cobuild.invalid"
      }
      const git = (args: string) => `git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" ${args}`
      const sh = (stage: string, command: string, cwd = root) =>
        sandboxCall(command, () => sandbox.exec(command, { cwd, env })).pipe(Effect.mapError((e) => new NoteWriteFailed({ stage, detail: e.stderrTail })))
      const must = (stage: string, command: string) =>
        Effect.flatMap(sh(stage, command), (r) => (r.exitCode === 0 ? Effect.succeed(r) : Effect.fail(new NoteWriteFailed({ stage, detail: r.stderr.slice(-500) }))))

      yield* must("init", `rm -rf ${shq(root)} && mkdir -p ${shq(root)} && cd ${shq(root)} && git init -q && git remote add origin "$ARTIFACTS_REMOTE"`)
      const depth = Math.max(1, Math.floor(input.depth))
      const bySha = yield* sh("fetch", git(`fetch -q --depth=${depth} origin ${shq(input.commit)}`))
      if (bySha.exitCode !== 0) yield* must("fetch", git(`fetch -q --depth=${depth} origin ${shq(input.branch)}`))
      yield* must("fetch", `git cat-file -e ${shq(`${input.commit}^{commit}`)}`)

      const attempts = Math.max(1, input.attempts ?? 3)
      for (let attempt = 1; attempt <= attempts; attempt++) {
        // The notes ref may not exist yet on the remote: a failed fetch of it is not an error.
        yield* sh("fetch-notes", git(`fetch -q origin "+${NOTES_REF}:${NOTES_REF}"`))
        const existing = yield* sh("show", `git notes --ref=${NOTES_REF} show ${shq(input.commit)}`)
        if (existing.exitCode === 0 && existing.stdout.split("\n").includes(noteMarker(input.sessionId))) {
          return { ref: NOTES_REF, commit: input.commit, appended: false, attempts: attempt } satisfies WriteNoteResult
        }
        yield* must("append", `git notes --ref=${NOTES_REF} append -m ${shq(input.text)} ${shq(input.commit)}`)
        const push = yield* sh("push", git(`push -q origin "${NOTES_REF}:${NOTES_REF}"`))
        if (push.exitCode === 0) return { ref: NOTES_REF, commit: input.commit, appended: true, attempts: attempt } satisfies WriteNoteResult
        // Most likely not a fast-forward (a concurrent notes push): drop the local ref and start over.
        yield* sh("reset-notes", `git update-ref -d ${NOTES_REF}`)
        if (attempt === attempts) return yield* Effect.fail(new NoteWriteFailed({ stage: "push", detail: push.stderr.slice(-500) }))
      }
      return yield* Effect.fail(new NoteWriteFailed({ stage: "push", detail: "no attempt made" }))
    }),
    Effect.promise(() => sandbox.destroy().catch(() => undefined))
  )
