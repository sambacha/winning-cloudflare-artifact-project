/** Panel 1: Artifacts agent forks (one card per agent). */
import { tokenFigure } from "../derive.ts"
import type { GlyphName } from "../glyphs.ts"
import { Box, type InkNode, Text } from "../ink/index.ts"
import { URGENT_S, W } from "../layout.ts"
import type { Agent } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import type { LiveArtifacts } from "../liveFeed.ts"
import { Cell, Glyph, Num, Panel, Parts, Ref, taggedTitle } from "./common.tsx"
import { blink, type PanelProps } from "./props.ts"

/** Glyph, label and look of an agent status; `on` is the blink phase (always true without animation). */
export const statusLook = (a: Agent, on: boolean): { readonly glyph: GlyphName; readonly label: string; readonly look: TextLook } => {
  switch (a.status) {
    case "IDLE":
      return { glyph: "ring", label: "IDLE", look: TX.label }
    case "SPAWNING":
      return { glyph: on ? "dot" : "ring", label: "SPAWNING", look: TX.warn }
    case "BUILDING":
      return { glyph: "dot", label: "BUILDING", look: TX.warnB }
    case "WAITING":
      return { glyph: "wait", label: "WAITING", look: TX.info }
    case "CRASHED":
      return { glyph: "bad", label: "CRASHED", look: TX.badB }
    case "REVIEW":
      return { glyph: on ? "play" : "playOff", label: "REVIEW", look: TX.warnB }
    case "MERGED":
      return { glyph: "ok", label: "DONE, MERGED", look: TX.okB }
    case "REJECTED":
      return { glyph: "bad", label: "REJECTED", look: TX.bad }
    case "DONE":
      return { glyph: "ok", label: "DONE", look: TX.ok }
  }
}

const Field = (p: { readonly label: string; readonly first?: boolean; readonly children?: InkNode }) => (
  <Box>
    <Cell {...TX.label} width={W.field}>
      {`${p.first === true ? "├─" : "│ "} ${p.label}`}
    </Cell>
    <Text>{p.children}</Text>
  </Box>
)

const AgentCard = (p: { readonly a: Agent; readonly blinkOn: boolean }) => {
  const a = p.a
  const st = statusLook(a, p.blinkOn)
  const token = a.tokenLeft === null ? null : tokenFigure(a.tokenLeft)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Glyph name={a.status === "IDLE" ? "ring" : "dot"} {...(a.status === "IDLE" ? TX.label : TX.brand)} />
        <Text> </Text>
        <Ref color={C.white} bold>
          {a.id}
        </Ref>
      </Box>
      <Field label="fork:" first>
        {a.fork === null ? <Glyph name="dash" {...TX.label} /> : <Ref {...TX.lock}>{a.fork}</Ref>}
      </Field>
      <Field label="status:">
        <Glyph name={st.glyph} {...st.look} />
        <Text {...st.look}> {st.label}</Text>
        {a.detail.length === 0 ? null : (
          <Text {...TX.meta}>
            {"  "}
            <Parts parts={a.detail} />
          </Text>
        )}
      </Field>
      <Field label="token:">
        {token === null ? (
          <Glyph name="dash" {...TX.label} />
        ) : token.value === 0 ? (
          <Text {...TX.label}>revoked or expired</Text>
        ) : (
          <Num d={token} digits={0} prefix="TTL " {...(token.value < URGENT_S ? TX.badB : TX.value)} />
        )}
      </Field>
      <Field label="branch:">
        <Ref {...TX.value}>{a.branch}</Ref>
      </Field>
      <Field label="commit:">{a.commit === null ? <Text {...TX.label}>(in progress)</Text> : <Ref {...TX.value}>{`"${a.commit}"`}</Ref>}</Field>
      <Field label="diff:">
        {a.diff === null ? (
          <Glyph name="dash" {...TX.label} />
        ) : (
          <Text {...TX.ok}>
            <Num d={a.diff.added} prefix="+" bare />
            <Text> </Text>
            <Num d={a.diff.removed} prefix="-" bare />
            <Text> in </Text>
            <Num d={a.diff.files} />
          </Text>
        )}
      </Field>
      <Field label="set:">
        <Ref {...TX.value}>{a.set}</Ref>
      </Field>
      {a.audited === null ? null : (
        <Field label="lean:">
          <Num d={a.audited} {...TX.value} />
          <Text {...TX.label}> audited</Text>
        </Field>
      )}
    </Box>
  )
}

/** The run's real Artifacts repository (`GET /api/artifacts`): remote and newest commits. */
export const LiveRepo = (p: { readonly a: LiveArtifacts }) => {
  const head = p.a.commits[0]
  return (
    <Box flexDirection="column">
      <Text>
        <Text {...TX.label}>{"Repo:   "}</Text>
        <Ref {...TX.value}>{p.a.repo}</Ref>
        <Text {...TX.label}>{"  ref "}</Text>
        <Ref {...TX.value}>{p.a.ref}</Ref>
      </Text>
      <Text>
        <Text {...TX.label}>{"Remote: "}</Text>
        <Ref {...TX.brand}>{p.a.remote}</Ref>
      </Text>
      {head === undefined ? (
        <Text {...TX.warn}>No commits yet: push one with `cobuild artifacts publish`.</Text>
      ) : (
        <Text>
          <Text {...TX.label}>{"Last commit: "}</Text>
          <Ref {...TX.ok}>{head.oid.slice(0, W.liveOid)}</Ref>
          <Text>{" "}</Text>
          <Ref {...TX.value}>{head.message ?? ""}</Ref>
        </Text>
      )}
      <Text {...TX.meta}>Agent forks below are illustrative.</Text>
      <Text> </Text>
    </Box>
  )
}

export const ForksPanel = (p: PanelProps) => {
  const blinkOn = blink(p)
  return (
    <Panel
      title={
        p.state.feed !== undefined ? (
          taggedTitle("ARTIFACTS", p.state, "artifacts")
        ) : p.state.live === true ? (
          <Text>
            ARTIFACTS: Agent Forks <Text {...TX.warnB}>[DEMO: illustrative]</Text>
          </Text>
        ) : (
          "ARTIFACTS: Agent Forks"
        )
      }
      keyLabel="1"
      color={C.cyan}
      focused={p.focused}
      width={p.width}
    >
      {p.state.feed?.artifacts != null ? <LiveRepo a={p.state.feed.artifacts} /> : null}
      {p.state.agents.map((a) => (
        <AgentCard a={a} blinkOn={blinkOn} />
      ))}
    </Panel>
  )
}
