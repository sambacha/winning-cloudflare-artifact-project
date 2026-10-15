/**
 * Chart components shared by the charts views: plot rows coloured by
 * series, a y/x axis frame with a time cursor, horizontal bar rows and
 * legends. The cells come from `src/charts/plot.ts`; every number on screen
 * is a derived figure (`Num`), so the render-tree lint (N2) holds.
 */
import { type Cell, hbar } from "../charts/plot.ts"
import { CH } from "../charts/layout.ts"
import type { Derived } from "../derive.ts"
import { CURSOR_CHAR, GLYPHS } from "../glyphs.ts"
import { Box, type Color, type InkNode, Spacer, Text } from "../ink/index.ts"
import { TX, type TextLook } from "../theme.ts"
import { Cell as TextCell, Num, Ref } from "./common.tsx"

type Run = { text: string; k: number; cursor: boolean }

/** One row of cells, coloured by series; a blank cell in the cursor column shows the cursor. */
export const PlotLine = (p: { readonly cells: ReadonlyArray<Cell>; readonly colors: ReadonlyArray<Color>; readonly cursor?: number | null; readonly dim?: boolean }) => {
  const runs: Run[] = []
  p.cells.forEach((c, i) => {
    const cursor = p.cursor !== undefined && p.cursor !== null && i === p.cursor && c.k < 0
    const ch = cursor ? CURSOR_CHAR : c.ch
    const last = runs[runs.length - 1]
    if (last !== undefined && last.k === c.k && last.cursor === cursor) last.text += ch
    else runs.push({ text: ch, k: c.k, cursor })
  })
  return (
    <Text>
      {runs.map((r) =>
        r.cursor ? (
          <Text {...TX.meta}>{r.text}</Text>
        ) : r.k >= 0 ? (
          <Text color={p.colors[r.k % Math.max(1, p.colors.length)]} dimColor={p.dim}>
            {r.text}
          </Text>
        ) : (
          <Text>{r.text}</Text>
        )
      )}
    </Text>
  )
}

/** The x axis under a plot `plotW` wide, indented by `indent`, with the cursor column marked. */
export const XAxis = (p: { readonly indent: number; readonly plotW: number; readonly cursor: number | null; readonly left: Derived; readonly right: Derived; readonly digits?: number | undefined }) => {
  const line = Array.from({ length: p.plotW }, (_, i) => (i === p.cursor ? "┴" : "─")).join("")
  return (
    <Box flexDirection="column">
      <Text {...TX.meta}>
        {" ".repeat(Math.max(0, p.indent - 1))}
        {"└"}
        {line}
      </Text>
      <Box width={p.indent + p.plotW}>
        <Text>{" ".repeat(p.indent)}</Text>
        <Num d={p.left} digits={p.digits} {...TX.label} />
        <Spacer />
        <Num d={p.right} digits={p.digits} {...TX.label} />
      </Box>
    </Box>
  )
}

/** A plot with a labelled y axis (top and bottom) and a time x axis. */
export const AxisChart = (p: {
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>
  readonly colors: ReadonlyArray<Color>
  readonly yTop: Derived
  readonly yBottom: Derived
  readonly yDigits?: number | undefined
  readonly xLeft: Derived
  readonly xRight: Derived
  readonly xDigits?: number | undefined
  readonly cursor: number | null
  readonly plotW: number
}) => {
  const last = p.rows.length - 1
  return (
    <Box flexDirection="column">
      {p.rows.map((r, i) => (
        <Box>
          {i === 0 || i === last ? <Num d={i === 0 ? p.yTop : p.yBottom} digits={p.yDigits} width={CH.axis} align="right" {...TX.label} /> : <TextCell width={CH.axis}>{""}</TextCell>}
          <Text {...TX.meta}>{i === 0 || i === last ? " ┤" : " │"}</Text>
          <PlotLine cells={r} colors={p.colors} cursor={p.cursor} />
        </Box>
      ))}
      <XAxis indent={CH.axis + CH.axisGap} plotW={p.plotW} cursor={p.cursor} left={p.xLeft} right={p.xRight} digits={p.xDigits} />
    </Box>
  )
}

export interface LegendItem {
  readonly label: string
  readonly color: Color
  readonly value?: Derived | null
  readonly digits?: number | undefined
  /** Swatch glyph (default: a full block). */
  readonly swatch?: string
}

/** A one-line legend: swatch, label and the current value of each series. */
export const Legend = (p: { readonly items: ReadonlyArray<LegendItem>; readonly trailing?: InkNode }) => (
  <Text>
    {p.items.map((it, i) => (
      <Text>
        {i === 0 ? "" : "   "}
        <Text color={it.color}>{it.swatch ?? GLYPHS.barOn.char}</Text>
        <Text {...TX.label}> </Text>
        <Ref {...TX.label}>{it.label}</Ref>
        {it.value === undefined || it.value === null ? null : <Num d={it.value} digits={it.digits} prefix=" " {...TX.value} />}
      </Text>
    ))}
    {p.trailing ?? null}
  </Text>
)

/** A labelled horizontal bar: label row, then bar and value. */
export const BarRow = (p: {
  readonly label: string
  readonly fraction: number
  readonly width: number
  readonly look: TextLook
  readonly value: Derived
  readonly digits?: number | undefined
  readonly extra?: InkNode
}) => (
  <Box flexDirection="column">
    <Ref {...TX.label}>{p.label}</Ref>
    <Text>
      <Text {...p.look}>{hbar(p.fraction, p.width)}</Text>
      <Text> </Text>
      <Num d={p.value} digits={p.digits} {...TX.value} />
      {p.extra ?? null}
    </Text>
  </Box>
)
