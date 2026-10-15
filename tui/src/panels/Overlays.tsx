/** Overlays: git view of the forks, data notes (brief vs derived), help. */
import { GLYPHS } from "../glyphs.ts"
import type { DataNote } from "../derive.ts"
import { Box, Text } from "../ink/index.ts"
import { W } from "../layout.ts"
import type { State } from "../scenario.ts"
import { C, TX } from "../theme.ts"
import { Cell, Glyph, Num, Panel, Ref } from "./common.tsx"

export const GitOverlay = (p: { readonly state: State; readonly width: number }) => {
  const merged = p.state.forks.find((f) => f.merged)
  const committed = p.state.forks.filter((f) => f.commit !== null)
  return (
    <Panel title="GIT: agent forks" color={C.cyan} focused width={p.width}>
      <Text {...TX.meta}>git log --graph --oneline --all (scripted forks; nothing is fetched)</Text>
      <Text> </Text>
      {merged === undefined ? null : (
        <Text>
          <Text {...TX.ok}>* </Text>
          <Text {...TX.okB}>trunk </Text>
          <Text {...TX.value}>fast-forward to </Text>
          <Ref {...TX.lock}>{`fork/${merged.fork}`}</Ref>
        </Text>
      )}
      {committed.map((f) => (
        <Text>
          <Text {...TX.brand}>| * </Text>
          <Ref {...TX.lock}>{`fork/${f.fork} `}</Ref>
          <Ref {...TX.warn}>{`(${f.branch}) `}</Ref>
          <Ref {...TX.value}>{`${f.agent}: ${f.commit}`}</Ref>
        </Text>
      ))}
      {p.state.forks
        .filter((f) => f.commit === null)
        .map((f) => (
          <Text>
            <Text {...TX.brand}>| o </Text>
            <Ref {...TX.lock}>{`fork/${f.fork} `}</Ref>
            <Ref {...TX.warn}>{`(${f.branch}) `}</Ref>
            <Text {...TX.label}>work in progress</Text>
          </Text>
        ))}
      <Text {...TX.brand}>|/</Text>
      <Text>
        <Text {...TX.label}>* trunk </Text>
        <Text {...TX.meta}>base of all forks</Text>
      </Text>
      {p.state.forks.length === 0 ? <Text {...TX.label}>(no forks yet: press SPACE)</Text> : null}
    </Panel>
  )
}

const VERDICT_LOOK = { agrees: TX.ok, differs: TX.bad, "not derivable": TX.warn, "different quantity": TX.info } as const

export const NotesOverlay = (p: { readonly notes: ReadonlyArray<DataNote>; readonly width: number }) => (
  <Panel title="DATA NOTES: the brief's figures against the derived ones" color={C.cyan} focused width={p.width}>
    <Text {...TX.label}>The panels show only derived figures. The brief's own figures are listed here with the decision taken.</Text>
    <Text> </Text>
    <Box>
      <Cell color={C.gray} bold width={W.noteFigure}>
        Figure
      </Cell>
      <Cell color={C.gray} bold width={W.noteValue}>
        Brief
      </Cell>
      <Cell color={C.gray} bold width={W.noteValue}>
        Derived
      </Cell>
      <Cell color={C.gray} bold width={W.noteVerdict}>
        Verdict
      </Cell>
      <Cell color={C.gray} bold>
        Decision
      </Cell>
    </Box>
    {p.notes.map((n) => (
      <Box>
        <Ref {...TX.value} width={W.noteFigure}>
          {n.figure}
        </Ref>
        {"ref" in n.stated ? (
          <Ref {...TX.label} width={W.noteValue}>
            {n.stated.ref}
          </Ref>
        ) : (
          <Num d={n.stated} width={W.noteValue} {...TX.label} />
        )}
        {n.derived === null ? (
          <Cell {...TX.label} width={W.noteValue}>
            —
          </Cell>
        ) : (
          <Num d={n.derived} width={W.noteValue} {...TX.value} />
        )}
        <Text {...VERDICT_LOOK[n.verdict]}>
          <Glyph name={n.verdict === "agrees" ? "ok" : "bad"} />
          <Cell width={W.noteVerdict - 1}>{` ${n.verdict}`}</Cell>
        </Text>
        <Text {...TX.meta}>{n.decision}</Text>
      </Box>
    ))}
  </Panel>
)

const HELP: ReadonlyArray<readonly [string, string]> = [
  ["SPACE", "trigger a cobuild (restarts the scripted run)"],
  ["o", "toggle the overview: every panel as a compact tile on one screen"],
  ["1-5, e, u", "focus and show a panel: 1 forks, 2 locks, 3 cache, 4 Lean metrics, 5 cost, e events, u Cloudflare URIs"],
  ["a / r", "approve / reject the PR while the review gate is open"],
  ["c", "toggle the charts view: lease timeline, cost, progress, activity, monthly cost, audit algorithms"],
  [`1-6 ${GLYPHS.left.char} ${GLYPHS.arrow.char} Tab (charts)`, "select a chart; z or Enter zooms it, Esc or c closes the charts"],
  ["[ ] { }", "scrub the script time by 1 s / 5 s (pauses; p or SPACE resumes)"],
  ["w", "toggle the git view of the forks"],
  ["n", "toggle the data notes (the brief's figures against the derived ones)"],
  ["j k ↑ ↓ PgUp PgDn g G", "scroll"],
  ["+ / - / p", "faster / slower / pause"],
  ["h ?", "toggle this help"],
  ["q, Ctrl-C", "quit (the terminal is restored)"]
]

export const HelpOverlay = (p: { readonly width: number }) => (
  <Panel title="HELP" color={C.cyan} focused width={p.width}>
    {HELP.map(([k, v]) => (
      <Box>
        <Ref {...TX.brand} width={W.helpKey}>
          {k}
        </Ref>
        <Ref {...TX.value}>{v}</Ref>
      </Box>
    ))}
    <Text> </Text>
    <Text {...TX.warn}>A demonstration with illustrative data. It is not connected to R2, Workers, Artifacts, GitHub or Lean.</Text>
    <Text {...TX.meta}>The SIMULATED ACTIONS strip lists the R2 and Artifacts requests the run would make; none is sent.</Text>
    <Text {...TX.meta}>Options: --seed N, --no-anim, --ascii, --no-color (also NO_COLOR, TERM=dumb, CI).</Text>
  </Panel>
)
