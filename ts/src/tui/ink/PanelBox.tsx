/**
 * A box on screen: the rows of `boxRows` (the same rows the snapshot
 * renderer prints), one `<Text>` per line inside a column `<Box>`. Borders
 * are ASCII characters drawn by `boxRows`, not Ink's box-drawing borders
 * (those are East Asian Ambiguous width in some terminals).
 */
import { Box, Text } from "ink"
import { boxRows } from "../frame.js"
import type { PanelContent, Row, Tone } from "../rows.js"

/** Ink text style of a tone. */
export interface ToneStyle {
  readonly color?: string
  readonly dimColor?: boolean
  readonly bold?: boolean
}

/** Colour of each tone (named colours, so the dashboard works on 16-colour terminals). */
export const TONE_STYLE: Readonly<Record<Tone, ToneStyle>> = {
  normal: {},
  dim: { dimColor: true },
  title: { color: "cyan", bold: true },
  good: { color: "green" },
  bad: { color: "red" },
  warn: { color: "yellow" },
  accent: { color: "magenta" }
}

/** One line, already exactly the right width. */
export const RowText = ({ row }: { readonly row: Row }) => (
  <Text {...TONE_STYLE[row.tone]} wrap="truncate">
    {row.text}
  </Text>
)

/** Props of a box. */
export interface PanelBoxProps {
  readonly content: PanelContent
  readonly width: number
  readonly height: number
  readonly focused: boolean
}

/** A bordered panel exactly `width` x `height`. */
export const PanelBox = ({ content, width, height, focused }: PanelBoxProps) => (
  <Box flexDirection="column" width={width} height={height}>
    {boxRows(content, width, height, focused).map((r, i) => (
      <RowText key={i} row={r} />
    ))}
  </Box>
)
