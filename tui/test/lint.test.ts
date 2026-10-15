/**
 * Lint rules that keep the numbers derived and the glyphs closed:
 *
 * - N1 (source). A panel component (`src/panels/*.tsx`) contains no numeric
 *   literal except 0 and 1; widths and paddings come from `layout.ts`,
 *   figures from `derive.ts`.
 * - N2 (render tree). In the element tree of every panel, header, footer
 *   and overlay, any text with a digit sits inside `<Num>` (a derived figure
 *   with its unit) or `<Ref>` (an identifier such as an ETag or a key
 *   binding); a bare number child is never rendered.
 * - G1 (rendered output). Every non-ASCII character the dashboard draws
 *   from its own data is in the closed glyph set, and no glyph of the set
 *   is an emoji or pictograph or is East Asian Wide.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { plain } from "../src/ansi.ts"
import { INPUTS } from "../src/data.ts"
import { count, dataNotes, der } from "../src/derive.ts"
import { ALLOWED, GLYPHS, displayWidth } from "../src/glyphs.ts"
import { Box, Newline, Spacer, Text } from "../src/ink/index.ts"
import type { InkElement, InkNode } from "../src/ink/types.ts"
import { loadTypeScript, type TsNode } from "../src/ink/typescript.ts"
import { BREAKPOINTS } from "../src/layout.ts"
import { CachePanel } from "../src/panels/CachePanel.tsx"
import { Footer, Header } from "../src/panels/Chrome.tsx"
import { Num, Ref } from "../src/panels/common.tsx"
import { CostSavingsPanel } from "../src/panels/CostSavingsPanel.tsx"
import { EventStream } from "../src/panels/EventStream.tsx"
import { ForksPanel } from "../src/panels/ForksPanel.tsx"
import { Lean4MetricsPanel } from "../src/panels/Lean4MetricsPanel.tsx"
import { LocksPanel } from "../src/panels/LocksPanel.tsx"
import { GitOverlay, HelpOverlay, NotesOverlay } from "../src/panels/Overlays.tsx"
import type { PanelProps } from "../src/panels/props.ts"
import { FIGURES, SCENARIO, stateAt, TIMELINE } from "../src/scenario.ts"
import { frame, type Overlay } from "../src/view.tsx"
import { announce, law } from "./prop.ts"
import { RunChartTile } from "../src/panels/ChartsView.tsx"
import { ActionsPanel } from "../src/panels/ActionsPanel.tsx"
import { CleanActionsStrip } from "../src/panels/CleanActions.tsx"
import { CacheTile, EventsTile, ForksTile, LeanTile, LocksTile, MonthlyTile, PerRunTile, UrisTile } from "../src/panels/Overview.tsx"
import { UrisPanel } from "../src/panels/UrisPanel.tsx"
import { CleanChartsPanel } from "../src/panels/CleanCharts.tsx"
import { RUN_TILES } from "../src/charts/layout.ts"
import { parseBisectStatus } from "../src/clean/bisectStatus.ts"
import { fixtureStatusBodies } from "../src/clean/figures.ts"
import { AUTOPLAY_END, AUTOPLAY_SCRIPT, stateAt as cleanStateAt } from "../src/clean/model.ts"
import {
  BisectPanel,
  BuildPanel,
  CleanEventStream,
  CleanFooter,
  CleanHeader,
  CleanStart,
  CoordinationPanel,
  DependenciesPanel,
  EnvironmentPanel,
  visibleEvents
} from "../src/panels/CleanPanels.tsx"

announce("test/lint.test.ts")

const PANELS_DIR = fileURLToPath(new URL("../src/panels/", import.meta.url))

/** Rows given to a chart tile in the N2 law (varies with the width so short and tall tiles are both drawn). */
const r0 = (width: number): number => 8 + (width % 23)

test("N1: panel components contain no numeric literal except 0 and 1", () => {
  const ts = loadTypeScript()
  const K = ts.SyntaxKind
  const files = readdirSync(PANELS_DIR).filter((f) => f.endsWith(".tsx"))
  assert.ok(files.length >= 7, "expected the panel components")
  const offences: string[] = []
  for (const f of files) {
    const src = readFileSync(join(PANELS_DIR, f), "utf8")
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget["Latest"]!, true, ts.ScriptKind["TSX"]!)
    const visit = (n: TsNode) => {
      if (n.kind === K["NumericLiteral"] || n.kind === K["BigIntLiteral"]) {
        const text = n.getText(sf)
        if (text !== "0" && text !== "1") {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
          offences.push(`${f}:${line + 1}: ${text}`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  assert.deepEqual(offences, [], `numeric literals in panel components:\n${offences.join("\n")}`)
})

test("N1 catches a numeric literal (the check is not vacuous)", () => {
  const ts = loadTypeScript()
  const sf = ts.createSourceFile("x.tsx", "const W = () => <Text>{'█'.repeat(30)}</Text>", ts.ScriptTarget["Latest"]!, true, ts.ScriptKind["TSX"]!)
  let found = 0
  const visit = (n: TsNode) => {
    if (n.kind === ts.SyntaxKind["NumericLiteral"] && n.getText(sf) !== "0" && n.getText(sf) !== "1") found++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  assert.equal(found, 1)
})

// ---------------------------------------------------------------------------
// N2: the render tree

const PRIMITIVES = new Set<unknown>([Text, Box, Newline, Spacer])
const ALLOWED_DIGIT_PARENTS = new Set<unknown>([Num, Ref])

/** A digit that starts a number token (not part of a name such as "R2", "blake3" or "(R4)"). */
const FREE_DIGIT = /(?<![\p{L}\d])\d/u

const isElement = (n: InkNode): n is InkElement => typeof n === "object" && n !== null && !Array.isArray(n)

/** Texts with a digit that are not inside `Num`/`Ref`, with the component path. */
const freeDigits = (node: InkNode, path: ReadonlyArray<string> = [], guarded = false): string[] => {
  if (node === null || node === undefined || typeof node === "boolean") return []
  if (Array.isArray(node)) return (node as ReadonlyArray<InkNode>).flatMap((c) => freeDigits(c, path, guarded))
  if (typeof node === "number") return guarded ? [] : [`${path.join(" > ")}: number child ${node}`]
  if (typeof node === "string") return !guarded && FREE_DIGIT.test(node) ? [`${path.join(" > ")}: ${JSON.stringify(node)}`] : []
  if (!isElement(node)) return []
  const name = (node.type as { name?: string }).name ?? "?"
  const g = guarded || ALLOWED_DIGIT_PARENTS.has(node.type)
  if (PRIMITIVES.has(node.type)) return freeDigits(node.props["children"] as InkNode, [...path, name], g)
  return freeDigits(node.type(node.props), [...path, name], g)
}

const OVERLAYS: ReadonlyArray<Exclude<Overlay, null>> = ["git", "notes", "help", "charts", "overview"]

test("N2: every text with a digit in the rendered tree is a derived figure (Num) or an identifier (Ref)", () => {
  const times = [-1, ...TIMELINE.instants, TIMELINE.review + TIMELINE.autoApproveDelay + 1]
  law(
    "digits only in Num/Ref",
    60,
    (r) => ({
      // Only 2 of the 21 instants are boundaries (idle, finished): drawn uniformly they gave
      // P(fewer than 5 boundary cases in 60) = 0.31. A quarter of the draws go to them directly.
      t: r.chance(0.25) ? r.pick([times[0]!, times[times.length - 1]!]) : r.pick(times),
      decision: r.chance(0.5) ? null : { kind: r.pick(["approve", "reject"] as const), at: TIMELINE.review },
      width: r.pick([78, 100, 118, 158, 198, r.int(60, 240)]),
      tick: r.int(0, 100),
      anim: r.chance(0.5),
      focused: r.chance(0.3)
    }),
    ({ t, decision, width, tick, anim, focused }) => {
      const st = stateAt(t, decision)
      const props: PanelProps = { state: st, fig: FIGURES, inputs: INPUTS, width, focused, tick, anim }
      const trees: InkNode[] = [
        ForksPanel(props),
        LocksPanel(props),
        CachePanel(props),
        Lean4MetricsPanel(props),
        CostSavingsPanel(props),
        EventStream({ ...props, clock: SCENARIO.clock }),
        ...BREAKPOINTS.map((bp) =>
          Header({ state: st, inputs: INPUTS, clock: SCENARIO.clock, constants: FIGURES.project.constants, seed: tick, tick, anim, compact: bp.headerRows === 1, logo: bp.logo, width })
        ),
        Footer({ state: st, tick, anim, compact: false, width, hidden: count(2, "panels", "test"), scroll: { from: der(1, "lines", "f", ["d"]), to: der(9, "lines", "f", ["d"]), total: der(99, "lines", "f", ["d"]) } }),
        Footer({ state: st, tick, anim, compact: true, width, hidden: null, scroll: null }),
        ...RUN_TILES.flatMap((d) => [false, true].map((zoomed) => RunChartTile({ ...props, id: d.id, rows: r0(width), zoomed }))),
        UrisPanel(props),
        ActionsPanel({ state: st, width, rows: 4 + (width % 9), clock: SCENARIO.clock }),
        ...[MonthlyTile, PerRunTile, LocksTile, ForksTile, UrisTile, EventsTile, CacheTile, LeanTile].map((T) => T({ ...props, rows: 3 + (width % 7), clock: SCENARIO.clock })),
        GitOverlay({ state: st, width }),
        NotesOverlay({ notes: dataNotes(INPUTS, FIGURES), width }),
        HelpOverlay({ width })
      ]
      const offences = trees.flatMap((tr) => freeDigits(tr))
      assert.deepEqual(offences, [], offences.join("\n"))
      return { valid: true, boundary: st.finished || !st.triggered }
    },
    { domain: "idle, every script instant and after the decision; widths 60–240; ticks; motion on/off; focus on/off", minValidFraction: 1, minBoundary: 5 }
  )
})

test("N2: the clean scenario's panels show digits only in Num/Ref", () => {
  const statuses = fixtureStatusBodies().map(parseBisectStatus)
  const clock = { kind: "fixed", ms: 0 } as const
  const times = [0, 1, ...AUTOPLAY_SCRIPT.flatMap((k) => [k.at, k.at + 0.7, k.at + 1.5, k.at + 4.5]), AUTOPLAY_END]
  law(
    "clean panels: digits only in Num/Ref",
    60,
    // The boundary (the end of the run) is 1 of ~40 instants: drawn uniformly, P(no boundary in 60) ≈ 0.22.
    // A quarter of the draws go to it directly.
    (r) => ({ t: r.chance(0.25) ? AUTOPLAY_END : r.pick(times), width: r.pick([78, 118, 138, 198, r.int(80, 240)]) }),
    ({ t, width }) => {
      const st = cleanStateAt(t, statuses)
      const p = { st, statuses, width }
      const trees: InkNode[] = [
        CleanHeader({ clock, t, width }),
        CleanFooter({ focus: st.focus, width }),
        CleanStart({ t, width }),
        EnvironmentPanel(p),
        DependenciesPanel(p),
        BuildPanel(p),
        BisectPanel(p),
        CoordinationPanel(p),
        CleanEventStream({ ...p, maxRows: 30 }),
        CleanChartsPanel({ ...p, rows: 30 }),
        CleanActionsStrip({ events: visibleEvents(st, statuses), width, rows: 6 })
      ]
      const offences = trees.flatMap((tr) => freeDigits(tr))
      assert.deepEqual(offences, [], offences.join("\n"))
      return { valid: true, boundary: t === AUTOPLAY_END }
    },
    { domain: "every scripted instant of the clean run; widths 78-240", minValidFraction: 1, minBoundary: 1 }
  )
})

test("N2 flags a digit outside Num/Ref (the check is not vacuous)", () => {
  const Bad = () => ({ type: Text, props: { children: ["cost: ", "$1.32"] }, key: null }) as InkElement
  assert.equal(freeDigits({ type: Bad, props: {}, key: null } as InkElement).length, 1)
  assert.equal(freeDigits({ type: Bad, props: {}, key: null } as InkElement, [], true).length, 0)
})

// ---------------------------------------------------------------------------
// G1: the closed glyph set

test("G1: the glyph set has no emoji, pictograph or wide character, and every fallback is ASCII of the same width", () => {
  for (const [ch, ascii] of ALLOWED) {
    assert.equal([...ch].length, 1, ch)
    assert.ok(!/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(ch) && !(/\p{Emoji}/u.test(ch) && ch.codePointAt(0)! >= 0x80), `${ch} has an emoji form`)
    assert.equal(displayWidth(ch), 1, `${ch} is not one column`)
    assert.match(ascii, /^[\x20-\x7e]$/, `fallback of ${ch}`)
  }
  for (const g of Object.values(GLYPHS)) assert.ok(ALLOWED.has(g.char))
})

test("G1: every non-ASCII character drawn from the demo's own data is in the closed set", () => {
  const times = [-1, ...TIMELINE.instants, TIMELINE.review + 1]
  law(
    "closed glyph set in frames",
    50,
    (r) => ({
      t: r.pick(times),
      bp: r.pick(BREAKPOINTS),
      overlay: r.pick([null, null, ...OVERLAYS] as const),
      focus: r.int(0, 7),
      scroll: r.chance(0.5) ? 0 : r.int(0, 200),
      decision: r.chance(0.5) ? null : { kind: r.pick(["approve", "reject"] as const), at: TIMELINE.review }
    }),
    ({ t, bp, overlay, focus, scroll, decision }) => {
      const f = frame(stateAt(t, decision), { focus, scroll, overlay, tick: 0 }, bp.cols, bp.rows)
      const strange = new Set<string>()
      for (const l of f.lines) for (const ch of plain(l)) if (ch.codePointAt(0)! >= 0x80 && !ALLOWED.has(ch)) strange.add(ch)
      assert.deepEqual([...strange], [], `characters outside the closed set: ${[...strange].join(" ")}`)
      return { valid: true, boundary: overlay !== null }
    },
    { domain: "4 breakpoints × idle/every instant/after the gate × overlays × focus × scroll", minValidFraction: 1, minBoundary: 10 }
  )
})
