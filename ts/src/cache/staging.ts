/**
 * Restore staging (decision D-7, "restore into staging, swap atomically").
 *
 * A restore writes into a fresh staging area. Only after every blob has been
 * verified is the staging area swapped into place; on any failure it is
 * discarded. The destination therefore holds either its previous contents or
 * the complete verified entry, never a mixture.
 */
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { Effect } from "../fx/index.js"
import { StoreFailure } from "../store.js"
import { isSafeRelativePath } from "./manifest.js"

export interface StagingSession {
  /** Append a chunk to `relPath` (created on first write). */
  readonly write: (relPath: string, chunk: Uint8Array) => Effect.Effect<void, StoreFailure>
  /** Make the staged tree the destination, atomically. */
  readonly commit: Effect.Effect<void, StoreFailure>
  /** Discard everything staged. Idempotent; never fails. */
  readonly abort: Effect.Effect<void>
}

export interface Staging {
  readonly begin: Effect.Effect<StagingSession, StoreFailure>
}

/** In-memory staging; `committed` is the destination tree. */
export interface MemoryStaging extends Staging {
  readonly committed: () => ReadonlyMap<string, Uint8Array> | undefined
  /** Number of sessions begun / committed / aborted. */
  readonly stats: { begun: number; committed: number; aborted: number }
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export const makeMemoryStaging = (): MemoryStaging => {
  let dest: Map<string, Uint8Array> | undefined
  const stats = { begun: 0, committed: 0, aborted: 0 }
  return {
    committed: () => dest,
    stats,
    begin: Effect.sync(() => {
      stats.begun++
      const tree = new Map<string, Uint8Array>()
      let open = true
      const session: StagingSession = {
        write: (p, chunk) =>
          Effect.suspend(() => {
            if (!open) return Effect.fail(new StoreFailure({ key: p, cause: "session closed" }))
            if (!isSafeRelativePath(p)) return Effect.fail(new StoreFailure({ key: p, cause: "unsafe path" }))
            tree.set(p, concat(tree.get(p) ?? new Uint8Array(0), chunk))
            return Effect.void
          }),
        commit: Effect.suspend(() => {
          if (!open) return Effect.fail(new StoreFailure({ key: "", cause: "session closed" }))
          open = false
          dest = tree
          stats.committed++
          return Effect.void
        }),
        abort: Effect.sync(() => {
          if (open) {
            open = false
            stats.aborted++
          }
        })
      }
      return session
    })
  }
}

const fsFail = (key: string) => (cause: unknown) => new StoreFailure({ key, cause })

/**
 * Filesystem staging for `destDir`: stages into a sibling directory, then
 * swaps with two `rename`s (old → trash, staging → dest). Each `rename` is
 * atomic on POSIX filesystems; between the two there is an instant with no
 * destination, never a partial one.
 */
export const makeFsStaging = (destDir: string): Staging => ({
  begin: Effect.gen(function* () {
    const parent = path.dirname(destDir)
    const base = path.basename(destDir)
    const stage = path.join(parent, `.${base}.staging-${randomUUID()}`)
    yield* Effect.tryPromise({ try: () => fs.mkdir(stage, { recursive: true }), catch: fsFail(stage) })
    let open = true
    const session: StagingSession = {
      write: (rel, chunk) =>
        Effect.suspend(() => {
          if (!open) return Effect.fail(new StoreFailure({ key: rel, cause: "session closed" }))
          if (!isSafeRelativePath(rel)) return Effect.fail(new StoreFailure({ key: rel, cause: "unsafe path" }))
          const target = path.join(stage, ...rel.split("/"))
          return Effect.tryPromise({
            try: async () => {
              await fs.mkdir(path.dirname(target), { recursive: true })
              await fs.appendFile(target, chunk)
            },
            catch: fsFail(target)
          })
        }),
      commit: Effect.suspend(() => {
        if (!open) return Effect.fail(new StoreFailure({ key: destDir, cause: "session closed" }))
        open = false
        const trash = path.join(parent, `.${base}.old-${randomUUID()}`)
        return Effect.tryPromise({
          try: async () => {
            let moved = false
            try {
              await fs.rename(destDir, trash)
              moved = true
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
            }
            await fs.rename(stage, destDir)
            if (moved) await fs.rm(trash, { recursive: true, force: true })
          },
          catch: fsFail(destDir)
        })
      }),
      abort: Effect.suspend(() => {
        if (!open) return Effect.void
        open = false
        return Effect.promise(() => fs.rm(stage, { recursive: true, force: true }).catch(() => undefined))
      })
    }
    return session
  })
})
