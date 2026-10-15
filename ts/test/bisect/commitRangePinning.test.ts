/**
 * `commitRange` pins the bad ref to a commit before paging `log()`.
 *
 * P1 With commit-id paging (the fast path), a push between two pages does not
 *    change the range: it is exactly the first-parent chain of the commit the
 *    branch pointed at when the search started.
 * P2 Without commit-id paging (the fallback), a push between two pages is
 *    detected and the range is recomputed; the result is a gap-free,
 *    duplicate-free first-parent chain ending at the branch's new head.
 * P3 A branch that moves during every attempt is an error, never a range.
 * N1 Negation: paging the branch by name without pinning (the previous
 *    algorithm) really does return duplicated commits under the same push,
 *    so P1 and P2 test a real hazard.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { announce } from "../harness.js"
import { commitRange, withRepo } from "./run.js"
import { type FakeRepo, firstParentChain, makeFakeNamespace, makeRepo } from "./fakeArtifacts.js"
import { CommitRangeError, LOG_PAGE_LIMIT, normalizeCommit } from "../../src/bisect/index.js"

announce("test/bisect/commitRangePinning.test.ts")

let pushed = 0
/** Push `k` new commits on top of `main`. */
const push = (r: FakeRepo, k: number): void => {
  for (let i = 0; i < k; i++) {
    const parent = r.refs.get("main")!
    const oid = createHash("sha1").update(`push-${pushed++}`).digest("hex")
    r.commits.set(oid, { oid, parents: [parent], message: `pushed ${pushed}` })
    r.refs.set("main", oid)
  }
}

const LEN = 2 * LOG_PAGE_LIMIT + 300

describe("commitRange pins the bad ref (P1-P3, N1)", () => {
  it("P1: with commit-id paging, a push after the first page leaves the range unchanged", async () => {
    const { repo, mainline } = makeRepo(LEN)
    const expected = firstParentChain(repo, mainline.at(-1)!).slice(0, -1).reverse()
    const ns = makeFakeNamespace({ r: repo }, { beforeLog: (o, _call, r) => (o.offset === LOG_PAGE_LIMIT ? push(r, 7) : undefined) })
    const range = await withRepo(ns, "r", (h) => commitRange(h, mainline[0]!, "main"))
    expect(range.map((c) => c.oid)).toEqual(expected)
    expect(new Set(range.map((c) => c.oid)).size).toBe(range.length)
    expect(pushed).toBeGreaterThan(0)
    // Every page after the resolution was requested for the pinned commit id, not for "main".
    expect(ns.logCalls.filter((c) => (c.offset ?? 0) > 0).every((c) => c.ref === mainline.at(-1))).toBe(true)
  })

  it("P2: without commit-id paging, a mid-paging push is detected and the range recomputed", async () => {
    const { repo, mainline } = makeRepo(LEN)
    let pushes = 0
    const ns = makeFakeNamespace(
      { r: repo },
      {
        logByCommitId: false,
        beforeLog: (o, _call, r) => {
          if (o.ref === "main" && o.offset === LOG_PAGE_LIMIT && pushes === 0) {
            pushes++
            push(r, 5)
          }
        }
      }
    )
    const range = await withRepo(ns, "r", (h) => commitRange(h, mainline[0]!, "main"))
    const head = repo.refs.get("main")!
    const expected = firstParentChain(repo, head).slice(0, -1).reverse()
    expect(pushes).toBe(1)
    expect(range.map((c) => c.oid)).toEqual(expected)
    expect(range.at(-1)!.oid).toBe(head)
    expect(new Set(range.map((c) => c.oid)).size).toBe(range.length)
  })

  it("P3: a branch that moves during every attempt is an error", async () => {
    const { repo, mainline } = makeRepo(LEN)
    const ns = makeFakeNamespace(
      { r: repo },
      { logByCommitId: false, beforeLog: (o, _call, r) => (o.ref === "main" && o.offset === LOG_PAGE_LIMIT ? push(r, 1) : undefined) }
    )
    await expect(withRepo(ns, "r", (h) => commitRange(h, mainline[0]!, "main"))).rejects.toThrow(CommitRangeError)
    await expect(withRepo(ns, "r", (h) => commitRange(h, mainline[0]!, "main"))).rejects.toThrow(/moved while its history was being read/)
  })

  it("N1: unpinned paging by branch name duplicates commits under the same push", async () => {
    const { repo, mainline } = makeRepo(LEN)
    const ns = makeFakeNamespace({ r: repo }, { beforeLog: (o, _call, r) => (o.offset === LOG_PAGE_LIMIT ? push(r, 7) : undefined) })
    const naive = await withRepo(ns, "r", async (h) => {
      const out: string[] = []
      for (let offset = 0; ; offset += LOG_PAGE_LIMIT) {
        const page = (await h.log({ ref: "main", limit: LOG_PAGE_LIMIT, offset })).map((c) => normalizeCommit(c).oid)
        for (const oid of page) {
          if (oid === mainline[0]) return out
          out.push(oid)
        }
        if (page.length < LOG_PAGE_LIMIT) return out
      }
    })
    expect(new Set(naive).size).toBeLessThan(naive.length)
  })
})
