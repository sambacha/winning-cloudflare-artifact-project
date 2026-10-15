/**
 * Shared panel components. `Num` and `Ref` are the only ways a panel shows
 * text with digits in it:
 * - `<Num d={derived} />` shows a figure from `derive.ts` (with its unit);
 * - `<Ref>` shows an identifier or label that contains digits but is not a
 *   quantity (a digest, an ETag, a fork id, a key binding such as "[3]").
 * The render-tree lint (`test/lint.test.ts`) rejects any other text with a
 * free-standing digit.
 */
import { type Derived, type FormatOpts, barCells, format, fractionOfPct } from "../derive.ts"
import { GLYPHS, type GlyphName, displayWidth } from "../glyphs.ts"
import { Box, type Color, type InkNode, Spacer, Text } from "../ink/index.ts"
import { GAP, PAIR, PAIR_MIN_WIDTH } from "../layout.ts"
import type { PanelId as FeedPanelId, Provenance } from "../liveFeed.ts"
import type { Part, State } from "../scenario.ts"
import { TX, type TextLook } from "../theme.ts"

export type Align = "left" | "right"

/** `text` padded (or cut) to `width` display columns. */
export const padTo = (text: string, width: number | undefined, align: Align = "left"): string => {
  if (width === undefined) return text
  let out = ""
  let w = 0
  for (const ch of text) {
    const cw = displayWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  const fill = " ".repeat(Math.max(0, width - w))
  return align === "left" ? out + fill : fill + out
}

interface LookProps {
  readonly color?: Color | undefined
  readonly bold?: boolean | undefined
  readonly dimColor?: boolean | undefined
}

export interface NumProps extends LookProps {
  readonly d: Derived
  readonly digits?: number | undefined
  readonly bare?: boolean | undefined
  readonly width?: number
  readonly align?: Align
  /** Text before/after the figure (no digits). */
  readonly prefix?: string
  readonly suffix?: string
}

/** A derived figure, formatted with its unit. */
export const Num = (p: NumProps) => {
  const opts: FormatOpts = { ...(p.digits === undefined ? {} : { digits: p.digits }), ...(p.bare === undefined ? {} : { bare: p.bare }) }
  return (
    <Text color={p.color} bold={p.bold} dimColor={p.dimColor}>
      {padTo(`${p.prefix ?? ""}${format(p.d, opts)}${p.suffix ?? ""}`, p.width, p.align ?? "left")}
    </Text>
  )
}

export interface RefProps extends LookProps {
  readonly children: string
  readonly width?: number
  readonly align?: Align
}

/** An identifier or label that may contain digits (not a quantity). */
export const Ref = (p: RefProps) => (
  <Text color={p.color} bold={p.bold} dimColor={p.dimColor}>
    {padTo(p.children, p.width, p.align ?? "left")}
  </Text>
)

/** A glyph of the closed set (G1 in `glyphs.ts`). */
export const Glyph = (p: LookProps & { readonly name: GlyphName }) => (
  <Text color={p.color} bold={p.bold} dimColor={p.dimColor}>
    {GLYPHS[p.name].char}
  </Text>
)

/** Plain text padded to a width (no digits allowed: use `Num`/`Ref`). */
export const Cell = (p: LookProps & { readonly children: string; readonly width?: number; readonly align?: Align }) => (
  <Text color={p.color} bold={p.bold} dimColor={p.dimColor}>
    {padTo(p.children, p.width, p.align ?? "left")}
  </Text>
)

/** A bar of `width` cells filled to `fraction` (clamped to [0, 1], NaN → empty). */
export const Bar = (p: { readonly fraction: number; readonly width: number; readonly on: TextLook; readonly off?: TextLook }) => {
  const n = barCells(p.fraction, p.width)
  return (
    <Text>
      <Text {...p.on}>{GLYPHS.barOn.char.repeat(n)}</Text>
      <Text {...(p.off ?? TX.meta)}>{GLYPHS.barOff.char.repeat(Math.max(0, p.width - n))}</Text>
    </Text>
  )
}

/**
 * The brief's `PhaseBar`, fixed: the filled length is clamped to
 * [0, width] (the brief's `'█'.repeat(filled)` throws for pct > 100 and
 * draws nothing sensible for NaN), and the percentage is a derived figure.
 */
export const PhaseBar = (p: { readonly label: string; readonly labelWidth: number; readonly pct: Derived; readonly width: number; readonly color: Color }) => (
  <Box>
    <Cell {...TX.label} width={p.labelWidth}>
      {p.label}
    </Cell>
    <Bar fraction={fractionOfPct(p.pct)} width={p.width} on={{ color: p.color }} />
    <Text> </Text>
    <Num d={p.pct} {...TX.value} />
  </Box>
)

/** A bordered panel with its title (and key binding) on the first row. */
export const Panel = (p: {
  readonly title: InkNode
  readonly keyLabel?: string
  readonly color: Color
  readonly focused: boolean
  readonly width: number
  readonly children?: InkNode
}) => (
  <Box flexDirection="column" width={p.width} borderStyle={p.focused ? "bold" : "single"} borderColor={p.color} borderDimColor={!p.focused} paddingX={1}>
    <Box>
      <Text color={p.color} bold>
        {p.title}
      </Text>
      <Spacer />
      {p.keyLabel === undefined ? null : <Ref {...TX.meta}>{`[${p.keyLabel}]`}</Ref>}
    </Box>
    {p.children}
  </Box>
)

/** Event/detail parts (`scenario.ts`) as text: words, figures and references. */
export const Parts = (p: LookProps & { readonly parts: ReadonlyArray<Part>; readonly refLook?: TextLook }) => (
  <Text color={p.color} bold={p.bold} dimColor={p.dimColor}>
    {p.parts.map((x) => (typeof x === "string" ? x : "fig" in x ? <Num d={x.fig} digits={x.opts?.digits} bare={x.opts?.bare} /> : <Ref {...(p.refLook ?? {})}>{x.ref}</Ref>))}
  </Text>
)

/** Two panels side by side if there is room, otherwise one above the other. `left`/`right` get their width. */
export const Pair = (p: { readonly width: number; readonly left: (w: number) => InkNode; readonly right: (w: number) => InkNode }) => {
  if (p.width < PAIR_MIN_WIDTH) {
    return (
      <Box flexDirection="column" width={p.width}>
        {p.left(p.width)}
        {p.right(p.width)}
      </Box>
    )
  }
  const lw = Math.floor((p.width - GAP) / PAIR)
  return (
    <Box width={p.width} gap={GAP}>
      {p.left(lw)}
      {p.right(p.width - GAP - lw)}
    </Box>
  )
}

/** Provenance tag of a panel title: `[LIVE]` green, `[MEASURED]` blue, `[DEMO]` yellow. */
export const ProvTag = (p: { readonly prov: Provenance }) => (
  <Text {...(p.prov === "LIVE" ? TX.okB : p.prov === "MEASURED" ? TX.info : TX.warnB)}>{` [${p.prov}]`}</Text>
)

/** `title` with the panel's provenance tag when the state carries a live feed; plain otherwise. */
export const taggedTitle = (title: string, state: State, id: FeedPanelId): InkNode =>
  state.feed === undefined ? (
    title
  ) : (
    <Text>
      {title}
      <ProvTag prov={state.feed.provenance[id]} />
    </Text>
  )
