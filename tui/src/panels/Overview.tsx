/**
 * The overview (key `o`): every panel of the dashboard as a compact tile, so
 * that the whole run is on one screen. Each tile names the panel it
 * summarises and its key; the key opens the full panel.
 *
 * Every tile body is exactly `rows` lines (cut, or padded with blank lines),
 * so the grid in `view.tsx` lines up.
 */
import { lockFigures, normalizedBars, type Derived } from "../derive.ts"
import { GLYPHS } from "../glyphs.ts"
import { Box, type Color, type InkNode, Spacer, Text } from "../ink/index.ts"
import { DIGITS, OVERVIEW as O, W } from "../layout.ts"
import type { Event, Kind } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { Bar, Cell, Glyph, Num, Parts, Ref, taggedTitle } from "./common.tsx"
import { statusLook } from "./ForksPanel.tsx"
import { blink, type PanelProps } from "./props.ts"
import { compactUriLines } from "./UrisPanel.tsx"

/** Exactly `rows` children: the first `rows` of `lines`, then blank lines. */
const exactly = (lines: ReadonlyArray<InkNode>, rows: number): InkNode[] => [
  ...lines.slice(0, Math.max(0, rows)),
  ...Array.from({ length: Math.max(0, rows - lines.length) }, () => <Text> </Text>)
]

/** A compact tile: border, title row with the key of the full panel, `rows` body lines. */
export const Tile = (p: { readonly title: InkNode; readonly keyLabel: string; readonly color: Color; readonly width: number; readonly rows: number; readonly lines: ReadonlyArray<InkNode> }) => (
  <Box flexDirection="column" width={p.width} borderStyle="single" borderColor={p.color} borderDimColor paddingX={1}>
    <Box>
      <Text color={p.color} bold>
        {p.title}
      </Text>
      <Spacer />
      <Ref {...TX.meta}>{`[${p.keyLabel}]`}</Ref>
    </Box>
    {exactly(p.lines, p.rows)}
  </Box>
)

export interface TileProps extends PanelProps {
  /** Body lines of the tile (borders and title excluded). */
  readonly rows: number
  readonly clock: (t: number) => Derived
}

/** Width of a bar in a tile `width` wide that keeps `reserve` columns for text. */
const barWidth = (width: number, reserve: number): number => Math.max(1, Math.min(O.bar, width - O.inset - reserve))

export const MonthlyTile = (p: TileProps) => {
  const c = p.fig.cost
  const rows = [
    { label: "GHA standard", d: c.ghaMonthly, look: TX.bad },
    { label: "GHA 4-core", d: c.ghaLargerMonthly, look: TX.bad },
    { label: "Cobuilds (CF)", d: c.cobuildsMonthly, look: TX.ok }
  ]
  const bw = barWidth(p.width, O.costLabel + O.costValue)
  const bars = normalizedBars(
    rows.map((r) => r.d.value),
    bw
  )
  const lines = [
    ...rows.map((r, i) => (
      <Box>
        <Ref {...TX.label} width={O.costLabel}>
          {r.label}
        </Ref>
        <Text {...r.look}>{GLYPHS.barOn.char.repeat(bars[i]!)}</Text>
        <Text>{" ".repeat(Math.max(0, bw - bars[i]!) + 1)}</Text>
        <Num d={r.d} {...TX.value} />
      </Box>
    )),
    <Text>
      <Text {...TX.okB}>Savings </Text>
      <Num d={c.savingsMonthly} {...TX.okB} />
      <Text {...TX.okB}> (</Text>
      <Num d={c.savingsPct} {...TX.okB} />
      <Text {...TX.okB}>)</Text>
    </Text>,
    <Text>
      <Text {...TX.label}>ROI </Text>
      <Num d={c.roi} {...TX.ok} />
      <Text {...TX.label}>{"  annual "}</Text>
      <Num d={c.annual} {...TX.ok} />
    </Text>,
    <Text {...TX.meta}>
      {"at "}
      <Num d={c.runsPerMonth} />
    </Text>
  ]
  return <Tile title={taggedTitle("Monthly CI Cost Comparison", p.state, "cost")} keyLabel="5" color={C.yellow} width={p.width} rows={p.rows} lines={lines} />
}

export const PerRunTile = (p: TileProps) => {
  const c = p.fig.cost
  const head = { color: C.gray, bold: true } as const
  const row = (label: string, gha: InkNode, cob: InkNode, look: TextLook = TX.label) => (
    <Box>
      <Cell {...look} width={O.label}>
        {label}
      </Cell>
      {gha}
      {cob}
    </Box>
  )
  const lines = [
    row("Item", <Cell {...head} width={W.costCell} align="right">GHA</Cell>, <Cell {...head} width={W.costCell} align="right">Cobuilds</Cell>),
    row(
      "Total per run",
      <Num d={c.ghaPerRun} bare digits={DIGITS.cents} width={W.costCell} align="right" {...TX.badB} />,
      <Num d={c.cobuildsPerRun} bare digits={DIGITS.perRun} width={W.costCell} align="right" {...TX.okB} />,
      { color: C.white, bold: true }
    ),
    row("Savings per run", <Cell width={W.costCell}> </Cell>, <Num d={c.savingsPerRun} bare width={W.costCell} align="right" {...TX.okB} />),
    row("Reduction", <Cell width={W.costCell}> </Cell>, <Num d={c.reductionPct} width={W.costCell} align="right" {...TX.okB} />),
    <Text>
      <Text {...TX.label}>This run so far: </Text>
      <Num d={p.state.costSoFar} digits={DIGITS.perRun} {...TX.okB} />
    </Text>,
    <Text>
      <Text {...TX.label}>GHA equivalent:  </Text>
      <Num d={p.state.ghaEquivalent} {...TX.bad} />
    </Text>
  ]
  return <Tile title="Per-Run Cost Breakdown" keyLabel="5" color={C.yellow} width={p.width} rows={p.rows} lines={lines} />
}

const lockLook = (state: string): TextLook => (state === "SUCCEEDED" ? TX.okB : state === "BUILDING" ? TX.warnB : state === "FAILED" || state === "EXPIRED" ? TX.badB : TX.label)

export const LocksTile = (p: TileProps) => {
  const bw = barWidth(p.width, O.label + O.pct + O.status)
  const lines = p.state.locks.map((l) => (
    <Box>
      <Ref {...TX.lock} width={O.label}>
        {l.op.replace(/^op:/, "")}
      </Ref>
      <Bar fraction={l.progress} width={bw} on={l.state === "SUCCEEDED" ? TX.ok : l.state === "EXPIRED" || l.state === "FAILED" ? TX.bad : TX.warn} />
      <Text> </Text>
      <Num d={lockFigures(l, p.state.t).progress} digits={0} width={O.pct} {...TX.value} />
      <Cell {...lockLook(l.state)} width={O.status}>
        {l.state}
      </Cell>
      <Ref {...TX.label}>{l.holder ?? ""}</Ref>
    </Box>
  ))
  return <Tile title={taggedTitle("R2: LEASE LOCKS", p.state, "locks")} keyLabel="2" color={C.magenta} width={p.width} rows={p.rows} lines={lines} />
}

export const ForksTile = (p: TileProps) => {
  const on = blink(p)
  const pr = p.state.forks.find((f) => f.merged) ?? null
  const lines = [
    ...p.state.agents.map((a) => {
      const look = statusLook(a, on)
      return (
        <Box>
          <Glyph name={look.glyph} {...look.look} />
          <Text> </Text>
          <Ref color={C.white} bold width={O.agent}>
            {a.id}
          </Ref>
          <Ref {...TX.lock} width={O.fork}>
            {a.fork ?? GLYPHS.dash.char}
          </Ref>
          <Cell {...look.look}>{look.label}</Cell>
        </Box>
      )
    }),
    pr === null ? (
      <Text {...TX.label}>{p.state.triggered ? "one Artifacts fork per agent" : "press SPACE to fork trunk"}</Text>
    ) : (
      <Text>
        <Glyph name="ok" {...TX.okB} />
        <Text {...TX.okB}> merged </Text>
        <Ref {...TX.lock}>{`fork/${pr.fork}`}</Ref>
        <Text {...TX.okB}> into trunk</Text>
      </Text>
    )
  ]
  return <Tile title={taggedTitle("ARTIFACTS: Agent Forks", p.state, "artifacts")} keyLabel="1" color={C.cyan} width={p.width} rows={p.rows} lines={lines} />
}

export const UrisTile = (p: TileProps) => (
  <Tile title="CLOUDFLARE URIs" keyLabel="u" color={C.blue} width={p.width} rows={p.rows} lines={compactUriLines(p.state, p.inputs, p.rows)} />
)

const KIND_LOOK: Partial<Readonly<Record<Kind, TextLook>>> = { LOCK: TX.lock, HB: TX.ok, FORK: TX.brand, TOKEN: TX.brand, CACHE: TX.info, LEASE: TX.badB, REVIEW: TX.warnB, MERGE: TX.okB, REJECT: TX.badB }

export const EventsTile = (p: TileProps) => {
  const events: ReadonlyArray<Event> = p.state.events.slice(-Math.max(1, p.rows))
  const lines =
    events.length === 0
      ? [<Text {...TX.label}>No events yet.</Text>]
      : events.map((e) => (
          <Box>
            <Num d={p.clock(e.t)} width={W.clock} {...TX.meta} />
            <Cell {...(KIND_LOOK[e.kind] ?? TX.value)} width={W.kind}>
              {e.kind}
            </Cell>
            <Parts parts={e.parts} {...(e.kind === "LEASE" ? TX.bad : TX.value)} />
          </Box>
        ))
  return <Tile title="EVENT STREAM" keyLabel="e" color={C.cyan} width={p.width} rows={p.rows} lines={lines} />
}

export const CacheTile = (p: TileProps) => {
  const f = p.fig.cache
  const st = p.state
  const lines = [
    <Text>
      <Text {...TX.label}>Hit rate </Text>
      <Num d={f.hitRate} {...TX.okB} />
      <Text {...TX.label}>{"  dedup "}</Text>
      <Num d={f.dedup} {...TX.ok} />
    </Text>,
    <Text>
      <Text {...TX.label}>Entry </Text>
      <Num d={f.stored} {...TX.info} />
      <Text {...TX.label}>{" in "}</Text>
      <Num d={f.blobCount} {...TX.value} />
    </Text>,
    <Text>
      <Text {...TX.label}>Manifest: </Text>
      {st.published ? <Text {...TX.okB}>published</Text> : <Text {...TX.label}>not yet published</Text>}
    </Text>,
    <Text>
      <Text {...TX.label}>Blobs: </Text>
      {st.verifiedByTaker ? <Text {...TX.okB}>downloaded, BLAKE3 verified</Text> : st.published ? <Text {...TX.ok}>uploaded</Text> : <Text {...TX.label}>pending</Text>}
    </Text>,
    <Text>
      <Text {...TX.label}>Saved </Text>
      <Num d={f.saved} {...TX.ok} />
    </Text>
  ]
  return <Tile title={taggedTitle("R2 BUILD CACHE", p.state, "cache")} keyLabel="3" color={C.blue} width={p.width} rows={p.rows} lines={lines} />
}

export const LeanTile = (p: TileProps) => {
  const f = p.fig
  const st = p.state
  const frac = f.project.theorems.value === 0 ? 0 : st.theoremsAudited.value / f.project.theorems.value
  const best = [...f.algorithms].sort((a, b) => b.speedup.value - a.speedup.value)[0]
  const lines = [
    <Text>
      <Text {...TX.label}>Audited </Text>
      <Num d={st.theoremsAudited} bare {...(st.auditDone ? TX.okB : TX.warn)} />
      <Text {...TX.label}> of </Text>
      <Num d={f.project.theorems} {...TX.value} />
    </Text>,
    <Box>
      <Bar fraction={frac} width={barWidth(p.width, O.pct)} on={st.auditDone ? TX.ok : TX.warn} />
    </Box>,
    <Text>
      <Text {...TX.label}>Forbidden axioms: </Text>
      <Num d={f.axioms.forbiddenFound} bare {...TX.okB} />
      <Text {...TX.label}> of </Text>
      <Num d={f.axioms.checked} {...TX.value} />
    </Text>,
    best === undefined ? (
      <Text> </Text>
    ) : (
      <Text>
        <Text {...TX.label}>Fastest: </Text>
        <Ref {...TX.okB}>{best.name}</Ref>
        <Text {...TX.label}> </Text>
        <Num d={best.speedup} {...TX.ok} />
      </Text>
    ),
    <Text>
      <Text {...TX.label}>Mathlib </Text>
      <Num d={f.project.constants} {...TX.value} />
    </Text>
  ]
  return <Tile title={taggedTitle("LEAN CI METRICS", p.state, "lean")} keyLabel="4" color={C.green} width={p.width} rows={p.rows} lines={lines} />
}
