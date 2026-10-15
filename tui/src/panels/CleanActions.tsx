/**
 * The clean run's SIMULATED ACTIONS strip: the R2 and Artifacts requests the
 * steps shown so far would make, newest at the bottom. It sits under the
 * focused panel in every view of the clean scenario (when the terminal has
 * room for it, `cleanStripRows`) and is exactly `rows` rows high.
 */
import { cleanActions } from "../clean/actions.ts"
import type { CleanEvent } from "../clean/figures.ts"
import { CW, PANEL_CHROME_ROWS } from "../clean/layout.ts"
import { count } from "../derive.ts"
import { Box, Text } from "../ink/index.ts"
import { ACTIONS as AW } from "../layout.ts"
import { C, TX } from "../theme.ts"
import { Cell, Num, Panel, Parts, Ref } from "./common.tsx"

export const CleanActionsStrip = (p: { readonly events: ReadonlyArray<CleanEvent>; readonly width: number; readonly rows: number }) => {
  const actions = cleanActions(p.events)
  const content = Math.max(0, p.rows - PANEL_CHROME_ROWS)
  const last = actions.slice(Math.max(0, actions.length - content))
  const r2 = count(actions.filter((a) => a.channel === "R2").length, "ops", "R2 requests so far")
  const art = count(actions.filter((a) => a.channel === "ARTIFACTS").length, "ops", "Artifacts requests so far")
  return (
    <Panel
      title={
        <Text>
          SIMULATED ACTIONS <Text {...TX.meta}>R2 and Artifacts requests of the steps shown (illustrative, no network)</Text>
          <Text {...TX.label}>{"  R2: "}</Text>
          <Num d={r2} {...TX.info} />
          <Text {...TX.label}>{"  Artifacts: "}</Text>
          <Num d={art} {...TX.brand} />
        </Text>
      }
      color={C.magenta}
      focused={false}
      width={p.width}
    >
      {last.length === 0 ? <Text {...TX.label}>No request yet: open a panel (keys 1-6).</Text> : null}
      {last.map((a) => (
        <Box>
          <Num d={a.at} prefix="at " width={CW.actionClock} {...TX.meta} />
          <Cell {...(a.channel === "R2" ? TX.info : TX.brand)} width={AW.channel}>
            {a.channel}
          </Cell>
          <Cell {...TX.okB} width={AW.longVerb}>
            {a.verb}
          </Cell>
          <Ref {...TX.lock}>{a.target}</Ref>
          <Text> </Text>
          <Parts parts={a.detail} {...TX.value} />
        </Box>
      ))}
      {Array.from({ length: Math.max(0, content - Math.max(1, last.length)) }, () => (
        <Text> </Text>
      ))}
    </Panel>
  )
}
