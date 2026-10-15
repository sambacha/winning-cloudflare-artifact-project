#!/usr/bin/env node
/**
 * Process entry point of the `cobuild` CLI (`main.ts`). Built to
 * `dist/cli/bin.js` by `pnpm build` / `npm run build`.
 *
 * Runs through `runMain` (style guide § 2.2): the first SIGINT/SIGTERM
 * interrupts the main fiber. For `run` that aborts the CLI's signal, so
 * running build commands (their whole process groups) are killed and held
 * locks are abandoned — the other cobuild jobs can take over at once — and
 * the interruption completes only after that teardown; `serve` closes its
 * server the same way. The exit status is then 130. Other commands hold no
 * resources and exit 130 at once; a second signal always exits at once.
 */
import { fromAbortablePromise, runMain } from "../fx/index.js"
import { main } from "./main.js"

const argv = process.argv.slice(2)
// Only `run` (locks to abandon) and `serve` (server to close) stop gracefully.
const graceful = argv[0] === "run" || argv[0] === "serve"

runMain(
  fromAbortablePromise((signal) =>
    main(argv, {
      env: process.env,
      out: (l) => process.stdout.write(`${l}\n`),
      err: (l) => process.stderr.write(`${l}\n`),
      echo: (c) => process.stderr.write(c),
      cwd: process.cwd(),
      signal
    })
  ),
  {
    onSignal: (sig) => {
      if (!graceful) process.exit(130)
      process.stderr.write(`[cobuild] ${sig}: stopping (abandoning held locks); send again to exit at once\n`)
    }
  }
)
