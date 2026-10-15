/**
 * The charts view of the cobuild run (key `c`): six chart tiles drawn from
 * the scenario's own states (`src/charts/run.ts`). The selected tile has a
 * bold border; a zoomed tile fills the body and says what it shows.
 */
import { CH, laneRows, plotCols, plotRows, RUN_TILE, RUN_TILES, type TileDecl } from "../charts/layout.ts"
import { BLANK } from "../charts/plot.ts"
import { activityPlot, algorithmBars, costPlot, LANE_KIND, monthlyBars, progressPlot, timeAxis, timeline } from "../charts/run.ts"
import { GLYPHS, LOWER_EIGHTHS } from "../glyphs.ts"
import { Box, type Color, type InkNode, Text } from "../ink/index.ts"
import { C, TX } from "../theme.ts"
import { AxisChart, BarRow, Legend, PlotLine, XAxis } from "./ChartKit.tsx"
import { Num, Panel, Ref } from "./common.tsx"
import type { PanelProps } from "./props.ts"

export interface ChartTileProps extends PanelProps {
  /** Rows the tile may take (its plot gets the rest after the chrome). */
  readonly rows: number
  readonly zoomed: boolean
}

/** Colours of the agents on the timeline, in the order of `inputs.run.agents`. */
export const AGENT_COLORS: ReadonlyArray<Color> = [C.cyan, C.blue, C.magenta, C.yellow, C.white]

const laneColors = (agents: number): Color[] => {
  const base: Color[] = []
  base[LANE_KIND.free] = C.gray
  base[LANE_KIND.done] = C.green
  base[LANE_KIND.expired] = C.red
  base[LANE_KIND.failed] = C.red
  base[LANE_KIND.crash] = C.red
  base[LANE_KIND.stale] = C.yellow
  return [...base, ...Array.from({ length: agents }, (_, i) => AGENT_COLORS[i % AGENT_COLORS.length]!)]
}

const decl = (id: number): TileDecl => RUN_TILES.find((t) => t.id === id) ?? RUN_TILES[0]!

/** Title row text and the about line of a zoomed tile. */
const Tile = (p: { readonly id: number; readonly width: number; readonly focused: boolean; readonly zoomed: boolean; readonly color: Color; readonly children?: InkNode }) => {
  const d = decl(p.id)
  return (
    <Panel title={`${d.title}${p.zoomed ? "  (zoomed)" : ""}`} keyLabel={String(p.id)} color={p.color} focused={p.focused} width={p.width}>
      {p.zoomed ? <Text {...TX.meta}>{d.about}</Text> : null}
      {p.children}
      {p.zoomed ? <Text {...TX.meta}>{`[ ] scrub time   ${GLYPHS.left.char} ${GLYPHS.arrow.char} / Tab select   z or Enter unzoom   c close`}</Text> : null}
    </Panel>
  )
}

const inner = (width: number): number => width - CH.tileInset

const LeaseTimeline = (p: ChartTileProps) => {
  const plotW = Math.max(CH.minPlotCols, inner(p.width) - CH.laneLabel - 1)
  const tl = timeline(p.state, p.inputs, plotW)
  const colors = laneColors(tl.agents.length)
  const ax = timeAxis()
  const blankLane = Array.from({ length: plotW }, () => BLANK)
  const laneH = p.zoomed ? laneRows(plotRows(p.rows, true) - CH.legendRows, tl.lanes.length) : 1
  return (
    <Tile id={RUN_TILE.timeline} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.magenta}>
      <Legend items={tl.agents.map((a, i) => ({ label: `${a} holds`, color: AGENT_COLORS[i % AGENT_COLORS.length]! }))} />
      <Legend
        items={[
          { label: "free", color: C.gray, swatch: GLYPHS.middot.char },
          { label: "done", color: C.green, swatch: LOWER_EIGHTHS[LOWER_EIGHTHS.length >> 1]! },
          { label: "stale (no heartbeat)", color: C.yellow, swatch: GLYPHS.barOff.char },
          { label: "expired", color: C.red, swatch: GLYPHS.barOff.char },
          { label: "crash", color: C.red, swatch: GLYPHS.bad.char }
        ]}
      />
      {tl.lanes.flatMap((l) =>
        Array.from({ length: laneH }, (_, r) => (
          <Box>
            <Ref {...TX.lock} width={CH.laneLabel}>
              {r === 0 ? l.op.replace(/^op:/, "") : ""}
            </Ref>
            <Text> </Text>
            <PlotLine cells={r > 0 && r === laneH - 1 && laneH > CH.laneGapFrom ? blankLane : l.cells} colors={colors} cursor={tl.cursor} />
          </Box>
        ))
      )}
      <XAxis indent={CH.laneLabel + 1} plotW={plotW} cursor={tl.cursor} left={ax.left} right={ax.right} digits={CH.timeDigits} />
    </Tile>
  )
}

const CostChart = (p: ChartTileProps) => {
  const plotW = plotCols(p.width)
  const c = costPlot(p.state, plotW, plotRows(p.rows, p.zoomed))
  const ax = timeAxis()
  return (
    <Tile id={RUN_TILE.cost} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.yellow}>
      <Legend
        items={[
          { label: "GitHub Actions equiv.", color: C.red, value: c.gha },
          { label: "Cobuilds", color: C.green, value: c.cost, digits: CH.usdFine }
        ]}
        trailing={
          <Text>
            <Text {...TX.label}>{"   saved "}</Text>
            <Num d={c.saved} {...TX.okB} />
          </Text>
        }
      />
      <AxisChart rows={c.plot.rows} colors={[C.red, C.green]} yTop={c.plot.yTop} yBottom={c.plot.yBottom} xLeft={ax.left} xRight={ax.right} xDigits={CH.timeDigits} cursor={c.plot.cursor} plotW={plotW} />
    </Tile>
  )
}

const ProgressChart = (p: ChartTileProps) => {
  const plotW = plotCols(p.width)
  const g = progressPlot(p.state, plotW, plotRows(p.rows, p.zoomed))
  const ax = timeAxis()
  return (
    <Tile id={RUN_TILE.progress} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.cyan}>
      <Legend
        items={[
          { label: "lock progress", color: C.yellow, value: g.progress, digits: 0 },
          { label: "audited", color: C.magenta, value: g.audited }
        ]}
        trailing={
          <Text>
            <Text {...TX.label}>{"   ops done "}</Text>
            <Num d={g.opsDone} bare {...TX.value} />
            <Text {...TX.label}>{" of "}</Text>
            <Num d={g.ops} {...TX.value} />
          </Text>
        }
      />
      <AxisChart rows={g.plot.rows} colors={[C.yellow, C.magenta]} yTop={g.plot.yTop} yBottom={g.plot.yBottom} yDigits={0} xLeft={ax.left} xRight={ax.right} xDigits={CH.timeDigits} cursor={g.plot.cursor} plotW={plotW} />
    </Tile>
  )
}

const ActivityChart = (p: ChartTileProps) => {
  const plotW = plotCols(p.width)
  const a = activityPlot(p.state, plotW, Math.max(1, plotRows(p.rows, p.zoomed) - 1))
  const ax = timeAxis()
  return (
    <Tile id={RUN_TILE.activity} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.blue}>
      <Legend
        items={[
          { label: "events", color: C.blue, value: a.events },
          { label: "R2 writes", color: C.magenta, value: a.writes, swatch: LOWER_EIGHTHS[LOWER_EIGHTHS.length >> 1]! }
        ]}
      />
      <AxisChart rows={[...a.rows]} colors={[C.blue]} yTop={a.yTop} yBottom={a.yBottom} xLeft={ax.left} xRight={ax.right} xDigits={CH.timeDigits} cursor={a.cursor} plotW={plotW} />
      <Box>
        <Ref {...TX.label} width={CH.axis} align="right">
          writes
        </Ref>
        <Text>{"  "}</Text>
        <PlotLine cells={a.spark} colors={[C.magenta]} />
      </Box>
    </Tile>
  )
}

const MonthlyChart = (p: ChartTileProps) => {
  const barW = Math.max(CH.minPlotCols, inner(p.width) - CH.barValue)
  const bars = monthlyBars(p.fig, barW)
  const c = p.fig.cost
  return (
    <Tile id={RUN_TILE.monthly} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.yellow}>
      <Text {...TX.meta}>
        {"at "}
        <Num d={c.runsPerMonth} />
        {", "}
        <Num d={c.minutesPerRun} />
      </Text>
      {bars.map((b) => (
        <BarRow label={b.label} fraction={b.fraction} width={barW} look={b.good ? TX.ok : TX.bad} value={b.value} />
      ))}
      <Text>
        <Text {...TX.okB}>{"saved "}</Text>
        <Num d={c.savingsMonthly} {...TX.okB} />
        <Text {...TX.okB}>{" ("}</Text>
        <Num d={c.savingsPct} {...TX.okB} />
        <Text {...TX.okB}>{")"}</Text>
      </Text>
    </Tile>
  )
}

const AlgorithmChart = (p: ChartTileProps) => {
  const barW = Math.max(CH.minPlotCols, inner(p.width) - CH.barValue - CH.speedup)
  const bars = algorithmBars(p.fig, barW)
  return (
    <Tile id={RUN_TILE.algorithms} width={p.width} focused={p.focused} zoomed={p.zoomed} color={C.green}>
      <Text {...TX.meta}>audit time per algorithm, log scale</Text>
      {bars.map((b, i) => (
        <BarRow
          label={b.label}
          fraction={b.fraction}
          width={barW}
          look={i === bars.length - 1 ? TX.okB : TX.info}
          value={b.value}
          extra={
            <Text>
              <Text {...TX.label}>{"  "}</Text>
              <Num d={b.speedup} {...TX.value} />
            </Text>
          }
        />
      ))}
    </Tile>
  )
}

/** The tile with number `id` (1..6). */
export const RunChartTile = (p: ChartTileProps & { readonly id: number }) => {
  switch (p.id) {
    case RUN_TILE.timeline:
      return <LeaseTimeline {...p} />
    case RUN_TILE.cost:
      return <CostChart {...p} />
    case RUN_TILE.progress:
      return <ProgressChart {...p} />
    case RUN_TILE.activity:
      return <ActivityChart {...p} />
    case RUN_TILE.monthly:
      return <MonthlyChart {...p} />
    default:
      return <AlgorithmChart {...p} />
  }
}
