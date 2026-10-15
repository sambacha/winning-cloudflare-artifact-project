/**
 * The demo monorepo for the bisect: 50 first-parent commits, three npm
 * workspaces (`core`, `cli`, `web`), no external dependencies (so `npm ci`
 * works offline in seconds), and these planted events:
 *
 * | commit | event |
 * |---|---|
 * | 1 | scaffold; every test passes (the good commit) |
 * | 10, 20, 30, 40 | a package version bump: `package-lock.json` changes, so the history has 5 distinct lockfiles |
 * | 22 | a `web` test hangs (fixed in 23): a predicate run there times out and must be recorded as a skip |
 * | 34 | **the culprit**: `core/src/queue.js` gets a read-modify-write across an `await` (a lost-update race) |
 * | 50 | HEAD (the bad commit) |
 *
 * The race is real code, but the interleaving is chosen by a scheduler
 * seeded from `DEMO_SEED`, so a failure is reproducible: with probability
 * `DEMO_FLAKE_RATE` (default 0.8) the two workers interleave
 * read-read-write-write and a job is processed twice. Without `DEMO_SEED`
 * the seed is random, like a real flaky test.
 *
 * Commits are made with fixed author, committer and dates, so the commit ids
 * are the same on every machine and every run.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/** 1-based commit numbers of the planted events. */
export const DEMO = {
  commits: 50,
  culprit: 34,
  hang: 22,
  hangFixed: 23,
  lockfileBumps: [10, 20, 30, 40] as const,
  flakeRate: 0.8
} as const

const files = {
  root: (): string =>
    JSON.stringify(
      {
        name: "cobuilds-demo",
        private: true,
        workspaces: ["packages/*"],
        scripts: { test: "node --test --test-concurrency=1 packages/*/test/*.test.js" }
      },
      null,
      2
    ) + "\n",
  pkg: (name: string, version: string, deps: Record<string, string> = {}): string =>
    JSON.stringify({ name: `@demo/${name}`, version, type: "module", ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}) }, null, 2) + "\n",
  rng: `// Seeded PRNG (mulberry32 over an FNV-1a hash of DEMO_SEED).
export const makeRng = (seed = process.env.DEMO_SEED ?? String(Math.random())) => {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
`,
  queueGood: `// Process every job exactly once with two workers.
export const drain = async (jobs) => {
  const seen = []
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++ // claim synchronously: no await between read and write
      if (i >= jobs.length) return
      await Promise.resolve()
      seen.push(jobs[i])
    }
  }
  await Promise.all([worker(), worker()])
  return seen
}
`,
  queueRacy: `import { makeRng } from "./rng.js"

// Process every job with two workers. BUG: the cursor is read, then written
// back after an await (a lost update when both workers read before either writes).
export const drain = async (jobs) => {
  const rng = makeRng()
  const flake = Number(process.env.DEMO_FLAKE_RATE ?? "0.8")
  const seen = []
  let cursor = 0
  // The scheduler: with probability \`flake\` worker B reads before worker A writes.
  const interleave = rng() < flake
  const tick = () => new Promise((r) => setImmediate(r))
  const worker = async (id) => {
    for (;;) {
      const i = cursor
      if (i >= jobs.length) return
      if (interleave && id === 0) await tick() // the await that lets B read the stale cursor
      cursor = i + 1
      seen.push(jobs[i])
      await tick()
    }
  }
  await Promise.all([worker(0), worker(1)])
  return seen
}
`,
  queueTest: `import { test } from "node:test"
import assert from "node:assert/strict"
import { drain } from "../src/queue.js"

test("drain processes every job exactly once", async () => {
  const seen = await drain([1, 2, 3, 4, 5, 6])
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
})
`,
  feature: (pkg: string, n: number): string => `export const feature${n} = (x) => x + ${n} // ${pkg}\n`,
  featureTest: (n: number): string => `import { test } from "node:test"
import assert from "node:assert/strict"
import { feature${n} } from "../src/feature${n}.js"

test("feature${n}", () => assert.equal(feature${n}(1), ${n + 1}))
`,
  hangTest: `import { test } from "node:test"

// Waits for a server that is never started: this test never finishes.
test("web: waits for the dev server", async () => {
  await new Promise(() => setInterval(() => {}, 1000))
})
`,
  hangFixed: `import { test } from "node:test"
import assert from "node:assert/strict"

test("web: dev server check is skipped in CI", () => assert.ok(true))
`
} as const

const PACKAGES = ["core", "cli", "web"] as const

/** Write the demo repository into `dir` (which must not exist or be empty) and return the commit ids, oldest first. */
export const makeDemoRepo = (dir: string): ReadonlyArray<string> => {
  mkdirSync(dir, { recursive: true })
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Demo Agent",
    GIT_AUTHOR_EMAIL: "agent@demo.invalid",
    GIT_COMMITTER_NAME: "Demo Agent",
    GIT_COMMITTER_EMAIL: "agent@demo.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: dir
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  const versions: Record<(typeof PACKAGES)[number], number> = { core: 0, cli: 0, web: 0 }
  const writePackages = () => {
    write("packages/core/package.json", files.pkg("core", `1.${versions.core}.0`))
    write("packages/cli/package.json", files.pkg("cli", `1.${versions.cli}.0`, { "@demo/core": `1.${versions.core}.0` }))
    write("packages/web/package.json", files.pkg("web", `1.${versions.web}.0`, { "@demo/core": `1.${versions.core}.0` }))
    execFileSync("npm", ["install", "--package-lock-only", "--offline", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: dir, stdio: "ignore" })
  }
  const commit = (n: number, message: string) => {
    const date = `2026-10-01T${String(Math.floor(n / 60) + 8).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`
    git("add", "-A")
    execFileSync("git", ["commit", "-q", "-m", `${String(n).padStart(2, "0")}: ${message}`], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    return git("rev-parse", "HEAD")
  }

  git("init", "-q", "-b", "main")
  write(".gitignore", "node_modules/\n.nm-cache/\n")
  write("package.json", files.root())
  write("packages/core/src/rng.js", files.rng)
  write("packages/core/src/queue.js", files.queueGood)
  write("packages/core/test/queue.test.js", files.queueTest)
  writePackages()
  const oids = [commit(1, "scaffold three workspaces with passing tests")]
  for (let n = 2; n <= DEMO.commits; n++) {
    const pkg = PACKAGES[n % PACKAGES.length]!
    let message = `${pkg}: add feature${n}`
    write(`packages/${pkg}/src/feature${n}.js`, files.feature(pkg, n))
    write(`packages/${pkg}/test/feature${n}.test.js`, files.featureTest(n))
    if ((DEMO.lockfileBumps as ReadonlyArray<number>).includes(n)) {
      const bumped = PACKAGES[(n / 10 - 1) % PACKAGES.length]!
      versions[bumped]++
      writePackages()
      message += ` and release @demo/${bumped} 1.${versions[bumped]}.0 (lockfile changes)`
    }
    if (n === DEMO.hang) {
      write("packages/web/test/devserver.test.js", files.hangTest)
      message += "; add dev-server smoke test"
    }
    if (n === DEMO.hangFixed) {
      write("packages/web/test/devserver.test.js", files.hangFixed)
      message += "; stop the dev-server test from hanging"
    }
    if (n === DEMO.culprit) {
      write("packages/core/src/queue.js", files.queueRacy)
      message = `core: let drain() workers yield between jobs (feature${n})`
    }
    oids.push(commit(n, message))
  }
  return oids
}
