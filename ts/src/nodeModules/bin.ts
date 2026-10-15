#!/usr/bin/env node
/**
 * `nm-cache`: the R2 `node_modules` cache from the command line. Built to
 * `dist/nodeModules/bin.js`.
 *
 * ```
 * nm-cache ensure [--dir <project>] [--store r2|fs:<dir>|memory] [--run-id <id>] [--json]
 * nm-cache key    [--dir <project>]
 * ```
 *
 * `ensure` restores `node_modules` from the cache or runs `npm ci` and
 * publishes the result (`ensure.ts`). The store is chosen like the cobuild
 * CLI's (`--store`, else `COBUILD_STORE`, else R2 from `R2_*` variables).
 * Exit status: 0 hit or successful install, 1 install failed, 2 usage error.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { selectStores } from "../cli/main.js"
import { Effect, runMain } from "../fx/index.js"
import { ensureNodeModules, workspaceKeyInput } from "./ensure.js"
import { makeLocalWorkspace } from "./localWorkspace.js"
import { nodeModulesKey } from "./key.js"

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dir = path.resolve(flag("--dir") ?? ".")
const command = argv[0]

const usage = Effect.sync(() => {
  process.stderr.write("usage: nm-cache ensure|key [--dir <project>] [--store r2|fs:<dir>|memory] [--run-id <id>] [--json]\n")
  return 2
})

const program: Effect.Effect<number, unknown> =
  command === "key"
    ? Effect.map(workspaceKeyInput(makeLocalWorkspace(dir)), (k) => {
        process.stdout.write(`${nodeModulesKey(k)}\n`)
        return 0
      })
    : command === "ensure"
      ? Effect.gen(function* () {
          const stores = selectStores(flag("--store"), process.env, process.cwd())
          const r = yield* ensureNodeModules({
            workspace: makeLocalWorkspace(dir),
            store: stores.blobStore,
            runId: flag("--run-id") ?? randomUUID(),
            log: (l) => process.stderr.write(`${l}\n`)
          })
          if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ...r, manifest: undefined })}\n`)
          return 0
        })
      : usage

runMain(program)
