/**
 * The permanent SIMULATED ACTIONS strip: what the run is doing against
 * Cloudflare right now, drawn in every view of the dashboard (panels,
 * overview, charts, overlays) between the body and the footer.
 *
 * - Left: the action log, newest at the bottom: R2 PUT/GET/HEAD on lock,
 *   blob and manifest keys, and Artifacts FORK/TOKEN/PUSH/PR/MERGE.
 * - Right (when the width allows): the Artifacts task of every fork with
 *   its progress, and the R2 blob upload/download with theirs.
 *
 * The strip is exactly `rows` rows high (borders included).
 */
import { ACTIONS, progressPct, type SimAction, type Task, type Transfer } from "../actions.ts"
import { count, type Derived } from "../derive.ts"
import { Box, Text } from "../ink/index.ts"
import { ACTIONS as AW, FRESH_S, W } from "../layout.ts"
import type { Decision, State } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { Bar, Cell, Glyph, Num, Panel, Parts, Ref } from "./common.tsx"

export interface ActionsPanelProps {
  readonly state: State
  readonly width: number
  /** Rows of the strip, borders included. */
  readonly rows: number
  readonly clock: (t: number) => Derived
}

/** The review decision recorded in the state's event stream. */
export const decisionOf = (st: State): Decision => {
  const e = st.events.find((x) => x.kind === "MERGE" || x.kind === "REJECT")
  return e === undefined ? null : { kind: e.kind === "MERGE" ? "approve" : "reject", at: e.t }
}

const STATUS_LOOK: Readonly<Record<SimAction["status"], TextLook>> = { ok: TX.okB, miss: TX.warnB, fail: TX.badB, pending: TX.warnB }

const channelLook = (c: SimAction["channel"]): TextLook => (c === "R2" ? TX.info : TX.brand)

const ActionLine = (p: { readonly a: SimAction; readonly clock: (t: number) => Derived; readonly fresh: boolean }) => (
  <Box>
    <Num d={p.clock(p.a.t)} width={W.clock} {...TX.meta} />
    <Cell {...channelLook(p.a.channel)} width={AW.channel}>
      {p.a.channel}
    </Cell>
    <Cell {...STATUS_LOOK[p.a.status]} width={AW.verb}>
      {p.a.verb}
    </Cell>
    <Ref {...TX.label} width={AW.agent}>
      {p.a.agent}
    </Ref>
    <Ref {...TX.lock}>{p.a.target}</Ref>
    <Text> </Text>
    <Parts parts={p.a.detail} {...(p.a.status === "fail" ? TX.bad : p.fresh ? TX.strong : TX.value)} />
  </Box>
)

const TASK_LOOK: Readonly<Record<Task["status"], TextLook>> = {
  FORKING: TX.warn,
  WAITING: TX.info,
  RUNNING: TX.warnB,
  PUSHED: TX.ok,
  CRASHED: TX.badB,
  "PR OPEN": TX.warnB,
  MERGED: TX.okB,
  REJECTED: TX.bad
}

const TaskLine = (p: { readonly task: Task }) => (
  <Box>
    <Cell {...TX.brand} width={AW.verb}>
      ART
    </Cell>
    <Ref {...TX.lock} width={AW.fork}>
      {p.task.fork}
    </Ref>
    <Bar fraction={p.task.progress} width={AW.bar} on={p.task.status === "CRASHED" || p.task.status === "REJECTED" ? TX.bad : p.task.status === "MERGED" || p.task.status === "PUSHED" ? TX.ok : TX.warn} />
    <Text> </Text>
    <Num d={progressPct(p.task.progress)} digits={0} width={AW.pct} {...TX.value} />
    <Cell {...TASK_LOOK[p.task.status]} width={AW.status}>
      {p.task.status}
    </Cell>
    <Ref {...TX.label}>{p.task.branch}</Ref>
  </Box>
)

const TransferLine = (p: { readonly x: Transfer; readonly t: number }) => {
  const f = ACTIONS.transferProgress(p.x, p.t)
  return (
    <Box>
      <Cell {...TX.info} width={AW.longVerb}>
        {p.x.dir === "up" ? "R2 PUT" : "R2 GET"}
      </Cell>
      <Glyph name={p.x.dir === "up" ? "up" : "down"} {...(f >= 1 ? TX.ok : f > 0 ? TX.warnB : TX.label)} />
      <Text> </Text>
      <Cell {...TX.label} width={AW.fork}>
        {p.x.dir === "up" ? "upload" : "download"}
      </Cell>
      <Bar fraction={f} width={AW.bar} on={f >= 1 ? TX.ok : TX.warn} />
      <Text> </Text>
      <Num d={progressPct(f)} digits={0} width={AW.pct} {...TX.value} />
      <Num d={p.x.blobs} {...TX.label} />
      <Text {...TX.label}>, </Text>
      <Num d={p.x.size} {...TX.label} />
    </Box>
  )
}

/** Both transfers on one row (when the column has no room for one row each). */
const TransfersLine = (p: { readonly xs: ReadonlyArray<Transfer>; readonly t: number }) => (
  <Box>
    <Cell {...TX.info} width={AW.verb}>
      R2
    </Cell>
    {p.xs.map((x) => {
      const f = ACTIONS.transferProgress(x, p.t)
      return (
        <Text>
          <Glyph name={x.dir === "up" ? "up" : "down"} {...(f >= 1 ? TX.ok : f > 0 ? TX.warnB : TX.label)} />
          <Text {...TX.label}>{x.dir === "up" ? " upload " : " download "}</Text>
          <Bar fraction={f} width={AW.pct} on={f >= 1 ? TX.ok : TX.warn} />
          <Text> </Text>
          <Num d={progressPct(f)} digits={0} width={AW.pct} {...TX.value} />
        </Text>
      )
    })}
  </Box>
)

/** The latest fork of each agent (the one its task runs on). */
const latestPerAgent = (tasks: ReadonlyArray<Task>): Task[] => {
  const out: Task[] = []
  for (const task of tasks) {
    const i = out.findIndex((x) => x.agent === task.agent)
    if (i >= 0) out[i] = task
    else out.push(task)
  }
  return out
}

const pad = (n: number) => Array.from({ length: Math.max(0, n) }, () => <Text> </Text>)

export const ActionsPanel = (p: ActionsPanelProps) => {
  const st = p.state
  const content = Math.max(0, p.rows - AW.chrome)
  const actions = ACTIONS.actionsAt(st.t, decisionOf(st))
  const tasks = ACTIONS.tasksAt(st)
  const r2 = count(actions.filter((a) => a.channel === "R2").length, "ops", "R2 requests so far")
  const art = count(actions.filter((a) => a.channel === "ARTIFACTS").length, "ops", "Artifacts requests so far")
  const inner = Math.max(1, p.width - AW.inset)
  const split = inner >= AW.splitMin
  const right = split ? Math.floor(inner * AW.taskShare) : 0
  const left = split ? inner - right - AW.gap : inner
  const log = actions.slice(Math.max(0, actions.length - content))
  const transfers = ACTIONS.transfers
  const roomForAll = content >= tasks.length + transfers.length
  const shownTasks = roomForAll ? tasks : latestPerAgent(tasks).slice(0, Math.max(0, content - (transfers.length > 0 ? 1 : 0)))
  const rightRows = [
    ...shownTasks.map((task) => <TaskLine task={task} />),
    ...(transfers.length === 0 ? [] : roomForAll ? transfers.map((x) => <TransferLine x={x} t={st.t} />) : [<TransfersLine xs={transfers} t={st.t} />])
  ].slice(0, content)
  const title = (
    <Text>
      SIMULATED ACTIONS <Text {...TX.meta}>R2 uploads/downloads and Artifacts tasks (illustrative, no network)</Text>
      <Text {...TX.label}>{"  R2: "}</Text>
      <Num d={r2} {...TX.info} />
      <Text {...TX.label}>{"  Artifacts: "}</Text>
      <Num d={art} {...TX.brand} />
    </Text>
  )
  const logColumn = (
    <Box flexDirection="column" width={left}>
      {log.length === 0 ? <Text {...TX.label}>{st.triggered ? "No action yet." : "No action yet. Press SPACE to trigger a cobuild."}</Text> : log.map((a) => <ActionLine a={a} clock={p.clock} fresh={st.t - a.t < FRESH_S} />)}
      {pad(content - Math.max(1, log.length))}
    </Box>
  )
  return (
    <Panel title={title} color={C.magenta} focused={false} width={p.width}>
      {content === 0 ? null : split ? (
        <Box gap={AW.gap}>
          {logColumn}
          <Box flexDirection="column" width={right}>
            {rightRows.length === 0 ? <Text {...TX.label}>No Artifacts fork yet.</Text> : rightRows}
            {pad(content - Math.max(1, rightRows.length))}
          </Box>
        </Box>
      ) : (
        logColumn
      )}
    </Panel>
  )
}
