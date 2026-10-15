import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/**
 * When `ink` / `react` are not installed (this repository has no network;
 * the final dependency bump adds them), the dashboard's component tests run
 * against small stand-ins in `test/tui/fakes/` that build plain element
 * trees. Once the packages are installed the real ones are used.
 */
const inkInstalled = existsSync(here("./node_modules/ink/package.json")) && existsSync(here("./node_modules/react/package.json"))

/**
 * The default 5 s per-test timeout made the crash-prefix property of
 * `test/cache/publishRestore.test.ts` fail intermittently when the files ran
 * in parallel (measured: 4.98 s alone). A test that fails on a slow machine
 * and passes on a fast one is flaky, not falsified, so the limit is raised
 * for every test; a genuine hang still fails after a minute.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: inkInstalled
      ? []
      : [
          { find: /^react\/jsx-runtime$/, replacement: here("./test/tui/fakes/jsx-runtime.ts") },
          { find: /^react\/jsx-dev-runtime$/, replacement: here("./test/tui/fakes/jsx-runtime.ts") },
          { find: /^react$/, replacement: here("./test/tui/fakes/react.ts") },
          { find: /^ink$/, replacement: here("./test/tui/fakes/ink.ts") }
        ]
  },
  test: {
    testTimeout: 60_000
  }
})
