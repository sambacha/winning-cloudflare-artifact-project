/**
 * Process entry point of the `bayesect` CLI (`cli.ts`). Built to
 * `dist/bisect/bin.js` by `pnpm build`.
 *
 * Runs through `runMain` (style guide § 2.2): SIGINT/SIGTERM interrupts the
 * main fiber, which aborts the CLI's signal; the interruption completes once
 * `main` has settled (scoped resources such as the temporary clone and
 * worktrees are released by its own finalizers), and the process exits 130.
 * A second signal exits at once.
 */
import { fromAbortablePromise, runMain } from "../fx/index.js"
import { main } from "./cli.js"

runMain(
  fromAbortablePromise((signal) =>
    main(process.argv.slice(2), {
      env: process.env,
      out: (l) => process.stdout.write(`${l}\n`),
      err: (l) => process.stderr.write(`${l}\n`),
      now: () => Date.now(),
      cwd: process.cwd(),
      signal
    })
  )
)
