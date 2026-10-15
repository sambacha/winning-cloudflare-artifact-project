// Restores the executable bit on the bundled esbuild binary, which some
// checkouts (archive imports, Windows clones) drop. Without it `vitest`
// fails with "Permission denied" before running any test.
import { chmodSync, existsSync, statSync } from "node:fs"

const candidates = [
  `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
  "node_modules/esbuild/bin/esbuild"
]
for (const path of candidates) {
  if (existsSync(path) && (statSync(path).mode & 0o111) === 0) chmodSync(path, 0o755)
}
