/**
 * Panel 7 of the clean scenario: charts of the run (key `7` or `c`). Four
 * tiles, two per row when the width allows: bisect confidence and entropy,
 * the probes of each observation on the commit axis, the cache effect and
 * the cost per run. Bisect charts fill in as the Bisect panel replays.
 */
import { cacheBars, confidencePlot, costBars, PROBE_KIND, probeAxis, probeRows } from "../charts/clean.ts"
import { CH, CLEAN_TILE, CLEAN_TILES, plotCols, plotRows } from "../charts/layout.ts"
import type { BisectStatus } from "../clean/bisectStatus.ts"
import type { CleanState } from "../clean/model.ts"
import { GLYPHS } from "../glyphs.ts"
import { Box, type Color, type InkNode, Text } from "../ink/index.ts"
import { C, TX } from "../theme.ts"
import { AxisChart, BarRow, Legend, PlotLine, XAxis } from "./ChartKit.tsx"
import { Num, Pair, Panel, Ref } from "./common.tsx"

export interface CleanChartsProps {
  readonly st: CleanState
  readonly statuses: ReadonlyArray<BisectStatus>
  readonly width: number
  /** Body rows available to the panel. */
  readonly rows: number
}

const title = (id: number): string => CLEAN_TILES.find((t) => t.id === id)?.title ?? ""

const Tile = (p: { readonly id: number; readonly width: number; readonly color: Color; readonly children?: InkNode }) => (
  <Panel title={title(p.id)} color={p.color} focused={false} width={p.width}>
    {p.children}
  </Panel>
)

const NotStarted = () => (
  <Text {...TX.meta}>
    {"open the Bisect panel (key "}
    <Ref {...TX.brand}>4</Ref>
    {") to replay the observations"}
  </Text>
)

const ConfidenceTile = (p: CleanChartsProps & { readonly tileRows: number }) => {
  const plotW = plotCols(p.width)
  const c = confidencePlot(p.st, p.statuses, plotW, plotRows(p.tileRows))
  return (
    <Tile id={CLEAN_TILE.confidence} width={p.width} color={C.magenta}>
      {c.started ? (
        <Legend
          items={[
            { label: "confidence", color: C.green, value: c.confidence },
            { label: "entropy left (bits)", color: C.blue, value: c.entropy, digits: CH.usdDigits }
          ]}
        />
      ) : (
        <NotStarted />
      )}
      <AxisChart rows={c.rows} colors={[C.blue, C.green]} yTop={c.yTop} yBottom={c.yBottom} yDigits={0} xLeft={c.xLeft} xRight={c.xRight} cursor={null} plotW={plotW} />
    </Tile>
  )
}

const PROBE_COLORS: Color[] = []
PROBE_COLORS[PROBE_KIND.pass] = C.green
PROBE_COLORS[PROBE_KIND.fail] = C.red
PROBE_COLORS[PROBE_KIND.culprit] = C.yellow
PROBE_COLORS[PROBE_KIND.axis] = C.gray

const ProbesTile = (p: CleanChartsProps) => {
  const plotW = plotCols(p.width)
  const rows = probeRows(p.st, p.statuses, plotW)
  const ax = probeAxis(p.statuses)
  return (
    <Tile id={CLEAN_TILE.probes} width={p.width} color={C.magenta}>
      <Legend
        items={[
          { label: "probe passed", color: C.green, swatch: GLYPHS.ok.char },
          { label: "probe failed", color: C.red, swatch: GLYPHS.bad.char },
          { label: "culprit guess", color: C.yellow, swatch: GLYPHS.dot.char }
        ]}
      />
      {rows.length === 0 ? <NotStarted /> : null}
      {rows.map((r) => (
        <Box>
          <Num d={r.step} bare prefix="step " width={CH.axis} align="right" {...TX.label} />
          <Text>{"  "}</Text>
          <PlotLine cells={r.cells} colors={PROBE_COLORS} />
        </Box>
      ))}
      <XAxis indent={CH.axis + CH.axisGap} plotW={plotW} cursor={null} left={ax.left} right={ax.right} />
    </Tile>
  )
}

const CacheTile = (p: CleanChartsProps) => {
  const barW = Math.max(CH.minPlotCols, p.width - CH.tileInset - CH.barValue)
  const c = cacheBars(barW)
  return (
    <Tile id={CLEAN_TILE.cache} width={p.width} color={C.blue}>
      <Text {...TX.h1}>dependencies (node_modules)</Text>
      {c.deps.map((b) => (
        <BarRow label={b.label} fraction={b.fraction} width={barW} look={b.good ? TX.ok : TX.bad} value={b.value} />
      ))}
      <Text>
        <Text {...TX.label}>{"saved per restore "}</Text>
        <Num d={c.saved} {...TX.okB} />
      </Text>
      <Text {...TX.h1}>build cache (source modules)</Text>
      {c.build.map((b) => (
        <BarRow label={b.label} fraction={b.fraction} width={barW} look={b.good ? TX.ok : TX.warn} value={b.value} />
      ))}
    </Tile>
  )
}

const CostTile = (p: CleanChartsProps) => {
  const barW = Math.max(CH.minPlotCols, p.width - CH.tileInset - CH.barValue)
  const c = costBars(barW)
  return (
    <Tile id={CLEAN_TILE.cost} width={p.width} color={C.yellow}>
      {c.bars.map((b) => (
        <BarRow label={b.label} fraction={b.fraction} width={barW} look={b.good ? TX.ok : TX.bad} value={b.value} digits={CH.usdDigits + 1} />
      ))}
      <Text>
        <Text {...TX.label}>{"reduction "}</Text>
        <Num d={c.reduction} {...TX.okB} />
      </Text>
      <Text {...TX.meta}>illustrative per-run figures of this demo</Text>
    </Tile>
  )
}

export const CleanChartsPanel = (p: CleanChartsProps) => {
  const tileRows = Math.max(CH.minPlotRows + CH.tileChrome, Math.floor(p.rows / CH.cleanGridRows))
  return (
    <Box flexDirection="column" width={p.width}>
      <Pair width={p.width} left={(w) => <ConfidenceTile {...p} width={w} tileRows={tileRows} />} right={(w) => <ProbesTile {...p} width={w} />} />
      <Pair width={p.width} left={(w) => <CacheTile {...p} width={w} />} right={(w) => <CostTile {...p} width={w} />} />
    </Box>
  )
}
