/**
 * Width invariant of the dashboard, on fuzz input including CJK, ZWJ
 * sequences, flags, skin-tone emoji, East Asian Ambiguous characters,
 * combining marks and control characters.
 *
 * The oracle is independent of `src/tui/width.ts`: inputs are built from
 * tokens whose rendered width is known by construction (a CJK ideograph is
 * two cells, a whole ZWJ family is one replacement cell, a control
 * character is none), and the expected width is the sum of the tokens'
 * labels. Characters of the output are classified by the oracle's own
 * alphabet, not by `isWide`.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law, mutantKilled } from "../harness.js"
import { SUPPORTED_SIZES } from "../../src/tui/constants.js"
import { renderFrame } from "../../src/tui/frame.js"
import type { DashboardInput, PanelKey } from "../../src/tui/model.js"
import { initialUi } from "../../src/tui/model.js"
import { scenarioInput } from "../../src/tui/scenario.js"
import { displayWidth, fit, sanitize } from "../../src/tui/width.js"

announce("test/tui/width.test.ts")

interface Token {
  readonly text: string
  readonly cells: number
  readonly kind: "ascii" | "cjk" | "zwj" | "flag" | "emoji" | "ambiguous" | "control" | "accent"
}

const CJK = ["\u4e2d", "\u6587", "\u65e5", "\u672c", "\u3042", "\u30ab", "\ud55c", "\uae00", "\uff21", "\u3000"] as const
const ZWJ = ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F3F3}\uFE0F\u200D\u{1F308}", "\u{1F469}\u200D\u{1F4BB}"] as const
const FLAGS = ["\u{1F1EF}\u{1F1F5}", "\u{1F1FA}\u{1F1F8}"] as const
const EMOJI = ["\u{1F44D}\u{1F3FD}", "\u{1F600}", "\u2764\uFE0F"] as const
const AMBIGUOUS = ["\u2500", "\u03b1", "\u2192", "\u00b7", "\u2588"] as const
const CONTROL = ["\u001b", "\u0007", "\u0085", "\u0000"] as const
const ACCENT = ["\u00e9", "e\u0301", "\u00f1"] as const

const token: fc.Arbitrary<Token> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((c): Token => ({ text: String.fromCharCode(c), cells: 1, kind: "ascii" })) },
  { weight: 3, arbitrary: fc.constantFrom(...CJK).map((text): Token => ({ text, cells: 2, kind: "cjk" })) },
  { weight: 1, arbitrary: fc.constantFrom(...ZWJ).map((text): Token => ({ text, cells: 1, kind: "zwj" })) },
  { weight: 1, arbitrary: fc.constantFrom(...FLAGS).map((text): Token => ({ text, cells: 1, kind: "flag" })) },
  { weight: 1, arbitrary: fc.constantFrom(...EMOJI).map((text): Token => ({ text, cells: 1, kind: "emoji" })) },
  { weight: 1, arbitrary: fc.constantFrom(...AMBIGUOUS).map((text): Token => ({ text, cells: 1, kind: "ambiguous" })) },
  { weight: 1, arbitrary: fc.constantFrom(...CONTROL).map((text): Token => ({ text, cells: 0, kind: "control" })) },
  { weight: 1, arbitrary: fc.constantFrom(...ACCENT).map((text): Token => ({ text, cells: 1, kind: "accent" })) }
)

const tokens = fc.array(token, { maxLength: 40 })
const joined = (ts: ReadonlyArray<Token>): string => ts.map((t) => t.text).join("")
const labelled = (ts: ReadonlyArray<Token>): number => ts.reduce((a, t) => a + t.cells, 0)

/** Oracle cell width of an output string: printable ASCII = 1, the CJK alphabet above = 2; anything else is not allowed out. */
const CJK_SET = new Set<string>(CJK)
const oracleWidth = (s: string): number => {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) w += 1
    else if (CJK_SET.has(ch)) w += 2
    else throw new Error(`unexpected output character U+${cp.toString(16)}`)
  }
  return w
}

describe("width: sanitize / displayWidth / fit", () => {
  it("displayWidth equals the labelled width; the sanitised text only has ASCII and known wide characters", () => {
    law(
      "displayWidth(concat tokens) = sum of labels",
      tokens,
      (ts) => {
        const s = joined(ts)
        expect(displayWidth(s)).toBe(labelled(ts))
        expect(oracleWidth(sanitize(s))).toBe(labelled(ts))
        return { valid: ts.some((t) => t.kind !== "ascii"), boundary: ts.length === 0 || ts.some((t) => t.kind === "zwj" || t.kind === "control") }
      },
      400,
      { domain: "<=40 tokens: ASCII, CJK, ZWJ families, flags, skin tones, ambiguous, controls, accents", minValidFraction: 0.8, minBoundary: 20 }
    )
  })

  it("fit(s, w) is exactly w cells (oracle), for every width including a wide char straddling the edge", () => {
    law(
      "oracleWidth(fit(s, w)) = w",
      fc.tuple(tokens, fc.integer({ min: 0, max: 60 }), fc.constantFrom<"left" | "right">("left", "right")),
      ([ts, w, align]) => {
        const out = fit(joined(ts), w, align)
        expect(oracleWidth(out)).toBe(w)
        return { valid: w > 0, boundary: w === 0 || w === 1 || labelled(ts) === w || labelled(ts) === w + 1 }
      },
      600,
      { domain: "token strings x width 0..60 x alignment", minValidFraction: 0.9, minBoundary: 20 }
    )
  })

  it("the oracle is not vacuous: string length as width is refuted", () => {
    expect(mutantKilled(tokens, (ts) => [...sanitize(joined(ts))].length === labelled(ts), 300)).toBe(true)
  })
})

/** Put fuzz strings into every text field the panels show. */
const withFuzz = (base: DashboardInput, s: ReadonlyArray<string>): DashboardInput => {
  const pick = (i: number): string => s[i % Math.max(1, s.length)] ?? ""
  return {
    ...base,
    title: `cobuilds ${pick(0)}`,
    repos: base.repos.map((r, i) => ({ ...r, name: `${r.name}${pick(i + 1)}`, detail: pick(i + 2) })).concat([{ name: pick(3), status: "error", head: null, headAt: null, detail: pick(4) }]),
    leases: base.leases.map((l, i) => ({ ...l, owner: pick(i + 5), cacheKey: `${l.cacheKey}${pick(i + 6)}` })),
    events: base.events.map((e, i) => ({ ...e, text: `${e.text} ${pick(i)}` })),
    bisect:
      base.bisect === null
        ? null
        : {
            ...base.bisect,
            body: {
              ...base.bisect.body,
              repo: pick(7),
              tally: base.bisect.body.tally.map((t, i) => ({ ...t, oid: `${pick(i)}${t.oid}` })),
              status: { ...base.bisect.body.status, next: base.bisect.body.status.next === null ? null : { ...base.bisect.body.status.next, message: pick(8) }, culprit: { ...base.bisect.body.status.culprit, message: pick(9) } }
            }
          }
  }
}

describe("width: whole frames on fuzz input", () => {
  it("every line of every frame is exactly the terminal width at 80x24, 120x40, 200x60 (oracle)", () => {
    law(
      "frames with fuzzed text fields keep exact widths",
      fc.tuple(fc.array(tokens.map(joined), { minLength: 1, maxLength: 10 }), fc.integer({ min: 0, max: 150 }), fc.constantFrom<PanelKey>(1, 2, 3, 4, 5), fc.boolean()),
      ([strs, sec, focus, notes]) => {
        const input = withFuzz(scenarioInput("fuzz", sec), strs)
        for (const { cols, rows } of SUPPORTED_SIZES) {
          const lines = renderFrame(input, { ...initialUi, focus, notes }, cols, rows)
          expect(lines.length).toBe(rows)
          for (const l of lines) expect(oracleWidth(l)).toBe(cols)
        }
        return { valid: strs.some((s) => s.length > 0), boundary: sec === 0 || strs.some((s) => /\u200D/.test(s)) }
      },
      60,
      { domain: "scenario frames 0..150 s with fuzz strings in names, messages, owners, events", minValidFraction: 0.8, minBoundary: 5 }
    )
  })
})
