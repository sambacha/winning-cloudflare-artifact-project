/**
 * Publishing a run summary to Cloudflare Artifacts (`src/cli/artifactsPublish.ts`)
 * against a fake Artifacts control plane (the REST routes and envelope of
 * `cloudflare-artifacts.md`) whose repo `remote` is a local bare Git
 * repository, so the Git half (clone, commit, push, rebase on a rejected
 * push) runs for real with the system `git`. Checked:
 * - the REST calls made (create repo, get repo, mint a write token, read log)
 *   and their bodies;
 * - the token never appears in a command line (it travels in `GIT_CONFIG_*`);
 * - an empty repo gets its first commit on the default branch; the pushed
 *   commit is found in `log` (`verified`);
 * - three concurrent publishers to one repo all land (rejected pushes are
 *   rebased and retried); an existing repo (`ALREADY_EXISTS`) is reused.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeArtifactsRestClient } from "../../src/bisect/artifactsRest.js"
import { exec, type Exec } from "../../src/bisect/localGit.js"
import { publishToArtifacts } from "../../src/cli/artifactsPublish.js"
import { main } from "../../src/cli/main.js"

const roots: Array<string> = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const TOKEN = "art_v1_0123456789abcdef0123456789abcdef01234567?expires=1999999999"

/** Fake control plane: repos are bare repositories under `root`. */
const fakeArtifacts = (root: string) => {
  const repos = new Map<string, string>()
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const envelope = (result: unknown, status = 200, errors: Array<{ code: number; message: string }> = []) =>
    new Response(JSON.stringify({ result, success: errors.length === 0, errors, messages: [] }), { status, headers: { "content-type": "application/json" } })
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url)
    const p = u.pathname.replace(/^\/client\/v4\/accounts\/acct1\/artifacts\/namespaces\/default/, "")
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ method: init.method, path: p, body })
    if (init.method === "POST" && p === "/repos") {
      if (repos.has(body.name)) return envelope(null, 409, [{ code: 10201, message: "already exists" }])
      const dir = join(root, `${body.name}.git`)
      execFileSync("git", ["init", "-q", "--bare", "-b", body.default_branch ?? "main", dir])
      repos.set(body.name, dir)
      return envelope({ id: "r1", name: body.name, description: null, default_branch: body.default_branch ?? "main", remote: dir, token: TOKEN })
    }
    const m = /^\/repos\/([^/]+)(\/log)?$/.exec(p)
    if (m !== null && init.method === "GET") {
      const dir = repos.get(decodeURIComponent(m[1]!))
      if (dir === undefined) return envelope(null, 404, [{ code: 10200, message: "not found" }])
      if (m[2] === undefined) return envelope({ id: "r1", name: m[1], default_branch: "main", remote: dir, read_only: false })
      let out = ""
      try {
        out = execFileSync("git", ["-C", dir, "log", "--first-parent", "--format=%H", `--max-count=${u.searchParams.get("limit") ?? "50"}`, u.searchParams.get("ref") ?? "HEAD"]).toString()
      } catch {
        out = ""
      }
      return envelope(out.trim().split("\n").filter((l) => l.length > 0).map((oid) => ({ oid })))
    }
    if (init.method === "POST" && p === "/tokens") {
      return envelope({ id: "t1", plaintext: TOKEN, scope: body.scope, expires_at: "2033-05-18T03:33:19Z" })
    }
    return envelope(null, 404, [{ code: 10200, message: `no route ${init.method} ${p}` }])
  }
  const client = makeArtifactsRestClient({ accountId: "acct1", namespace: "default", apiToken: "cf-api-token", fetch })
  return { client, calls, repos, fetch }
}

/** Records every command line, to check the token never appears in one. */
const recordingExec = (lines: Array<string>): Exec => (cmd, args, opts) => {
  lines.push([cmd, ...args].join(" "))
  return exec(cmd, args, opts)
}

describe("publish a run summary to Artifacts", () => {
  it("creates the repo, pushes the first commit with a write token, and finds it in the log", async () => {
    const root = mkdtempSync(join(tmpdir(), "artifacts-"))
    roots.push(root)
    const fake = fakeArtifacts(root)
    const lines: Array<string> = []
    const r = await publishToArtifacts({
      client: fake.client,
      repo: "cobuild-results",
      path: "runs/ctx-1/primary.json",
      content: '{"ok":true}\n',
      message: "cobuild ctx-1: primary",
      exec: recordingExec(lines)
    })
    expect(r).toMatchObject({ repo: "cobuild-results", branch: "main", created: true, verified: true })
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)
    const dir = fake.repos.get("cobuild-results")!
    expect(execFileSync("git", ["-C", dir, "show", "main:runs/ctx-1/primary.json"]).toString()).toBe('{"ok":true}\n')
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos",
      "GET /repos/cobuild-results",
      "GET /repos/cobuild-results",
      "POST /tokens",
      "GET /repos/cobuild-results",
      "GET /repos/cobuild-results/log"
    ])
    expect(fake.calls.find((c) => c.path === "/tokens")!.body).toEqual({ repo: "cobuild-results", scope: "write", ttl: 600 })
    expect(lines.length).toBeGreaterThan(3)
    for (const l of lines) expect(l).not.toContain("art_v1_")
  })

  it("three concurrent publishers to one repo all land; the existing repo is reused", async () => {
    const root = mkdtempSync(join(tmpdir(), "artifacts-"))
    roots.push(root)
    const fake = fakeArtifacts(root)
    const results = await Promise.all(
      ["primary", "extra1", "extra2"].map((job) =>
        publishToArtifacts({ client: fake.client, repo: "shared", path: `runs/c/${job}.json`, content: `${job}\n`, message: job })
      )
    )
    expect(results.every((r) => r.verified)).toBe(true)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    const dir = fake.repos.get("shared")!
    const files = execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "main"]).toString().trim().split("\n").sort()
    expect(files).toEqual(["runs/c/extra1.json", "runs/c/extra2.json", "runs/c/primary.json"])
    expect(execFileSync("git", ["-C", dir, "rev-list", "--count", "main"]).toString().trim()).toBe("3")
  })

  it("CLI: `cobuild artifacts publish` reads CLOUDFLARE_* and prints the verified result", async () => {
    const root = mkdtempSync(join(tmpdir(), "artifacts-"))
    roots.push(root)
    const fake = fakeArtifacts(root)
    execFileSync("sh", ["-c", `echo '{"x":1}' > ${join(root, "summary.json")}`])
    const out: Array<string> = []
    const err: Array<string> = []
    const deps = {
      env: { CLOUDFLARE_ACCOUNT_ID: "acct1", CLOUDFLARE_API_TOKEN: "cf-api-token" },
      out: (l: string) => void out.push(l),
      err: (l: string) => void err.push(l),
      cwd: root,
      fetch: ((url: string, init: { method: string; body?: string }) => fake.fetch(url, init)) as unknown as typeof fetch
    }
    expect(await main(["artifacts", "publish", "--repo", "results", "--file", "summary.json", "--dest", "runs/s.json"], deps)).toBe(0)
    expect(JSON.parse(out[0]!)).toMatchObject({ repo: "results", verified: true })
    expect(await main(["artifacts", "publish", "--repo", "results", "--file", "summary.json"], { ...deps, env: {} })).toBe(2)
  })
})
