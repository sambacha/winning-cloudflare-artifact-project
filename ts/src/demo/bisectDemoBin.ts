/**
 * `bisect-demo --state <dir> --seed <s> [--session <id>] [--timeout <sec>]`
 *
 * Run or resume the offline bisect demo (`bisectDemo.ts`) and print one JSON
 * line per completed step and a final result line. Kill it at any time and
 * run the same command again: it resumes from the state directory.
 */
import { parseArgs } from "node:util"
import { runLocalBisectDemo } from "./bisectDemo.js"

const { values } = parseArgs({
  options: { state: { type: "string" }, seed: { type: "string", default: "demo" }, session: { type: "string", default: "demo" }, timeout: { type: "string", default: "10" } }
})
if (values.state === undefined) {
  process.stderr.write("usage: bisect-demo --state <dir> [--seed <s>] [--session <id>] [--timeout <sec>]\n")
  process.exit(2)
}
const out = await runLocalBisectDemo({
  state: values.state,
  seed: values.seed,
  sessionId: values.session,
  timeoutSec: Number(values.timeout),
  wrapStep: (s) => ({
    do: async (name, fn) => {
      const v = await s.do(name, fn)
      process.stdout.write(JSON.stringify({ step: name, value: v }) + "\n")
      return v
    }
  })
})
process.stdout.write(
  JSON.stringify({ result: { culprit: out.result.culprit, confidence: out.result.confidence, observations: out.result.observations, skipped: out.result.skipped }, ran: out.ran.length, replayed: out.replayed.length }) + "\n"
)
