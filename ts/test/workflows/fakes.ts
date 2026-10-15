/**
 * Test doubles for the bisect driver: an R2 bucket with the Workers `onlyIf`
 * contract (that can refuse unconditional writes and "lose" writes), and a
 * scripted sandbox whose predicate outcome depends on the checked-out commit.
 */
import type { SandboxFactory, SandboxLike } from "../../src/bisect/sandbox.js"
import type { R2PutOptionsLike, R2WritableBucketLike } from "../../src/worker/bisectStore.js"

export interface ConditionalBucket extends R2WritableBucketLike {
  readonly objects: Map<string, { body: string; etag: string }>
  /** Writes made without a condition (must stay empty: every write is conditional). */
  readonly unconditional: Array<string>
  /** Drop the next successful write to keys matching `p` (simulates R2 losing a completed write). */
  loseNextWrite: ((key: string) => boolean) | null
}

export const makeConditionalBucket = (): ConditionalBucket => {
  const objects = new Map<string, { body: string; etag: string }>()
  const unconditional: Array<string> = []
  let n = 0
  const b: ConditionalBucket = {
    objects,
    unconditional,
    loseNextWrite: null,
    get: async (key) => {
      const o = objects.get(key)
      return o === undefined ? null : { etag: o.etag, text: async () => o.body }
    },
    put: async (key: string, value: string, options?: R2PutOptionsLike) => {
      const cur = objects.get(key)
      const c = options?.onlyIf
      if (c instanceof Headers) {
        if (c.get("If-None-Match") === "*" && cur !== undefined) return null
      } else if (c?.etagMatches !== undefined) {
        if (cur?.etag !== c.etagMatches) return null
      } else unconditional.push(key)
      const etag = `"etag-${++n}"`
      if (b.loseNextWrite !== null && b.loseNextWrite(key)) {
        b.loseNextWrite = null
        return { etag }
      }
      objects.set(key, { body: value, etag })
      return { etag }
    }
  }
  return b
}

/** What the scripted predicate does at a commit on its `attempt`-th run there. */
export type Script = (commit: string, attempt: number) => number

export interface ScriptedSandboxes {
  readonly factory: SandboxFactory
  /** Commits the predicate actually ran at, in order. */
  readonly predicateRuns: Array<string>
  readonly created: () => number
  readonly destroyed: () => number
}

/**
 * Sandboxes whose `git` commands succeed (fetch by commit can be made to fail),
 * and whose predicate (`timeout ... sh -c ...`) exits with `script(commit, attempt)`.
 */
export const makeScriptedSandboxes = (script: Script, opts: { readonly fetchByShaFails?: boolean } = {}): ScriptedSandboxes => {
  const predicateRuns: Array<string> = []
  const attempts = new Map<string, number>()
  let created = 0
  let destroyed = 0
  const factory: SandboxFactory = () => {
    created++
    let head: string | null = null
    let fetchedBranch = false
    const ok = { exitCode: 0, stdout: "", stderr: "" }
    const sb: SandboxLike = {
      exec: async (command) => {
        const fetch = /fetch -q --depth=\d+ origin (\S+)$/.exec(command)
        if (fetch) {
          if (/^[0-9a-f]{40}$/.test(fetch[1]!)) return opts.fetchByShaFails ? { exitCode: 128, stdout: "", stderr: "not our ref" } : ok
          fetchedBranch = true
          return ok
        }
        if (command.startsWith("git cat-file -e")) return fetchedBranch ? ok : { exitCode: 1, stdout: "", stderr: "" }
        const co = /git checkout -q --detach (\S+)$/.exec(command)
        if (co) {
          head = co[1]!
          return ok
        }
        if (command.startsWith("timeout ")) {
          if (head === null) throw new Error("predicate ran before checkout")
          const a = (attempts.get(head) ?? 0) + 1
          attempts.set(head, a)
          predicateRuns.push(head)
          return { exitCode: script(head, a), stdout: `ran at ${head}`, stderr: "" }
        }
        return ok
      },
      writeFile: async () => undefined,
      readFile: async () => ({ content: "" }),
      destroy: async () => void destroyed++
    }
    return sb
  }
  return { factory, predicateRuns, created: () => created, destroyed: () => destroyed }
}

/** Hex commit id number `i` (40 chars). */
export const oid = (i: number): string => i.toString(16).padStart(40, "0")
