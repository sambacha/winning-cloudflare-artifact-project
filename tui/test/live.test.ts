/**
 * Live lock rows (`src/live.ts`): validation of the Worker's JSON, the
 * mapping to dashboard rows (exact countdowns on the dashboard clock, the new
 * FAILED state), the panel labels, and the `--locks-json` snapshot path.
 * The `ts/` side checks the same module against real Worker responses
 * (`ts/test/worker/tuiContract.test.ts`).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { plain } from "../src/ansi.ts"
import { fetchLiveLocks, type LiveLock, type LiveLocks, LiveFormatError, liveErrors, parseLiveLocks, toLiveRows, withLiveLocks } from "../src/live.ts"
import { stateAt } from "../src/scenario.ts"
import { frame } from "../src/view.tsx"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/live.test.ts")

const FIXTURE = join(import.meta.dirname, "fixtures", "worker-locks.json")

const genLock = (r: Rng, i: number): LiveLock => {
  const status = r.pick(["building", "succeeded", "failed"] as const)
  const acquiredAt = r.int(0, 1e9)
  const heartbeatAt = acquiredAt + r.int(0, 60_000)
  const expiresAt = status === "building" ? heartbeatAt + 30_000 : heartbeatAt
  return {
    key: `v1/trusted/cobuild/ctx/k${i}/lock/`,
    cacheKey: `k${i}`,
    etag: `"e${r.int(0, 999)}"`,
    owner: r.pick(["primary", "extra1", "extra2"]),
    status,
    acquiredAt,
    heartbeatAt,
    expiresAt,
    leaseExpired: false,
    buildCacheKey: status === "succeeded" ? `blake3:${i}` : null,
    failedAt: status === "failed" ? heartbeatAt : null,
    logKey: status === "failed" && r.chance(0.5) ? `logs/${i}` : null
  }
}

const genLive = (r: Rng) => {
  const n = r.int(0, 6)
  const locks: Array<LiveLock | { key: string; error: string }> = Array.from({ length: n }, (_, i) =>
    r.chance(0.15) ? { key: `v1/trusted/cobuild/ctx/bad${i}/lock/`, error: "body is not a cobuild lock manifest" } : genLock(r, i)
  )
  const live: LiveLocks = { context: "ctx", locks, truncated: false }
  const nowMs = r.chance(0.2) ? (locks.find((l): l is LiveLock => !("error" in l))?.expiresAt ?? 0) : r.int(0, 1.1e9)
  return { live, nowMs, t: r.chance(0.2) ? 0 : r.next() * 80 }
}

test("live rows: states, exact countdowns on the dashboard clock, errors listed and dropped", () => {
  law(
    "toLiveRows",
    800,
    genLive,
    ({ live, nowMs, t }) => {
      // Round trip through JSON: the rows come from what the Worker would send.
      const parsed = parseLiveLocks(JSON.parse(JSON.stringify(live)))
      const rows = toLiveRows(parsed, nowMs, t)
      const good = live.locks.filter((l): l is LiveLock => !("error" in l))
      assert.equal(rows.length, good.length)
      assert.equal(liveErrors(parsed).length, live.locks.length - good.length)
      rows.forEach((row, i) => {
        const l = good[i]!
        assert.equal(row.state, { building: "BUILDING", succeeded: "SUCCEEDED", failed: "FAILED" }[l.status])
        assert.equal(row.holder, l.owner)
        assert.equal(row.key, l.key)
        assert.equal(`"${row.etag}"`, l.etag)
        if (l.status === "building") assert.ok(Math.abs(row.expiresAt! - t - (l.expiresAt - nowMs) / 1000) < 1e-9)
        else assert.equal(row.expiresAt, null)
        assert.ok(Math.abs(row.lastWrite! - t - ((l.failedAt ?? l.heartbeatAt) - nowMs) / 1000) < 1e-9)
        if (l.status === "succeeded") assert.equal(row.result, l.buildCacheKey)
      })
      const atExpiry = good.some((l) => l.status === "building" && l.expiresAt === nowMs)
      return { valid: good.length > 0, boundary: atExpiry || live.locks.length === 0 }
    },
    { domain: "0–6 lock objects (15% undecodable), all statuses, poll time anywhere incl. exactly at expiry", minValidFraction: 0.6, minBoundary: 20 }
  )
  // Broken variant: countdown measured from acquisition instead of the poll time — the law must reject it.
  assert.ok(
    refutes(200, genLive, ({ live, nowMs, t }) =>
      toLiveRows(live, nowMs, t).every((row, i) => {
        const l = live.locks.filter((x): x is LiveLock => !("error" in x))[i]!
        return l.status !== "building" || Math.abs(row.expiresAt! - t - (l.expiresAt - l.acquiredAt) / 1000) < 1e-9
      })
    )
  )
})

test("parseLiveLocks rejects malformed responses", () => {
  const ok = JSON.parse(readFileSync(FIXTURE, "utf8")) as { locks: Array<Record<string, unknown>> }
  assert.doesNotThrow(() => parseLiveLocks(ok))
  const broken = (f: (b: { locks: Array<Record<string, unknown>> }) => void) => {
    const b = structuredClone(ok)
    f(b)
    return b
  }
  assert.throws(() => parseLiveLocks(null), LiveFormatError)
  assert.throws(() => parseLiveLocks({ locks: [] }), LiveFormatError)
  assert.throws(() => parseLiveLocks(broken((b) => (b.locks[0]!["status"] = "done"))), LiveFormatError)
  assert.throws(() => parseLiveLocks(broken((b) => (b.locks[0]!["expiresAt"] = "soon"))), LiveFormatError)
  assert.throws(() => parseLiveLocks(broken((b) => delete b.locks[1]!["owner"])), LiveFormatError)
  assert.throws(() => parseLiveLocks(broken((b) => (b.locks[0]!["leaseExpired"] = 1))), LiveFormatError)
})

test("live frame: labels say which panels are live, real keys and the FAILED state are shown", () => {
  const live = parseLiveLocks(JSON.parse(readFileSync(FIXTURE, "utf8")))
  const t = 30
  const rows = toLiveRows(live, 1_020_000, t)
  const text = frame(withLiveLocks(stateAt(t, null), rows), { focus: 0, scroll: 0, overlay: null, tick: 0 }, 160, 200).lines.map(plain).join("\n")
  assert.match(text, /R2: LEASE LOCKS \[LIVE\]/)
  assert.match(text, /ARTIFACTS: Agent Forks \[DEMO: illustrative\]/)
  assert.match(text, /v1\/trusted\/cobuild\/demo-ctx\/blake3:aa\/lock\//)
  assert.match(text, /FAILED/)
  assert.match(text, /progress not reported by R2/)
  assert.match(text, /expiry:\s+in 20 s/) // 1 040 000 − 1 020 000 ms
  // Non-regression: the scripted frame carries no live labels and keeps its illustrative keys.
  const scripted = frame(stateAt(t, null), { focus: 0, scroll: 0, overlay: null, tick: 0 }, 160, 200).lines.map(plain).join("\n")
  assert.doesNotMatch(scripted, /\[LIVE\]|\[DEMO/)
  assert.match(scripted, /v1\/lock\/ctx\//)
})

test("fetchLiveLocks sends the token, encodes the context, and rejects HTTP errors", async () => {
  const body = JSON.parse(readFileSync(FIXTURE, "utf8"))
  const seen: Array<{ url: string; auth: string | undefined }> = []
  const fake = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers["authorization"] })
    return { ok: true, status: 200, json: async () => body }
  }
  const live = await fetchLiveLocks("https://w.example/", "tok", "build 1/x", fake)
  assert.equal(live.locks.length, 4)
  assert.deepEqual(seen, [{ url: "https://w.example/api/locks?context=build%201%2Fx", auth: "Bearer tok" }])
  await assert.rejects(fetchLiveLocks("https://w.example", "tok", "c", async () => ({ ok: false, status: 401, json: async () => ({}) })), LiveFormatError)
})

test("--snapshot --locks-json prints a frame with the saved lock rows", () => {
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "main.ts"), "--snapshot", "30", "--locks-json", FIXTURE, "--now-ms", "1020000", "--no-color", "--rows", "200", "--cols", "160"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  assert.match(out, /\[LIVE\]/)
  assert.match(out, /blake3:bb/)
  assert.match(out, /holder:\s+extra2/)
})
