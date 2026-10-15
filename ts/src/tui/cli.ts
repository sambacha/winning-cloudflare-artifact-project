/**
 * Entry point of the dashboard.
 *
 *   cobuild-tui --snapshot <sec> --seed <n> [--cols 80 --rows 24] [--panel 1-5] [--notes]
 *       print one deterministic frame of the demo scenario and exit (no terminal needed)
 *   cobuild-tui --url <worker> [--repo <name>]... [--context <ctx>] [--session <id>]
 *       live dashboard (Ink); token from COBUILD_API_TOKEN
 *
 * The snapshot path does not load Ink or React; the live path imports the
 * Ink app lazily.
 */
import { SUPPORTED_SIZES } from "./constants.js"
import { parseSnapshotArgs, snapshotText } from "./snapshot.js"

const argv = process.argv.slice(2)
const smallest = SUPPORTED_SIZES[0]
const snap = parseSnapshotArgs(argv, { cols: process.stdout.columns ?? smallest.cols, rows: process.stdout.rows ?? smallest.rows })
if (snap !== null) {
  process.stdout.write(snapshotText(snap))
} else {
  const app = await import("./ink/app.js")
  await app.main(argv)
}
