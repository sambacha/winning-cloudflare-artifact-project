/**
 * The predicate step against a real Git repository over `file://`
 * (upload-pack, like a smart-HTTP remote): fetch by commit id, and the
 * shallow branch fallback when the server refuses a want for an unadvertised
 * commit (forced with protocol v0, where `uploadpack.allowAnySHA1InWant` is
 * off by default). Non-zero exit is an observation; a timeout is a skip.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { makeLocalSandbox } from "../../src/bisect/localSandbox.js"
import { type PredicateStepInput, runPredicateStep } from "../../src/bisect/predicateStep.js"
import { makeDemoRepo } from "../../src/demo/demoRepo.js"
import { Effect } from "../../src/fx/index.js"

let repo = ""
let oids: ReadonlyArray<string> = []
beforeAll(() => {
  repo = path.join(mkdtempSync(path.join(tmpdir(), "pred-")), "repo")
  oids = makeDemoRepo(repo)
}, 120_000)

const env = (extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"]!, HOME: process.env["HOME"] ?? tmpdir(), ...extra })
const PROTOCOL_V0 = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.version", GIT_CONFIG_VALUE_0: "0" }

const step = (commit: string, command: string, extraEnv: Record<string, string> = {}, timeoutSec = 30) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "sb-"))
  const commands: Array<string> = []
  const input: PredicateStepInput = {
    remote: `file://${repo}`,
    token: "read-token-not-in-argv",
    commit,
    branch: "main",
    depth: oids.length,
    command,
    timeoutSec,
    noInstall: true,
    workdir: path.join(scratch, "repo")
  }
  return Effect.runPromise(runPredicateStep(makeLocalSandbox({ scratch, baseEnv: env(extraEnv), onExec: (c) => commands.push(c) }), input)).then((r) => ({ r, commands }))
}

describe("predicate step on a real repository", () => {
  it("checks out the requested commit by id and passes", async () => {
    const target = oids[20]!
    const { r, commands } = await step(target, `test "$(git rev-parse HEAD)" = ${target}`)
    expect(r).toMatchObject({ outcome: "pass", reason: "exit-0", checkout: "commit-fetch" })
    expect(commands.join("\n")).not.toContain("read-token-not-in-argv")
  }, 60_000)

  it("falls back to a shallow branch fetch when fetch by id is refused", async () => {
    const target = oids[10]!
    const { r } = await step(target, `test "$(git rev-parse HEAD)" = ${target}`, PROTOCOL_V0)
    expect(r).toMatchObject({ outcome: "pass", checkout: "branch-fallback" })
  }, 60_000)

  it("a non-zero exit is a fail observation, not an error", async () => {
    const { r } = await step(oids[5]!, "exit 3")
    expect(r).toMatchObject({ outcome: "fail", reason: "exit-nonzero", exitCode: 3 })
  }, 60_000)

  it("a timeout is a skip", async () => {
    const { r } = await step(oids[5]!, "sleep 30", {}, 1)
    expect(r).toMatchObject({ outcome: "skip", reason: "timeout" })
  }, 60_000)

  it("a commit outside the fetched depth is an infrastructure error (never a guess)", async () => {
    const exit = await Effect.runPromiseExit(
      runPredicateStep(makeLocalSandbox({ scratch: mkdtempSync(path.join(tmpdir(), "sb-")), baseEnv: env(PROTOCOL_V0) }), {
        remote: `file://${repo}`,
        token: "t",
        commit: oids[0]!,
        branch: "main",
        depth: 3,
        command: "true",
        timeoutSec: 5,
        noInstall: true,
        workdir: path.join(mkdtempSync(path.join(tmpdir(), "sb-")), "repo")
      })
    )
    expect(exit._tag).toBe("Failure")
  }, 60_000)

  it("the demo repository is what the docs describe", () => {
    expect(oids.length).toBe(50)
    const head = execFileSync("git", ["rev-parse", "main"], { cwd: repo }).toString().trim()
    expect(head).toBe(oids[49])
  })
})
