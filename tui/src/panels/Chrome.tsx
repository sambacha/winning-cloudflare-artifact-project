/** Header (logo, title, status bar) and footer (review prompt, controls, hints). */
import { GLYPHS } from "../glyphs.ts"
import { count, type Derived, latencyAt } from "../derive.ts"
import type { Inputs } from "../data.ts"
import { Box, Spacer, Text } from "../ink/index.ts"
import { logoRows } from "../logo.ts"
import type { State } from "../scenario.ts"
import { C, TX } from "../theme.ts"
import { Glyph, Num, Ref } from "./common.tsx"
import { blink } from "./props.ts"
import { RULE_MAX } from "../layout.ts"

export interface HeaderProps {
  readonly state: State
  readonly inputs: Inputs
  readonly clock: (t: number) => Derived
  readonly constants: Derived
  readonly seed: number
  readonly tick: number
  readonly anim: boolean
  readonly compact: boolean
  readonly logo: boolean
  readonly width: number
}

const Sep = () => <Text {...TX.label}> │ </Text>

export const Header = (p: HeaderProps) => {
  const st = p.state
  const on = blink(p)
  const live = st.triggered ? <Glyph name={on ? "live" : "liveOff"} {...(on ? TX.okB : TX.ok)} /> : <Glyph name="liveOff" {...TX.label} />
  // With a live feed the header row stays scripted, so it must not claim to be live: the panels carry the tags.
  const mixed = st.feed !== undefined
  const liveLabel = (
    <Text {...(st.triggered ? TX.okB : TX.label)}>{mixed ? (st.triggered ? " SCRIPT RUNNING" : " SCRIPT IDLE") : st.triggered ? " LIVE" : " IDLE"}</Text>
  )
  const active = count(st.agents.filter((a) => a.status !== "IDLE").length, "agents", "agents not IDLE")
  const held = count(st.locks.filter((l) => l.state !== "FREE").length, "ops", "locks not FREE")
  const ops = count(st.locks.length, "ops", "operations in the run")
  const clock = st.triggered ? <Num d={p.clock(st.t)} {...TX.value} /> : <Text {...TX.warnB}>press SPACE</Text>
  const tag = <Text {...{ color: C.yellow, dimColor: true }}>{mixed ? "MIXED DATA: see the [LIVE]/[MEASURED]/[DEMO] panel tags" : "ILLUSTRATIVE DATA"}</Text>
  if (p.compact) {
    return (
      <Box width={p.width}>
        <Ref {...TX.h1}>{p.inputs.project.name}</Ref>
        <Sep />
        {live}
        {liveLabel}
        <Sep />
        {clock}
        <Sep />
        {tag}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={p.width}>
      {p.logo
        ? logoRows(p.inputs.project.name).map((r) => (
            <Text {...TX.h1}>
              {"  "}
              {r}
            </Text>
          ))
        : null}
      <Box>
        <Text>{"  "}</Text>
        <Ref {...TX.h1}>{p.inputs.project.name}</Ref>
        <Sep />
        <Ref {...TX.value}>{p.inputs.project.lean}</Ref>
        <Sep />
        <Ref {...TX.brand}>{p.inputs.project.tagline}</Ref>
        <Spacer />
        {tag}
        <Text>{"  "}</Text>
      </Box>
      <Text {...TX.meta}>{`  ${"─".repeat(Math.max(0, p.width - "    ".length))}`}</Text>
      <Box>
        <Text>{"  "}</Text>
        {live}
        {liveLabel}
        <Sep />
        <Num d={latencyAt(p.inputs, p.seed, st.t)} digits={0} suffix=" latency" {...TX.label} />
        <Sep />
        <Num d={active} {...TX.value} />
        <Sep />
        <Num d={held} bare {...TX.value} />
        <Text {...TX.value}>/</Text>
        <Num d={ops} {...TX.value} />
        <Sep />
        <Ref {...TX.label}>{p.inputs.project.mathlib}</Ref>
        <Sep />
        <Num d={p.constants} {...TX.label} />
        <Sep />
        {clock}
        <Sep />
        <Ref {...TX.meta}>{`seed ${p.seed}`}</Ref>
      </Box>
    </Box>
  )
}

export interface FooterProps {
  readonly state: State
  readonly tick: number
  readonly anim: boolean
  readonly compact: boolean
  readonly width: number
  /** Panels that did not fit (shown as "+N panels (press 1-5, e, u)"). */
  readonly hidden: Derived | null
  /** Visible body lines, for the scroll indicator (null: everything fits). */
  readonly scroll: { readonly from: Derived; readonly to: Derived; readonly total: Derived } | null
  /** The charts view is open: the controls line lists its keys. */
  readonly charts?: boolean
}

const K = (p: { readonly k: string; readonly rest: string }) => (
  <Text>
    <Ref {...TX.brand}>{p.k}</Ref>
    <Text {...TX.label}>{p.rest}</Text>
  </Text>
)

export const Footer = (p: FooterProps) => {
  const on = blink(p)
  const review = p.state.awaitingReview ? (
    <Text>
      <Text color={C.black} backgroundColor={C.yellow} bold>
        {" "}
        <Glyph name={on ? "play" : "playOff"} /> REVIEW{" "}
      </Text>
      <Text {...TX.warnB}> PR to trunk: [a]pprove [r]eject </Text>
    </Text>
  ) : null
  const hint =
    p.hidden === null || p.hidden.value === 0 ? null : (
      <Text {...TX.warnB}>
        {" "}
        <Num d={p.hidden} prefix="+" />
        <Ref>{" (press 1-5, e, u)"}</Ref>
      </Text>
    )
  const info =
    p.scroll === null ? null : (
      <Text {...TX.meta}>
        {"lines "}
        <Num d={p.scroll.from} bare />
        {"-"}
        <Num d={p.scroll.to} bare />
        {"/"}
        <Num d={p.scroll.total} bare />{" "}
      </Text>
    )
  if (p.compact) {
    return (
      <Box width={p.width}>
        {hint}
        <Text> </Text>
        {review}
        {review === null ? <K k="[SPACE]" rest=" run " /> : null}
        <K k="[c]" rest={p.charts === true ? "lose charts " : "harts "} />
        <K k="[o]" rest="verview " />
        <K k="[h]" rest="elp " />
        <K k="[q]" rest="uit" />
        <Spacer />
        {info}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={p.width}>
      <Box>
        <Text {...TX.h1}>── CONTROLS </Text>
        {hint}
        {hint === null ? null : <Text> </Text>}
        <Rule />
        {info === null ? null : <Text> </Text>}
        {info}
      </Box>
      {p.charts === true ? (
        <Box>
          {review}
          <K k={` [1-6 ${GLYPHS.left.char} ${GLYPHS.arrow.char} Tab]`} rest=" select chart │ " />
          <K k="[z]" rest="oom │ " />
          <K k="[ ] { }" rest=" scrub time │ " />
          <K k="[p]" rest="lay/pause │ " />
          <K k="[c]" rest=" close │ " />
          <K k="[j/k]" rest=" scroll │ " />
          <K k="[q]" rest="uit" />
        </Box>
      ) : (
        <Box>
          {review}
          {review === null ? <K k=" [SPACE]" rest=" trigger │ " /> : null}
          <K k="[o]" rest="verview │ " />
          <K k="[1-5 e u]" rest=" panels │ " />
          <K k="[c]" rest="harts │ " />
          <K k="[a/r]" rest=" approve/reject │ " />
          <K k="[w]" rest=" git │ " />
          <K k="[n]" rest="otes │ " />
          <K k="[h]" rest="elp │ " />
          <K k="[j/k]" rest=" scroll │ " />
          <K k="[q]" rest="uit" />
        </Box>
      )}
    </Box>
  )
}

/** A horizontal rule that fills the free space of a row. */
const Rule = () => (
  <Box flexGrow={1}>
    <Text {...TX.meta}>{"─".repeat(RULE_MAX)}</Text>
  </Box>
)
