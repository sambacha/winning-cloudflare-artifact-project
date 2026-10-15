/**
 * Generators and oracles shared by the TUI tests.
 *
 * The generators produce inputs from the whole valid domain described by
 * `src/data.ts` (and some invalid ones, which the laws classify as such);
 * none of them is tuned to the values in `inputs.json`. The oracles are
 * written independently of the code under test.
 */
import { readFileSync } from "node:fs"
import { type Inputs, InputError, parseInputs, parseRun, type RunInput } from "../src/data.ts"
import { DeriveError } from "../src/derive.ts"
import type { Rng } from "./prop.ts"

export const RAW: Record<string, unknown> = JSON.parse(readFileSync(new URL("../inputs.json", import.meta.url), "utf8"))

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** A random factor that reaches 0, small, unchanged and large values. */
const factor = (r: Rng): number => (r.chance(0.08) ? 0 : r.chance(0.1) ? 1 : r.next() * 3)

/** Fields the domain requires to be > 0 (see `parseInputs`), and fields that are fractions in [0, 1]. */
const POSITIVE = new Set(["perTheoremMs", "cores", "totalS", "shared", "oneCoreS", "runsPerMonth"])
const FRACTION = new Set(["warmHitRate", "hitRate"])
/** Lists whose elements are independent (others are cross-referenced by name and are kept whole). */
const DROPPABLE = new Set(["blobs", "drivers", "axioms", "points"])

/** Perturb every number in a JSON value within its domain (integers stay integers); some lists lose elements. */
const perturb = (r: Rng, v: Json, key = ""): Json => {
  if (typeof v === "number") {
    if (FRACTION.has(key)) return r.chance(0.1) ? r.pick([0, 1]) : r.next()
    const f = POSITIVE.has(key) ? (r.chance(0.1) ? 1e-3 : r.next() * 3 + 1e-3) : factor(r)
    const x = v * f
    return Number.isInteger(v) ? (POSITIVE.has(key) ? Math.max(1, Math.round(x)) : Math.round(x)) : x
  }
  if (Array.isArray(v)) {
    const kept = DROPPABLE.has(key) && v.length > 1 && r.chance(0.3) ? v.filter(() => r.chance(0.7)) : v
    return (kept.length === 0 ? v.slice(0, 1) : kept).map((x) => perturb(r, x, key))
  }
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, perturb(r, x, k)]))
  return v
}

/**
 * Random inputs: every number of the static sections perturbed within its
 * domain (the run script is kept, see `genRunRaw` for random scripts). In a
 * tenth of the cases every Cobuilds cost is 0 (the ROI-∞ boundary).
 */
export const genRawInputs = (r: Rng): Record<string, unknown> => {
  const raw = structuredClone(RAW) as Record<string, Json>
  for (const k of ["project", "algorithms", "phases", "resources", "scaling", "auditCache", "graph", "cache", "workload", "prices", "drivers"]) {
    raw[k] = perturb(r, raw[k]!, k)
  }
  const sc = raw["scaling"] as Record<string, Json>
  sc["serialS"] = (sc["oneCoreS"] as number) * (r.chance(0.1) ? r.pick([0, 1]) : r.next())
  if (r.chance(0.1)) {
    const prices = raw["prices"] as Record<string, Json>
    prices["cobuildsRunnerPerRun"] = 0
    prices["r2EgressPerGB"] = 0
    for (const d of raw["drivers"] as Array<Record<string, Json>>) d["price"] = 0
  }
  return raw
}

/** Parse generated inputs; `null` if they are invalid (an `InputError`). */
export const tryInputs = (raw: unknown): Inputs | null => {
  try {
    return parseInputs(raw)
  } catch (e) {
    if (e instanceof InputError) return null
    throw e
  }
}

export const isDeriveError = (e: unknown): boolean => e instanceof DeriveError

// ---------------------------------------------------------------------------
// Random run scripts

/**
 * A random run script: 1–4 agents, 1–5 operations, at most one crash taken
 * over by another agent, random lease/renewal/gap settings. Most scripts are
 * valid; the rest are rejected by `parseRun` (the laws count them as invalid).
 */
export const genRunRaw = (r: Rng): Record<string, unknown> => {
  const nAgents = r.int(1, 4)
  const minWriteGapS = r.pick([0, 0.5, 1, 1, 2])
  const leaseS = r.int(3, 60)
  const renewS = Math.max(minWriteGapS, r.int(1, Math.max(1, leaseS - 1)))
  const agents = Array.from({ length: nAgents }, (_, i) => ({
    id: `agent-${i}`,
    set: `S${i}`,
    forks: [{ fork: `f${i}a`, branch: `task/${i}`, at: r.int(0, 5), commit: `c${i}`, added: r.int(0, 900), removed: r.int(0, 300), files: r.int(0, 20) }]
  }))
  const nOps = r.int(1, 5)
  const crashIdx = nAgents >= 2 && r.chance(0.6) ? r.int(0, nOps - 1) : -1
  const ops = Array.from({ length: nOps }, (_, i) => {
    const holder = r.int(0, nAgents - 1)
    const acquireAt = r.int(0, 30) + (r.chance(0.3) ? r.next() : 0)
    const dur = Math.max(minWriteGapS, r.chance(0.1) ? minWriteGapS : r.int(1, 3 * leaseS))
    const end = acquireAt + dur
    const work = r.chance(0.6) ? { workStart: acquireAt + (end - acquireAt) * r.next() * 0.5 } : {}
    const workEnd = "workStart" in work && r.chance(0.5) ? { workEnd: (work.workStart as number) + (end - (work.workStart as number)) * r.next() } : {}
    const waits = i > 0 && r.chance(0.2) ? { waitsFor: `op:${r.int(0, i - 1)}` } : {}
    if (i === crashIdx) {
      const taker = (holder + r.int(1, nAgents - 1)) % nAgents
      if (r.chance(0.5)) agents[taker]!.forks.push({ fork: `f${taker}t`, branch: `task/${taker}-takeover`, on: "takeover", commit: `t${taker}`, added: 1, removed: 0, files: 1 } as never)
      return { op: `op:${i}`, holder: `agent-${holder}`, acquireAt, crashAt: end, takeoverBy: `agent-${taker}`, takeoverWorkS: Math.max(minWriteGapS, r.int(1, 2 * leaseS)), result: r.pick(["audit", "build"]), ...work, ...workEnd, ...waits }
    }
    return { op: `op:${i}`, holder: `agent-${holder}`, acquireAt, doneAt: end, result: i === 0 ? "manifest" : r.pick(["lint", "build", "audit"]), ...work, ...workEnd, ...waits }
  })
  return {
    startClockS: r.int(0, 86_399),
    leaseS,
    renewS,
    tokenTtlS: r.int(1, 120),
    minWriteGapS,
    spawnS: r.pick([0, 1, 2]),
    agents,
    ops,
    reviewAfterTakeoverS: r.int(0, 5),
    autoTriggerIdleS: r.int(0, 5),
    autoApproveDelayS: r.int(0, 6)
  }
}

export const tryRun = (raw: Record<string, unknown>): RunInput | null => {
  try {
    return parseRun(raw)
  } catch (e) {
    if (e instanceof InputError) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// Width oracle (independent of src/glyphs.ts)

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

/** Code point ranges every terminal draws two columns wide (Unicode East Asian Width W/F, main blocks). */
const WIDE_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initials
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // kana, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x20000, 0x3fffd] // CJK extensions B+
]

/**
 * Display width of one grapheme cluster, or `null` if terminals disagree on
 * it (emoji, joiner sequences, variation selectors, combining marks,
 * controls, wide characters outside the blocks above): a frame must not
 * contain such a cluster at all.
 */
export const oracleClusterWidth = (g: string): number | null => {
  const cps = [...g]
  if (cps.length !== 1) return null
  const ch = cps[0]!
  const cp = ch.codePointAt(0)!
  if (/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{M}\p{C}\p{Zl}\p{Zp}\u200d\ufe0f\ufe0e]/u.test(ch)) return null
  if (cp >= 0x80 && /\p{Emoji}/u.test(ch)) return null
  if (cp >= 0x1f000) return cp >= 0x20000 && cp <= 0x3fffd ? 2 : null
  return WIDE_BLOCKS.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
}

/** Width of a whole line by the oracle; throws if a cluster has no agreed width. */
export const oracleWidth = (text: string): number => {
  let n = 0
  for (const { segment } of segmenter.segment(text)) {
    const w = oracleClusterWidth(segment)
    if (w === null) throw new Error(`cluster ${JSON.stringify(segment)} (U+${[...segment].map((c) => c.codePointAt(0)!.toString(16)).join(" U+")}) has no terminal-independent width`)
    n += w
  }
  return n
}

/** Hostile text: emoji (with skin tones, ZWJ families, flags, VS16), CJK, combining marks, controls, RTL, ANSI. */
export const genHostile = (r: Rng): string => {
  const atoms = [
    "👨‍👩‍👧‍👦",
    "👍🏽",
    "🇯🇵",
    "❤️",
    "⚡",
    "⏸",
    "◉",
    "✔︎",
    "漢字",
    "ﾊﾝｶｸ",
    "한국어",
    "Ｆｕｌｌ",
    "e\u0301",
    "a\u0308\u0323",
    "\u200b",
    "\u200d",
    "\u2028",
    "\u202e",
    "שלום",
    "مرحبا",
    "\x1b[31m",
    "\x07",
    "\t",
    "\u0000",
    "\ud800",
    "\ue000",
    "𠀀",
    "plain",
    " ",
    "-",
    "0123"
  ]
  return Array.from({ length: r.int(1, 8) }, () => r.pick(atoms)).join("")
}
