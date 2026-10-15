/**
 * Laws of the scripted run (`src/scenario.ts`), checked on random run
 * scripts (random agents, operations, lease/renewal settings, crashes and
 * takeovers) as well as on the demo's own script. The requirements, stated
 * without reference to any particular script:
 *
 * - S1. ETags are per-key versions: the k-th write of a key has version k,
 *   the first write is an acquire with If-None-Match: *, and every later
 *   write names the previous ETag of that key in If-Match (monotonic, no
 *   gaps).
 * - S2. Two writes to the same key are at least `minWriteGapS` apart (R2
 *   accepts one write per key per second).
 * - S3. A live holder never lets its lease lapse: between two of its
 *   consecutive writes on a key there is at most `renewS` < `leaseS`.
 * - S4. A crashed holder's lease expires exactly `leaseS` after its last
 *   write, nobody writes the key in between, and the takeover happens at
 *   the expiry with If-Match on the crashed holder's last ETag. The LEASE
 *   event names that last write and the lease, and they add up to its time.
 * - S5. At any time, a key in state BUILDING has a lease that ends within
 *   (0, leaseS] from now; its holder and ETag are those of the key's last
 *   write.
 * - S6. The event stream is ordered by time, and the stream at time t is a
 *   prefix of the stream at any later time (events are never rewritten).
 * - S7. A decision counts only once the review gate is open; cost counters
 *   never decrease and never exceed the per-run cost.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { INPUTS, type Inputs, type RunInput } from "../src/data.ts"
import { deriveFigures, type Derived } from "../src/derive.ts"
import { buildTimeline, effectiveRun, type Event, makeScenario, type Scenario, type State, type Write } from "../src/scenario.ts"
import { genRunRaw, tryRun } from "./gen.ts"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/scenario.test.ts")

const FIG = deriveFigures(INPUTS)

interface Case {
  readonly run: RunInput | null
  readonly sc: Scenario | null
}

/** A random run (one case in twenty is the demo's own script). */
const genCase = (r: Rng): Case => {
  const run = r.chance(0.05) ? INPUTS.run : tryRun(genRunRaw(r))
  if (run === null) return { run: null, sc: null }
  const inp: Inputs = { ...INPUTS, run }
  return { run, sc: makeScenario(inp, FIG) }
}

const byKey = (ws: ReadonlyArray<Write>): Map<string, Write[]> => {
  const m = new Map<string, Write[]>()
  for (const w of ws) m.set(w.op, [...(m.get(w.op) ?? []), w])
  for (const v of m.values()) v.sort((a, b) => a.t - b.t || a.version - b.version)
  return m
}

/** Sample times: every instant of the timeline, just before/after it, and random times (`u` in [0, 1) scaled to the run). */
const sampleTimes = (u: ReadonlyArray<number>, sc: Scenario): number[] => {
  const ins = sc.timeline.instants
  const last = Math.max(0, ...ins) + 10
  return [...ins.flatMap((t) => [t - 0.01, t, t + 0.01]), ...u.map((x) => x * last), -1, last].sort((a, b) => a - b)
}

const EPS = 1e-9

test("S1/S2/S3: per-key ETag versions are consecutive, If-Match names the previous ETag, writes respect the gap, live holders renew in time", () => {
  law(
    "write log",
    400,
    genCase,
    ({ run, sc }) => {
      if (run === null || sc === null) return { valid: false, boundary: false }
      const keys = byKey(sc.timeline.writes)
      assert.equal(keys.size, run.ops.length, "one key per operation")
      for (const [op, ws] of keys) {
        ws.forEach((w, i) => {
          assert.equal(w.version, i + 1, `${op}: version ${w.version} at position ${i}`)
          if (i === 0) {
            assert.equal(w.kind, "acquire")
            assert.equal(w.ifMatch, null)
          } else {
            assert.notEqual(w.kind, "acquire")
            assert.equal(w.ifMatch, ws[i - 1]!.etag, `${op}: If-Match must name the previous ETag`)
            assert.ok(w.t - ws[i - 1]!.t >= run.minWriteGapS - EPS, `${op}: writes ${ws[i - 1]!.t} and ${w.t} closer than ${run.minWriteGapS}`)
            if (w.writer === ws[i - 1]!.writer) assert.ok(w.t - ws[i - 1]!.t <= run.renewS + EPS, `${op}: ${w.writer} renewed late (${ws[i - 1]!.t} → ${w.t})`)
          }
        })
        assert.equal(new Set(ws.map((w) => w.etag)).size, ws.length, `${op}: ETags repeat`)
        assert.equal(ws[ws.length - 1]!.kind, "publish", `${op}: every key ends with a publish`)
      }
      return { valid: true, boundary: run.minWriteGapS === 0 || [...keys.values()].some((ws) => ws.length === 2) }
    },
    { domain: "1–4 agents, 1–5 ops, lease 3–60 s, renew ∈ [gap, lease), gap ∈ {0, 0.5, 1, 2} s, 60% with a crash; 5% the demo script", minValidFraction: 0.85, minBoundary: 40 }
  )
})

test("S1 rejects ETags that are not per-key versions (the brief's alpha-001 → alpha-003 jump)", () => {
  // Broken variant: an ETag counter shared by the writer across keys (gaps in a key's versions).
  const writerCounter = (ws: ReadonlyArray<Write>) => {
    const n = new Map<string, number>()
    return ws.map((w) => {
      const k = (n.get(w.writer) ?? 0) + 1
      n.set(w.writer, k)
      return { ...w, version: k }
    })
  }
  assert.ok(
    refutes(200, genCase, ({ sc }) => {
      if (sc === null) return true
      return [...byKey(writerCounter(sc.timeline.writes)).values()].every((ws) => ws.every((w, i) => w.version === i + 1))
    })
  )
})

test("S4: a crashed holder's lease expires one lease after its last write; the takeover is at the expiry with If-Match on its last ETag", () => {
  law(
    "crash and takeover",
    400,
    genCase,
    ({ run, sc }) => {
      if (run === null || sc === null) return { valid: false, boundary: false }
      const c = sc.timeline.crash
      const crashed = run.ops.find((o) => o.crashAt !== undefined)
      assert.equal(c === null, crashed === undefined)
      if (c === null || crashed === undefined) return { valid: true, boundary: false }
      const ws = byKey(sc.timeline.writes).get(c.op)!
      const mine = ws.filter((w) => w.writer === c.agent)
      const last = mine[mine.length - 1]!
      assert.equal(c.lastWrite, last.t)
      assert.ok(last.t <= c.at, "the last write precedes the crash")
      assert.equal(c.expiry - c.lastWrite, run.leaseS)
      assert.ok(!ws.some((w) => w.t > c.lastWrite && w.t < c.expiry), "nobody writes the key while the lease runs")
      const take = ws.find((w) => w.kind === "takeover")!
      assert.equal(take.t, c.expiry)
      assert.equal(take.writer, crashed.takeoverBy)
      assert.equal(take.ifMatch, last.etag)
      // The LEASE event: at the expiry; names the last write's clock time and the lease, which add up to the event time.
      const lease = sc.script.filter((e) => e.kind === "LEASE")
      assert.equal(lease.length, 1)
      const figs = lease[0]!.parts.flatMap((p) => (typeof p === "object" && "fig" in p ? [p.fig] : []))
      const clockOf = (t: number) => sc.clock(t).value
      assert.equal(lease[0]!.t, c.expiry)
      assert.ok(figs.some((f: Derived) => f.unit === "clock" && f.value === clockOf(c.lastWrite)), "the LEASE event names the last write")
      assert.ok(figs.some((f: Derived) => f.unit === "s" && f.value === run.leaseS), "the LEASE event names the lease")
      return { valid: true, boundary: c.lastWrite === crashed.acquireAt }
    },
    { domain: "as for the write log", minValidFraction: 0.85, minBoundary: 10 }
  )
})

test("S5: a BUILDING key's lease ends within (0, leaseS] and belongs to the key's last writer", () => {
  law(
    "lock state",
    200,
    (r) => ({ c: genCase(r), u: Array.from({ length: 10 }, () => r.next()) }),
    ({ c: { run, sc }, u }) => {
      if (run === null || sc === null) return { valid: false, boundary: false }
      const keys = byKey(sc.timeline.writes)
      let expired = false // boundary: a holder that missed its renewal (between a crash and the takeover)
      for (const t of sampleTimes(u, sc)) {
        const st: State = sc.stateAt(t, null)
        for (const l of st.locks) {
          const ws = (keys.get(l.op) ?? []).filter((w) => w.t <= t)
          if (t < 0 || ws.length === 0) {
            assert.equal(l.state, "FREE")
            continue
          }
          const last = ws[ws.length - 1]!
          assert.equal(l.holder, last.writer)
          assert.equal(l.etag, last.etag)
          if (l.state === "BUILDING") {
            assert.ok(l.expiresAt! - t > 0 && l.expiresAt! - t <= run.leaseS + EPS, `${l.op} at ${t}: expires at ${l.expiresAt}`)
          }
          if (l.renewalOverdue === true) expired = true
          assert.ok(l.progress >= 0 && l.progress <= 1)
        }
        // At most one holder per key, by construction of the state; and every agent is in a known status.
        assert.equal(new Set(st.locks.map((l) => l.op)).size, st.locks.length)
      }
      return { valid: true, boundary: expired }
    },
    { domain: "as for the write log, ~50 sample times per script (every instant ± 0.01 s, random times)", minValidFraction: 0.85, minBoundary: 1 }
  )
})

test("S6: the event stream is ordered, and the stream at t is a prefix of the stream at any later time", () => {
  law(
    "event stream",
    150,
    genCase,
    ({ run, sc }) => {
      if (run === null || sc === null) return { valid: false, boundary: false }
      const ts = [...sc.timeline.instants, Math.max(...sc.timeline.instants) + 5]
      let prev: ReadonlyArray<Event> = []
      for (const t of ts) {
        const evs: ReadonlyArray<Event> = sc.stateAt(t, null).events
        evs.forEach((e, i) => {
          assert.ok(e.t <= t)
          if (i > 0) assert.ok(evs[i - 1]!.t <= e.t, "events out of order")
        })
        assert.deepEqual(evs.slice(0, prev.length), prev, "earlier events were rewritten")
        prev = evs
      }
      return { valid: true, boundary: run.ops.length === 1 }
    },
    { domain: "as for the write log", minValidFraction: 0.85, minBoundary: 5 }
  )
})

test("S7: decisions before the review gate are ignored; cost counters never decrease and stay within the per-run cost", () => {
  law(
    "review gate and counters",
    150,
    (r) => ({ c: genCase(r), kind: r.pick(["approve", "reject"] as const), offset: r.pick([-1, -0.01, 0, 0.01, 3]) }),
    ({ c: { run, sc }, kind, offset }) => {
      if (run === null || sc === null) return { valid: false, boundary: false }
      const review = sc.timeline.review
      const at = review + offset
      const later = review + 10
      const st = sc.stateAt(later, { kind, at })
      assert.equal(st.finished, offset >= 0)
      if (offset < 0) assert.equal(st.awaitingReview, true)
      let lastCost = -Infinity
      for (const t of [...sc.timeline.instants, later]) {
        const s = sc.stateAt(t, { kind, at })
        assert.ok(s.costSoFar.value >= lastCost - EPS)
        assert.ok(s.costSoFar.value <= FIG.cost.cobuildsPerRun.value + EPS)
        assert.ok(s.ghaEquivalent.value <= FIG.cost.ghaPerRun.value + EPS)
        lastCost = s.costSoFar.value
      }
      return { valid: true, boundary: offset === 0 }
    },
    { domain: "as for the write log; decisions at review + {−1, −0.01, 0, 0.01, 3} s", minValidFraction: 0.85, minBoundary: 15 }
  )
})

test("publish writes wait for the write gap: at or after the scripted end, by less than the gap, and idempotently", () => {
  law(
    "publish time",
    300,
    (r) => tryRun(genRunRaw(r)),
    (run) => {
      if (run === null) return { valid: false, boundary: false }
      const eff = effectiveRun(run)
      assert.deepEqual(effectiveRun(eff), eff)
      let moved = false
      run.ops.forEach((o, i) => {
        const e = eff.ops[i]!
        if (o.doneAt !== undefined) {
          assert.ok(e.doneAt! >= o.doneAt && e.doneAt! <= o.doneAt + run.minWriteGapS + EPS)
          moved = moved || e.doneAt !== o.doneAt
        } else {
          assert.ok(e.takeoverWorkS! >= o.takeoverWorkS! && e.takeoverWorkS! <= o.takeoverWorkS! + run.minWriteGapS + EPS)
        }
      })
      return { valid: true, boundary: moved }
    },
    { domain: "random scripts", minValidFraction: 0.85, minBoundary: 5 }
  )
})

test("the timeline is a function of the run script alone (same script, same timeline)", () => {
  law(
    "timeline determinism",
    200,
    (r) => tryRun(genRunRaw(r)),
    (run) => {
      if (run === null) return { valid: false, boundary: false }
      assert.deepEqual(buildTimeline(run), buildTimeline(structuredClone(run)))
      return { valid: true, boundary: run.ops.length === 1 }
    },
    { domain: "random scripts", minValidFraction: 0.85, minBoundary: 5 }
  )
})

test("run validation: scripts that would break S2/S3 are rejected", () => {
  law(
    "invalid scripts rejected",
    300,
    (r) => {
      const raw = genRunRaw(r) as Record<string, unknown> & { ops: Array<Record<string, unknown>> }
      const breakIt = r.pick(["renewAtLease", "renewBelowGap", "publishTooSoon", "unknownHolder", "duplicateOp", "badWaits"] as const)
      const minGap = (raw["minWriteGapS"] as number) || 1
      if (breakIt === "renewAtLease") raw["renewS"] = raw["leaseS"]
      if (breakIt === "renewBelowGap") {
        raw["minWriteGapS"] = minGap
        raw["renewS"] = minGap / 2
      }
      if (breakIt === "publishTooSoon") {
        raw["minWriteGapS"] = minGap
        const o = raw.ops[0]!
        delete o["crashAt"]
        delete o["takeoverBy"]
        delete o["takeoverWorkS"]
        delete o["workStart"]
        delete o["workEnd"]
        o["doneAt"] = (o["acquireAt"] as number) + minGap / 2
      }
      if (breakIt === "unknownHolder") raw.ops[0]!["holder"] = "nobody"
      if (breakIt === "duplicateOp") raw.ops.push({ ...raw.ops[0]! })
      if (breakIt === "badWaits") raw.ops[0]!["waitsFor"] = "op:missing"
      return { raw, breakIt }
    },
    ({ raw }) => {
      assert.equal(tryRun(raw), null)
      return { valid: true, boundary: true }
    },
    { domain: "random scripts with one rule broken (renew ≥ lease, renew < gap, publish < gap after acquire, unknown holder, duplicate key, dangling waitsFor)", minValidFraction: 1, minBoundary: 1 }
  )
})
