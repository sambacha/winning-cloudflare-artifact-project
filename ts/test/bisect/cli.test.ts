/**
 * Local Git adapter, command runner and `bayesect` CLI, against real
 * temporary Git repositories.
 *
 * Requirements (abstract):
 * G1 `localGitLog` pages, concatenated, equal Git's own first-parent order
 *    (`git rev-list --first-parent`) for any page size and offset; an
 *    unresolvable ref gives an empty page (the Artifacts `log()` contract).
 * G2 Exit statuses map like `git bisect run`: 0 pass, 125 skip, other 1–127
 *    fail, ≥ 128 / signals abort; timeouts follow the chosen policy.
 * G3 `bayesect run` names the commit that introduced the failure for any
 *    history (with merges) and culprit, and leaves the caller's checkout
 *    (HEAD, branch, working tree) untouched.
 * G4 Manual mode (`start`, `fail`/`pass` at the suggested commit, `undo`,
 *    `status`) reaches the same culprit; `undo` restores the previous state.
 * G5 `bayesect run --artifacts` reads history through the Artifacts REST API,
 *    mints a read token, clones the repo's remote with the token in the
 *    `http.extraHeader` configuration (not in argv), and finds the culprit.
 * G6 Usage errors exit with status 2 and print the usage text.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilledAsync } from "../harness.js"
import { BisectAbort, type Exec, exec, localGitLog, outcomeOf } from "../../src/bisect/localGit.js"
import { main } from "../../src/bisect/cli.js"
import { type FakeCommit, type FakeRepo, makeFakeNamespace, makeRestFetch } from "./fakeArtifacts.js"

announce("test/bisect/cli.test.ts")

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" }
  }).trim()

/**
 * A repository whose `main` has `len` first-parent commits; every
 * `mergeEvery`-th one merges a one-commit side branch. The first-parent
 * commit at index `culprit` adds the file `BUG` (kept afterwards).
 */
const makeGitRepo = (len: number, culprit: number, mergeEvery: number) => {
  const dir = mkdtempSync(join(tmpdir(), "bayesect-test-"))
  dirs.push(dir)
  g(dir, "init", "-q", "-b", "main")
  const mainline: string[] = []
  for (let i = 0; i < len; i++) {
    if (i > 0 && i % mergeEvery === 0 && i !== culprit) {
      g(dir, "checkout", "-q", "-b", `side${i}`)
      writeFileSync(join(dir, `side${i}.txt`), `${i}\n`)
      g(dir, "add", ".")
      g(dir, "commit", "-q", "-m", `side ${i}`)
      g(dir, "checkout", "-q", "main")
      g(dir, "merge", "-q", "--no-ff", "-m", `merge ${i}`, `side${i}`)
    } else {
      writeFileSync(join(dir, "n.txt"), `${i}\n`)
      if (i === culprit) writeFileSync(join(dir, "BUG"), "x\n")
      g(dir, "add", ".")
      g(dir, "commit", "-q", "-m", `commit ${i}`)
    }
    mainline.push(g(dir, "rev-parse", "HEAD"))
  }
  return { dir, mainline }
}

const TEST_CMD = ["sh", "-c", "test ! -e BUG"]

const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, deps: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l), now: () => 0 } }
}

describe("local Git log (G1)", () => {
  it("law G1: pages concatenate to git rev-list --first-parent; unknown refs give []", async () => {
    const { dir } = makeGitRepo(37, 36, 5)
    const expected = g(dir, "rev-list", "--first-parent", "main").split("\n")
    const log = localGitLog(dir)
    await lawAsync(
      "localGitLog paging",
      // Offsets inside the chain are weighted 9:1 against offsets past its end, so the
      // valid fraction is ~0.9 rather than 37/46 ≈ 0.80 (which fell below 0.7 on some seeds).
      fc.record({
        limit: fc.integer({ min: 1, max: 40 }),
        offset: fc.oneof({ arbitrary: fc.integer({ min: 0, max: 36 }), weight: 9 }, { arbitrary: fc.integer({ min: 37, max: 45 }), weight: 1 })
      }),
      async ({ limit, offset }) => {
        const page = (await log.log({ ref: "main", limit, offset })) as Array<{ oid: string; parents: string[] }>
        expect(page.map((c) => c.oid)).toEqual(expected.slice(offset, offset + limit))
        for (let i = 0; i + 1 < page.length; i++) expect(page[i]!.parents[0]).toBe(page[i + 1]!.oid)
        return { valid: offset < expected.length, boundary: offset + limit === expected.length || offset >= expected.length }
      },
      60,
      { domain: "page size 1–40, offset 0–45 over a 37-commit first-parent chain with merges", minValidFraction: 0.7, minBoundary: 2 }
    )
    expect(await log.log({ ref: "no-such-branch", limit: 5 })).toEqual([])
    expect(await log.readCommit!("0".repeat(40))).toBeNull()
    await expect(log.log({ ref: "--all", limit: 1 })).rejects.toThrow()
  }, 240_000)
})

describe("exit status mapping (G2)", () => {
  it("law G2: git bisect run convention", () => {
    law(
      "outcomeOf",
      fc.record({
        code: fc.option(fc.oneof(fc.constantFrom(0, 1, 124, 125, 126, 127, 128, 255), fc.integer({ min: 0, max: 255 })), { nil: null }),
        signal: fc.option(fc.constantFrom("SIGKILL", "SIGTERM", "SIGSEGV") as fc.Arbitrary<NodeJS.Signals>, { nil: null }),
        timedOut: fc.boolean(),
        policy: fc.constantFrom("fail", "skip", "abort") as fc.Arbitrary<"fail" | "skip" | "abort">
      }),
      ({ code, signal, timedOut, policy }) => {
        const r = { code, signal, timedOut }
        const run = () => outcomeOf(r, policy)
        if (timedOut) {
          if (policy === "abort") expect(run).toThrow(BisectAbort)
          else expect(run()).toBe(policy === "skip" ? "skip" : true)
        } else if (signal !== null || code === null || code >= 128) expect(run).toThrow(BisectAbort)
        else expect(run()).toBe(code === 0 ? false : code === 125 ? "skip" : true)
        return { valid: true, boundary: [0, 1, 124, 125, 126, 127, 128].includes(code ?? -1) }
      },
      600,
      { domain: "codes 0–255 or none, three signals or none, timeout × three policies", minValidFraction: 1, minBoundary: 10 }
    )
  })
})

describe("bayesect run on a local repository (G3)", () => {
  it("law G3: finds the commit that introduced the failure; the caller's checkout is untouched", async () => {
    await lawAsync(
      "bayesect run (local)",
      fc.record({ len: fc.integer({ min: 2, max: 24 }), c: fc.nat(), good: fc.nat(), mergeEvery: fc.integer({ min: 2, max: 6 }) }),
      async ({ len, c, good, mergeEvery }) => {
        const goodIdx = good % (len - 1)
        const culprit = goodIdx + 1 + (c % (len - 1 - goodIdx))
        const { dir, mainline } = makeGitRepo(len, culprit, mergeEvery)
        writeFileSync(join(dir, "untracked-user-file"), "keep\n")
        const before = { head: g(dir, "rev-parse", "HEAD"), branch: g(dir, "branch", "--show-current"), status: g(dir, "status", "--porcelain") }
        const cap = capture()
        const code = await main(
          ["run", "--repo-dir", dir, "--good", mainline[goodIdx]!, "--bad", "main", "--old-rate", "known:0", "--new-rate", "known:1", "--confidence", "1", "--", ...TEST_CMD],
          { ...cap.deps, env: {}, exec: quiet }
        )
        expect(cap.err).toEqual([])
        expect(code).toBe(0)
        expect(cap.out.join("\n")).toContain(`most likely culprit: ${mainline[culprit]!.slice(0, 12)}`)
        expect({ head: g(dir, "rev-parse", "HEAD"), branch: g(dir, "branch", "--show-current"), status: g(dir, "status", "--porcelain") }).toEqual(before)
        expect(g(dir, "worktree", "list").split("\n").length).toBe(1)
        return { valid: true, boundary: culprit === goodIdx + 1 || culprit === len - 1 }
      },
      12,
      { domain: "2–24 first-parent commits, merges every 2–6, any good commit and culprit", minValidFraction: 1, minBoundary: 2 }
    )
  }, 240_000)

  it("a flaky test with the default unknown-rate priors still converges on the culprit", async () => {
    const { dir, mainline } = makeGitRepo(20, 13, 4)
    // The bug shows 80% of the time at bad commits: a counter file outside the repo drives a fixed pattern.
    const counter = join(mkdtempSync(join(tmpdir(), "bayesect-ctr-")), "n")
    dirs.push(counter.slice(0, -2))
    writeFileSync(counter, "0")
    const flaky = ["sh", "-c", `n=$(cat ${counter}); echo $((n+1)) > ${counter}; if [ -e BUG ] && [ $((n % 5)) -ne 4 ]; then exit 1; fi; exit 0`]
    const cap = capture()
    const code = await main(["run", "--repo-dir", dir, "--good", mainline[0]!, "--bad", "main", "--confidence", "0.95", "--", ...flaky], {
      ...cap.deps,
      env: {},
      exec: quiet
    })
    expect(code).toBe(0)
    expect(cap.out.join("\n")).toContain(`most likely culprit: ${mainline[13]!.slice(0, 12)}`)
  }, 240_000)
})

describe("interruption (runMain entry point)", () => {
  it("aborting deps.signal interrupts a running bisection: main returns 130 and says so", async () => {
    const { dir, mainline } = makeGitRepo(8, 5, 4)
    const cap = capture()
    const controller = new AbortController()
    const started = Date.now()
    const pending = main(["run", "--repo-dir", dir, "--good", mainline[0]!, "--bad", "main", "--", "sh", "-c", "sleep 30"], {
      ...cap.deps,
      env: {},
      exec: quiet,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 1000)
    expect(await pending).toBe(130)
    expect(cap.err.join("\n")).toContain("bayesect: interrupted")
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)
})

/** `exec` that captures (instead of inheriting) the test command's output, to keep the test log readable. */
const quiet: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, inherit: false })

describe("manual mode (G4)", () => {
  it("law G4: start / fail|pass at the suggestion / undo / status reach the culprit", async () => {
    await lawAsync(
      "bayesect manual",
      fc.record({ len: fc.integer({ min: 3, max: 30 }), c: fc.nat() }),
      async ({ len, c }) => {
        const culprit = 1 + (c % (len - 1))
        const { dir, mainline } = makeGitRepo(len, culprit, 100)
        const state = join(dir, ".git", "bayesect.json")
        const run = async (...argv: string[]) => {
          const cap = capture()
          const code = await main([...argv, "--state", state], { ...cap.deps, env: {} })
          expect(cap.err).toEqual([])
          expect(code).toBe(0)
          return cap.out
        }
        await run("start", "--repo-dir", dir, "--good", mainline[0]!, "--bad", "main", "--old-rate", "known:0", "--new-rate", "known:1", "--confidence", "1")
        let undoChecked = false
        for (;;) {
          const next = (await run("next"))[0]!
          if (next === "") break
          const verdict = mainline.indexOf(next) >= culprit ? "fail" : "pass"
          if (!undoChecked) {
            const before = await run("status")
            await run(verdict === "fail" ? "pass" : "fail") // a wrong answer …
            await run("undo") // … taken back
            expect(await run("status")).toEqual(before)
            undoChecked = true
          }
          await run(verdict)
        }
        expect((await run("status")).join("\n")).toContain(`most likely culprit: ${mainline[culprit]!.slice(0, 12)}`)
        return { valid: true, boundary: culprit === 1 || culprit === len - 1 }
      },
      10,
      { domain: "3–30 linear commits, any culprit", minValidFraction: 1, minBoundary: 1 }
    )
  }, 240_000)
})

/** Mirror a real Git repository into the fake Artifacts model (same commit ids). */
const mirror = (dir: string): FakeRepo => {
  const commits = new Map<string, FakeCommit>()
  for (const line of g(dir, "log", "--all", "--format=%H %P%x09%s").split("\n")) {
    const [ids, message] = line.split("\t")
    const [oid, ...parents] = ids!.split(" ")
    commits.set(oid!, { oid: oid!, parents: parents.filter((p) => p.length > 0), message: message! })
  }
  return { commits, refs: new Map([["main", g(dir, "rev-parse", "main")]]), defaultBranch: "main" }
}

describe("bayesect run --artifacts (G5)", () => {
  it("law G5: REST history + read token + header-authenticated clone → culprit", async () => {
    const { dir, mainline } = makeGitRepo(18, 11, 4)
    const ns = makeFakeNamespace({ proj: mirror(dir) }, { idField: "id", remoteOf: () => dir })
    const env = { CLOUDFLARE_ACCOUNT_ID: "acc1", ARTIFACTS_NAMESPACE: "default", CLOUDFLARE_API_TOKEN: "cf-token" }
    const { fetch, requests } = makeRestFetch(ns, { accountId: env.CLOUDFLARE_ACCOUNT_ID, namespace: env.ARTIFACTS_NAMESPACE, apiToken: env.CLOUDFLARE_API_TOKEN })
    const calls: Array<{ cmd: string; args: ReadonlyArray<string>; env: Record<string, string> | undefined }> = []
    const spy: Exec = (cmd, args, opts = {}) => {
      calls.push({ cmd, args, env: opts.env })
      return quiet(cmd, args, opts)
    }
    const cap = capture()
    const code = await main(
      ["run", "--artifacts", "proj", "--good", mainline[2]!, "--bad", "main", "--old-rate", "known:0", "--new-rate", "known:1", "--confidence", "1", "--", ...TEST_CMD],
      { ...cap.deps, env, exec: spy, fetch: fetch as unknown as typeof globalThis.fetch }
    )
    expect(cap.err).toEqual([])
    expect(code).toBe(0)
    expect(cap.out.join("\n")).toContain(`most likely culprit: ${mainline[11]!.slice(0, 12)}`)
    // History came from the REST log route; a read token was minted.
    expect(requests.some((r) => r.url.includes("/repos/proj/log"))).toBe(true)
    expect(ns.tokens.map((t) => t.scope)).toEqual(["read"])
    const token = ns.tokens[0]!.plaintext
    const clone = calls.find((c) => c.args[0] === "clone")!
    expect(clone.env).toMatchObject({ GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })
    for (const c of calls) expect(c.args.join(" ")).not.toContain(token)
  }, 240_000)
})

/*
 * G6, restated as a rule (no test values): an invocation that is malformed
 * *as text* — unknown command, flag without value, missing --good/--bad,
 * unparsable or out-of-range model flag (rates outside their domain,
 * confidence outside (0, 1], max-steps not a non-negative integer), `run`
 * without a test command, bad runner flag — exits 2, prints the usage text,
 * and performs no I/O (no process is spawned), whatever the repository's
 * state. A well-formed invocation that fails at run time (here: no such
 * repository) exits 1 without the usage text.
 *
 * The previous version of this test accepted `code === 2 || code === 1`
 * for the same inputs, i.e. it had been loosened to what the code did. That
 * hid a real defect: `run` checked the test command and the model flags only
 * after reading the repository, so the status of a malformed command
 * depended on the repository (2 in a real repository, 1 elsewhere), and an
 * out-of-range `--confidence` or rate exited 1. `checkModelFlags` in
 * `src/bisect/cli.ts` now runs every usage check before any I/O.
 */
type Flaw =
  | "unknown-command" | "dangling-flag" | "no-good" | "no-bad" | "rate-syntax" | "rate-range"
  | "beta-range" | "confidence-range" | "max-steps" | "no-command" | "on-timeout" | "timeout-range"
const FLAWS: ReadonlyArray<Flaw> = [
  "unknown-command", "dangling-flag", "no-good", "no-bad", "rate-syntax", "rate-range",
  "beta-range", "confidence-range", "max-steps", "no-command", "on-timeout", "timeout-range"
]

const invocationArb = fc.record({
  command: fc.constantFrom("run", "start"),
  flaw: fc.option(fc.constantFrom(...FLAWS), { nil: null, freq: 4 }),
  good: fc.stringMatching(/^[0-9a-f]{4,12}$/),
  bad: fc.constantFrom("main", "HEAD", "release"),
  p: fc.oneof(fc.double({ min: -5, max: 5, noNaN: true }), fc.constantFrom(-1e-9, 0, 1, 1 + 1e-9)),
  c: fc.oneof(fc.double({ min: -2, max: 3, noNaN: true }), fc.constantFrom(0, 1, 1 + 1e-9, -0.5)),
  steps: fc.oneof(fc.integer({ min: -5, max: 300 }), fc.constantFrom(-1, 0, 2.5)),
  repo: fc.stringMatching(/^[a-z]{3,10}$/).map((n) => `/nonexistent-${n}`)
})
type Invocation = { command: string; flaw: Flaw | null; good: string; bad: string; p: number; c: number; steps: number; repo: string }

/** Build argv for an invocation; returns whether the rule calls it a usage error (oracle from the rule, not from the CLI). */
const argvOf = (x: Invocation): { argv: string[]; usage: boolean } => {
  const flags: string[] = ["--repo-dir", x.repo]
  let usage = false
  if (x.flaw !== "no-good") flags.push("--good", x.good)
  else usage = true
  if (x.flaw !== "no-bad") flags.push("--bad", x.bad)
  else usage = true
  if (x.flaw === "rate-syntax") (flags.push("--old-rate", `known:${x.p}x`), (usage = true))
  if (x.flaw === "rate-range") {
    const p = x.p >= 0 && x.p <= 1 ? x.p + 1.5 : x.p
    flags.push("--new-rate", `known:${p}`)
    usage = true
  }
  if (x.flaw === "beta-range") (flags.push("--old-rate", `beta:${-Math.abs(x.p)},1`), (usage = true))
  if (x.flaw === "confidence-range") {
    const c = x.c > 0 && x.c <= 1 ? x.c + 1.5 : x.c
    flags.push("--confidence", String(c))
    usage = true
  }
  if (x.flaw === "max-steps") {
    const m = Number.isInteger(x.steps) && x.steps >= 0 ? -1 - x.steps : x.steps
    flags.push("--max-steps", String(m))
    usage = true
  }
  if (x.flaw === "on-timeout" && x.command === "run") (flags.push("--on-timeout", "retry"), (usage = true))
  if (x.flaw === "timeout-range" && x.command === "run") (flags.push("--timeout", String(-Math.abs(x.c))), (usage = true))
  const tail = x.command === "run" && x.flaw !== "no-command" ? ["--", "sh", "-c", "true"] : []
  if (x.flaw === "no-command" && x.command === "run") usage = true
  if (x.flaw === "dangling-flag") return { argv: [x.command, ...flags, "--confidence"], usage: true }
  if (x.flaw === "unknown-command") return { argv: [`x${x.command}`, ...flags, ...tail], usage: true }
  return { argv: [x.command, ...flags, ...tail], usage }
}

type Main = typeof main
interface CliRun {
  code: number
  err: string
  spawned: number
}
/** Run `impl` with an exec spy that answers like git outside a repository. */
const runCli = async (impl: Main, argv: string[]): Promise<CliRun> => {
  const err: string[] = []
  let spawned = 0
  const spy: Exec = async () => {
    spawned++
    return { code: 128, signal: null, stdout: "", stderr: "fatal: not a git repository", timedOut: false }
  }
  const code = await impl(argv, { out: () => {}, err: (l) => void err.push(l), now: () => 0, env: {}, exec: spy, cwd: "/nonexistent-cwd" })
  return { code, err: err.join("\n"), spawned }
}

/** The rule, as a predicate on one run. */
const g6Holds = (usage: boolean, r: CliRun): boolean =>
  usage ? r.code === 2 && r.err.includes("usage:") && r.spawned === 0 : r.code === 1 && !r.err.includes("usage:")

/** Planted mutant 1: the loosened contract the old test accepted (every error exits 1). */
const exitsOneOnUsage: Main = async (argv, deps) => {
  const c = await main(argv, deps)
  return c === 2 ? 1 : c
}
/** Planted mutant 2: the old order — touch the repository before validating the invocation. */
const ioBeforeValidation: Main = async (argv, deps) => {
  const i = argv.indexOf("--repo-dir")
  if (i >= 0 && deps.exec) await deps.exec("git", ["-C", argv[i + 1]!, "rev-parse", "--git-dir"])
  return main(argv, deps)
}

describe("usage errors (G6)", () => {
  it("law G6: malformed invocations exit 2 with the usage text before any I/O; well-formed ones that fail at run time exit 1", async () => {
    await lawAsync(
      "usage errors are classified before I/O",
      invocationArb,
      async (x) => {
        const { argv, usage } = argvOf(x)
        const r = await runCli(main, argv)
        expect(g6Holds(usage, r), `${JSON.stringify(argv)} → ${r.code}, spawned ${r.spawned}: ${r.err.slice(0, 200)}`).toBe(true)
        return { valid: usage, boundary: [0, 1, 1 + 1e-9, -1e-9].includes(x.p) || [0, 1, 1 + 1e-9].includes(x.c) || !usage }
      },
      300,
      { domain: "run/start × 12 flaw kinds (or none) × rates/confidence/max-steps around their bounds × nonexistent repositories", minValidFraction: 0.6, minBoundary: 20 }
    )
    // `help`, with or without a command, is not an error.
    expect((await runCli(main, [])).code).toBe(0)
  })

  it("counterexample 1 (mutant: usage errors exit 1): `bayesect frobnicate` — the old `2 || 1` check passed it, the law does not", async () => {
    const argv = ["frobnicate"]
    const control = await runCli(main, argv)
    const mutant = await runCli(exitsOneOnUsage, argv)
    expect(g6Holds(true, control)).toBe(true)
    expect(g6Holds(true, mutant)).toBe(false)
    // The assertion this test used to make accepts the mutant: that is the overfitting being removed.
    const oldCheck = (r: CliRun) => (r.code === 2 || r.code === 1) && r.err.length > 0
    expect(oldCheck(mutant)).toBe(true)
  })

  it("counterexample 2 (mutant: I/O before validation): `run` without a test command spawns git before failing", async () => {
    const argv = ["run", "--repo-dir", "/nonexistent-repo", "--good", "abcd", "--bad", "main"]
    const control = await runCli(main, argv)
    const mutant = await runCli(ioBeforeValidation, argv)
    expect(control).toMatchObject({ code: 2, spawned: 0 })
    expect(g6Holds(true, control)).toBe(true)
    expect(mutant.spawned).toBeGreaterThan(0)
    expect(g6Holds(true, mutant)).toBe(false)
  })

  it("negation 1: the law is refuted for the exit-1 mutant over the generated invocations", async () => {
    const killed = await mutantKilledAsync(invocationArb, async (x) => {
      const { argv, usage } = argvOf(x)
      return g6Holds(usage, await runCli(exitsOneOnUsage, argv))
    }, 200)
    expect(killed).toBe(true)
  })

  it("negation 2: the law is refuted for the I/O-before-validation mutant over the generated invocations", async () => {
    const killed = await mutantKilledAsync(invocationArb, async (x) => {
      const { argv, usage } = argvOf(x)
      return g6Holds(usage, await runCli(ioBeforeValidation, argv))
    }, 200)
    expect(killed).toBe(true)
  })

  it("regression (recorded): --artifacts without the CLOUDFLARE_* variables is a usage error", async () => {
    const cap = capture()
    expect(await main(["run", "--artifacts", "x", "--good", "a", "--bad", "b", "--", "true"], { ...cap.deps, env: {} })).toBe(2)
  })
})
