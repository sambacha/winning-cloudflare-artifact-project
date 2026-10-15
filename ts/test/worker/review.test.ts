/**
 * Review gate: `approve` writes a context note on the culprit with a
 * short-lived write token and records the decision once; `reject` records a
 * rejection without a note. The note writer runs against a real Git
 * repository over `file://`.
 *
 * R1 approve: one write token (scope write, 300 s), never returned; the note
 *    text carries session, culprit, confidence, predicate, approver, time.
 * R2 the decision is recorded once: a second approve / reject is 409 and
 *    does not mint a token or write a note.
 * R3 reject: needs a comment, records `rejected`, no token, no note.
 * R4 the note writer appends `refs/notes/commits`, is idempotent per
 *    session, and retries a push rejected by a concurrent notes push.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { makeLocalSandbox } from "../../src/bisect/localSandbox.js"
import { formatNote, NOTES_REF, noteMarker, type WriteNoteInput, writeNote } from "../../src/bisect/notes.js"
import { makeMemorySessionStore } from "../../src/bisect/session.js"
import { Effect, Redacted } from "../../src/fx/index.js"
import { SessionId } from "../../src/ids.js"
import { handle, type HandlerConfig } from "../../src/worker/handler.js"
import { makeR2ResultStore, resultFromSession } from "../../src/worker/resultStore.js"
import type { R2BucketLike } from "../../src/worker/r2Bucket.js"
import { makeFakeNamespace, makeRepo } from "../bisect/fakeArtifacts.js"
import { makeConditionalBucket } from "../workflows/fakes.js"

const TOKEN = "secret-token"
const emptyBucket: R2BucketLike = { list: async () => ({ objects: [], truncated: false }), get: async () => null }

const setup = () => {
  const { repo, mainline } = makeRepo(12)
  const artifacts = makeFakeNamespace({ proj: repo }, { idField: "id" })
  const store = makeMemorySessionStore()
  const bucket = makeConditionalBucket()
  const results = makeR2ResultStore(bucket)
  const notes: Array<WriteNoteInput> = []
  let ids = 0
  const cfg: HandlerConfig = {
    scope: "trusted",
    token: Redacted.make(TOKEN),
    now: () => 1000,
    bisect: {
      artifacts,
      store,
      now: () => 1000,
      newId: () => SessionId((++ids).toString(16).padStart(16, "0")),
      results,
      notes: (i) => Effect.sync(() => (notes.push(i), { ref: NOTES_REF, commit: i.commit, appended: true, attempts: 1 })),
      drive: (p) => Effect.succeed(`bisect-${p.sessionId}`)
    }
  }
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await handle(
      new Request(`https://worker.example${p}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      }),
      emptyBucket,
      cfg
    )
    return { status: r.status, body: (await r.json()) as Record<string, any> }
  }
  /** Start a session and write its result manifest (what the driver's last step does). */
  const finished = async () => {
    const start = await call("POST", "/api/bisect", { repo: "proj", good: mainline[0], bad: "main" })
    const id = SessionId(start.body["id"])
    const s = (await Effect.runPromise(store.load(id)))!.session
    await Effect.runPromise(results.create(resultFromSession(id, s, { predicate: "npm test", driver: "workflow:test", createdAt: 5 })))
    return id
  }
  return { call, finished, artifacts, notes, bucket }
}

describe("review gate", () => {
  it("R1/R2: approve writes one note with a 300 s write token and is decided once", async () => {
    const { call, finished, artifacts, notes, bucket } = setup()
    const id = await finished()
    const before = artifacts.tokens.length
    const r = await call("POST", `/api/bisect/${id}/approve`, { principal: "alice", comment: "matches the stack trace" })
    expect(r.status).toBe(200)
    const review = r.body["result"]["review"]
    expect(review).toMatchObject({ decision: "approved", principal: "alice", comment: "matches the stack trace" })
    expect(artifacts.tokens.slice(before)).toEqual([expect.objectContaining({ scope: "write", ttl: 300 })])
    expect(JSON.stringify(r.body)).not.toContain(artifacts.tokens.at(-1)!.plaintext)
    expect(notes).toHaveLength(1)
    const text = notes[0]!.text
    for (const field of [noteMarker(id), `culprit: ${review.note.commit}`, "confidence: ", "predicate: npm test", "approved-by: alice", "approved-at: "]) expect(text).toContain(field)
    expect(review.note.text).toBe(text)

    const again = await call("POST", `/api/bisect/${id}/approve`, { principal: "bob" })
    expect(again.status).toBe(409)
    const rej = await call("POST", `/api/bisect/${id}/reject`, { principal: "bob", comment: "no" })
    expect(rej.status).toBe(409)
    expect(notes).toHaveLength(1)
    expect(artifacts.tokens.length).toBe(before + 1)
    expect(bucket.unconditional).toEqual([])
    const got = await call("GET", `/api/bisect/${id}/result`)
    expect(got.body["result"]["review"]["decision"]).toBe("approved")
  })

  it("R3: reject needs a comment and writes no note", async () => {
    const { call, finished, artifacts, notes } = setup()
    const id = await finished()
    const before = artifacts.tokens.length
    expect((await call("POST", `/api/bisect/${id}/reject`, { principal: "bob" })).status).toBe(400)
    const r = await call("POST", `/api/bisect/${id}/reject`, { principal: "bob", comment: "flaky infra, not the code" })
    expect(r.status).toBe(200)
    expect(r.body["result"]["review"]).toMatchObject({ decision: "rejected", note: null })
    expect(notes).toHaveLength(0)
    expect(artifacts.tokens.length).toBe(before)
  })

  it("drive starts the workflow for an existing session only", async () => {
    const { call, finished } = setup()
    const id = await finished()
    const r = await call("POST", `/api/bisect/${id}/drive`, { fallbackBranch: "main" })
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ id, instanceId: `bisect-${id}` })
    expect((await call("POST", "/api/bisect/00000000000000aa/drive", {})).status).toBe(404)
    expect((await call("POST", `/api/bisect/${id}/drive`, { fallbackBranch: "--upload-pack=x" })).status).toBe(400)
  })

  it("result / approve before the manifest exists is 404; bad input is 400", async () => {
    const { call } = setup()
    const start = await call("POST", "/api/bisect", { repo: "proj", good: undefined, bad: "main" })
    expect(start.status).toBe(400)
    const id = "00000000000000aa"
    expect((await call("GET", `/api/bisect/${id}/result`)).status).toBe(404)
    expect((await call("POST", `/api/bisect/${id}/approve`, { principal: "a" })).status).toBe(404)
    expect((await call("POST", `/api/bisect/${id}/approve`, { principal: "" })).status).toBe(400)
  })
})

const gitRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notes-remote-"))
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, env }).toString().trim()
  git("init", "-q", "-b", "main")
  const oids: string[] = []
  for (let i = 0; i < 4; i++) {
    writeFileSync(path.join(dir, "f.txt"), String(i))
    git("add", "-A")
    git("commit", "-q", "-m", `c${i}`)
    oids.push(git("rev-parse", "HEAD"))
  }
  return { dir, oids, git }
}

const noteInput = (dir: string, commit: string, sessionId: string, text: string): WriteNoteInput => ({
  remote: `file://${dir}`,
  token: "write-token",
  commit,
  branch: "main",
  depth: 5,
  sessionId,
  text,
  workdir: path.join(mkdtempSync(path.join(tmpdir(), "notes-wd-")), "repo")
})

const sandbox = (onExec?: (c: string) => void) =>
  makeLocalSandbox({ scratch: mkdtempSync(path.join(tmpdir(), "notes-sb-")), baseEnv: { PATH: process.env["PATH"]!, HOME: tmpdir() }, ...(onExec ? { onExec } : {}) })

describe("note writer on a real repository (R4)", () => {
  const fields = (sessionId: string, commit: string) =>
    formatNote({
      result: { sessionId, culprit: { oid: commit }, confidence: 0.97, predicate: "npm test", observations: 8, skipped: ["x"], driver: "workflow:w" },
      principal: "alice",
      at: Date.UTC(2026, 9, 14),
      comment: ""
    })

  it("appends, is idempotent per session, and a second session appends below", async () => {
    const { dir, oids, git } = gitRepo()
    const first = await Effect.runPromise(writeNote(sandbox(), noteInput(dir, oids[2]!, "s1", fields("s1", oids[2]!))))
    expect(first).toMatchObject({ appended: true, ref: NOTES_REF })
    expect(git("notes", "show", oids[2]!)).toContain("bisect-session: s1")
    const repeat = await Effect.runPromise(writeNote(sandbox(), noteInput(dir, oids[2]!, "s1", fields("s1", oids[2]!))))
    expect(repeat.appended).toBe(false)
    await Effect.runPromise(writeNote(sandbox(), noteInput(dir, oids[2]!, "s2", fields("s2", oids[2]!))))
    const shown = git("notes", "show", oids[2]!)
    expect(shown.match(/bisect-session: /g)).toHaveLength(2)
    expect(shown).toContain("approved-at: 2026-10-14T00:00:00.000Z")
  }, 60_000)

  it("retries when a concurrent notes push wins the race", async () => {
    const { dir, oids, git } = gitRepo()
    let raced = false
    const sb = sandbox((c) => {
      if (!raced && c.includes(" push ")) {
        raced = true
        git("notes", "append", "-m", "someone else", oids[1]!)
      }
    })
    const r = await Effect.runPromise(writeNote(sb, noteInput(dir, oids[3]!, "s9", fields("s9", oids[3]!))))
    expect(r).toMatchObject({ appended: true, attempts: 2 })
    expect(git("notes", "show", oids[1]!)).toBe("someone else")
    expect(git("notes", "show", oids[3]!)).toContain("bisect-session: s9")
  }, 60_000)
})
