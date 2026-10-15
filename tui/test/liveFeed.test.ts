/**
 * The live feed in the dashboard (`src/liveFeed.ts`, panels, `--snapshot`
 * flags): honest provenance labels, live values drawn where the plan says,
 * events derived from two saved Worker responses, and no change to the
 * scripted (non-live) frame. The `ts/` side checks the same functions against
 * real Worker responses (`ts/test/worker/liveFeedContract.test.ts`).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { plain } from "../src/ansi.ts"
import { parseLiveLocks, toLiveRows, withLiveLocks, type LiveLock } from "../src/live.ts"
import {
  appendEvents,
  diffLocks,
  feedView,
  type LiveFeedView,
  parseLeanAudit,
  parseLiveArtifacts,
  parseLiveCache,
  withLiveFeed
} from "../src/liveFeed.ts"
import { stateAt } from "../src/scenario.ts"
import { frame } from "../src/view.tsx"
import { announce, law } from "./prop.ts"

announce("test/liveFeed.test.ts")

const FX = (f: string) => join(import.meta.dirname, "fixtures", f)
const json = (f: string): unknown => JSON.parse(readFileSync(FX(f), "utf8"))
const decodable = (f: string) => parseLiveLocks(json(f)).locks.filter((l): l is LiveLock => !("error" in l))

const T = 30
const NOW = 1_020_000

const fullFeed = (): LiveFeedView =>
  feedView({
    locksSeen: true,
    cache: parseLiveCache(json("worker-cache.json")),
    artifacts: parseLiveArtifacts(json("worker-artifacts.json")),
    leanAudit: parseLeanAudit(readFileSync(FX("lake-build.log"), "utf8")),
    events: appendEvents([], diffLocks(decodable("worker-locks-prev.json"), decodable("worker-locks.json")), T, 15)
  })

const render = (feed: LiveFeedView | null, rows = 260) => {
  const base = withLiveLocks(stateAt(T, null), toLiveRows(parseLiveLocks(json("worker-locks.json")), NOW, T))
  const st = feed === null ? base : withLiveFeed(base, feed)
  return frame(st, { focus: 0, scroll: 0, overlay: null, tick: 0 }, 200, rows).lines.map(plain).join("\n")
}

test("diff of the two saved Worker responses: takeover, success marker, failure marker (the undecodable object is ignored)", () => {
  const events = diffLocks(decodable("worker-locks-prev.json"), decodable("worker-locks.json"))
  assert.deepEqual(
    events.map((e) => [e.kind, e.cacheKey, e.owner, e.prevOwner]),
    [
      ["TAKEOVER", "blake3:aa", "primary", "extra2"],
      ["SUCCEEDED", "blake3:bb", "extra1", null],
      ["FAILED", "blake3:cc", "extra2", null]
    ]
  )
})

test("live frame: every panel is labelled by what actually arrived, and shows the live values", () => {
  const text = render(fullFeed())
  assert.match(text, /R2: LEASE LOCKS \[LIVE\]/)
  assert.match(text, /R2 BUILD CACHE \[LIVE\]/)
  assert.match(text, /ARTIFACTS \[LIVE\]/)
  assert.match(text, /Axiom Audit Performance \[MEASURED\]/)
  assert.match(text, /Monthly CI Cost Comparison \[DEMO\]/)
  assert.match(text, /EVENT STREAM derived from R2 lock polls \[LIVE\]/)
  // Live values, exactly as the Worker reported them.
  assert.match(text, /Live R2, scope trusted: blobs 7 \(45\.2 MiB\) │ manifests 3 \(4\.1 KiB\)/)
  assert.match(text, /Remote: https:\/\/acct\.artifacts\.cloudflare\.net\/git\/default\/cobuilds-run-demo-ctx\.git/)
  assert.match(text, /Last commit: 4f2a9c1e0b7d cobuild result: 6 ops, 3 jobs/)
  assert.match(text, /Measured by lake build: 1798 theorems under RequestProject, 0 violations/)
  assert.match(text, /primary took over blake3:aa from extra2 \(If-Match, etag e7\)/)
  assert.match(text, /extra1 published blake3:bb: SUCCEEDED/)
  assert.match(text, /extra2 published blake3:cc: FAILED/)
  // What is not live says so.
  assert.match(text, /Agent forks below are illustrative\./)
  assert.match(text, /The example entry below is illustrative\./)
  assert.match(text, /The figures below are illustrative\./)
  assert.match(text, /Build Pipeline \[DEMO\]/)
  assert.match(text, /Per-Run Cost Breakdown \[DEMO\]/)
  // The scripted header must not claim to be live.
  assert.match(text, /MIXED DATA: see the \[LIVE\]\/\[MEASURED\]\/\[DEMO\] panel tags/)
  assert.doesNotMatch(text, /ILLUSTRATIVE DATA/)
  assert.doesNotMatch(text, /◆ LIVE /)
})

test("live frame without cache, Artifacts or audit: those panels are [DEMO], never [LIVE]/[MEASURED]", () => {
  const text = render(feedView({ locksSeen: true, cache: null, artifacts: null, leanAudit: null, events: [] }))
  assert.match(text, /R2: LEASE LOCKS \[LIVE\]/)
  assert.match(text, /R2 BUILD CACHE \[DEMO\]/)
  assert.match(text, /ARTIFACTS \[DEMO\]/)
  assert.match(text, /Axiom Audit Performance \[DEMO\]/)
  assert.doesNotMatch(text, /Live R2, scope/)
  assert.doesNotMatch(text, /Measured by lake build/)
  assert.match(text, /No lock changes seen yet \(polling the Worker\)\./)
})

test("law: the number of [LIVE]/[MEASURED] tags equals the number of sources that arrived (+1 for events with locks)", () => {
  const full = fullFeed()
  law(
    "tags follow sources",
    16,
    (r) => ({ locks: r.chance(0.5), cache: r.chance(0.5), artifacts: r.chance(0.5), audit: r.chance(0.5) }),
    ({ locks, cache, artifacts, audit }) => {
      const rendered = render(
        feedView({ locksSeen: locks, cache: cache ? full.cache : null, artifacts: artifacts ? full.artifacts : null, leanAudit: audit ? full.leanAudit : null, events: [] })
      )
      // The header legend names all three tags once; it is not a panel label.
      const legend = "see the [LIVE]/[MEASURED]/[DEMO] panel tags"
      assert.equal(rendered.split(legend).length - 1, 1)
      const text = rendered.replace(legend, "")
      const live = (text.match(/\[LIVE\]/g) ?? []).length
      const measured = (text.match(/\[MEASURED\]/g) ?? []).length
      assert.equal(live, (locks ? 2 : 0) + (cache ? 1 : 0) + (artifacts ? 1 : 0))
      assert.equal(measured, audit ? 1 : 0)
      // Eight titled boxes: locks, cache, artifacts, the audit box, events (labelled by source) and
      // build pipeline, monthly cost, per-run cost (always DEMO).
      assert.equal((text.match(/\[DEMO\]/g) ?? []).length, 8 - live - measured)
      return { valid: true, boundary: !locks && !cache && !artifacts && !audit }
    },
    { domain: "the 16 combinations of arrived sources (sampled)", minValidFraction: 1, minBoundary: 0 }
  )
})

test("non-regression: without a feed the frames are unchanged (no provenance tags)", () => {
  const scripted = frame(stateAt(T, null), { focus: 0, scroll: 0, overlay: null, tick: 0 }, 160, 200).lines.map(plain).join("\n")
  assert.doesNotMatch(scripted, /\[LIVE\]|\[DEMO|\[MEASURED\]/)
  const locksOnly = render(null)
  assert.match(locksOnly, /ARTIFACTS: Agent Forks \[DEMO: illustrative\]/)
})

test("appendEvents keeps the newest max events and stamps them with the poll time", () => {
  const evs = diffLocks([], decodable("worker-locks.json"))
  const log = appendEvents(appendEvents([], evs, 1, 4), evs, 2, 4)
  assert.equal(log.length, 4)
  assert.deepEqual(log.map((e) => e.t), [1, 2, 2, 2])
  assert.deepEqual(appendEvents(log, evs, 3, 0), [])
  assert.throws(() => appendEvents([], evs, 1, -1), RangeError)
})

test("--snapshot with saved Worker responses prints the labelled live frame", () => {
  const out = execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "src", "main.ts"),
      "--snapshot", String(T),
      "--locks-json", FX("worker-locks.json"),
      "--prev-locks-json", FX("worker-locks-prev.json"),
      "--cache-json", FX("worker-cache.json"),
      "--artifacts-json", FX("worker-artifacts.json"),
      "--lean-audit", FX("lake-build.log"),
      "--now-ms", String(NOW),
      "--no-color", "--rows", "260", "--cols", "200"
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  )
  assert.match(out, /R2 BUILD CACHE \[LIVE\]/)
  assert.match(out, /ARTIFACTS \[LIVE\]/)
  assert.match(out, /\[MEASURED\]/)
  assert.match(out, /primary took over blake3:aa from extra2/)
})
