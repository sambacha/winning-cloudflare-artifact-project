/**
 * Panels of the clean build-pipeline scenario (`--scenario clean`):
 * Environment, Dependencies, Build, Bisect, Coordination and the event
 * stream, plus their header, footer and start screen.
 *
 * Status cells are plain ASCII words (OK, HIT, FAIL, ACTIVE, ...). The only
 * non-ASCII characters are the box-drawing borders and the block logo. Each
 * storyboard anchor (`tape/demo.tape`) is written exactly once in this file,
 * as one literal (`test/clean.test.ts` checks this).
 */
import { barCells } from "../derive.ts"
import { Box, type InkNode, Spacer, Text } from "../ink/index.ts"
import { GAP, PAIR } from "../layout.ts"
import { logoRows, LOGO_ROWS } from "../logo.ts"
import { type BisectStatus } from "../clean/bisectStatus.ts"
import { clockLabel, type ClockSource } from "../clean/clock.ts"
import {
  bisectFigures,
  buildFigures,
  cleanEvents,
  type CleanEvent,
  type CleanKind,
  dependencyFigures,
  DIGEST_SHOWN,
  environmentFigures,
  leaseFigures,
  leasePolicyFigures,
  shortDigest
} from "../clean/figures.ts"
import { BISECT, BUILD, DEPENDENCIES, ENVIRONMENT, RUNNER } from "../clean/fixture.ts"
import { CW, LOGO_ROW_MS, MS_PER_S } from "../clean/layout.ts"
import {
  bisectStep,
  buildPhase,
  CLEAN_PANELS,
  type CleanPanelId,
  type CleanState,
  coordinationPhase,
  depsPhase,
  reviewPhase,
  statusAt
} from "../clean/model.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { Cell, Num, Panel, Parts, Ref } from "./common.tsx"

export interface CleanPanelProps {
  readonly st: CleanState
  readonly statuses: ReadonlyArray<BisectStatus>
  /** Total width of the panel, borders included. */
  readonly width: number
}

/** A label and its value on one row. */
const KV = (p: { readonly label: string; readonly children?: InkNode }) => (
  <Box>
    <Cell {...TX.label} width={CW.label}>
      {p.label}
    </Cell>
    <Text {...TX.value}>{p.children}</Text>
  </Box>
)

/** Two KV cells side by side (stacked when the panel is narrow). */
const Row2 = (p: { readonly width: number; readonly left: InkNode; readonly right: InkNode }) => {
  const inner = p.width
  if (inner < CW.pairMin) {
    return (
      <Box flexDirection="column" width={inner}>
        {p.left}
        {p.right}
      </Box>
    )
  }
  const lw = Math.floor((inner - GAP) / PAIR)
  return (
    <Box width={inner} gap={GAP}>
      <Box width={lw}>{p.left}</Box>
      <Box width={inner - GAP - lw}>{p.right}</Box>
    </Box>
  )
}

/** Content width of a bordered panel with paddingX 1. */
const contentWidth = (width: number): number => width - PAIR - PAIR

/** An ASCII bar of `width` cells filled to `fraction`. */
const AsciiBar = (p: { readonly fraction: number; readonly width: number; readonly on: TextLook }) => {
  const n = barCells(p.fraction, p.width)
  return (
    <Text>
      <Text {...TX.meta}>[</Text>
      <Text {...p.on}>{"#".repeat(n)}</Text>
      <Text {...TX.meta}>{".".repeat(Math.max(0, p.width - n))}</Text>
      <Text {...TX.meta}>]</Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// Chrome

export const CleanHeader = (p: { readonly clock: ClockSource; readonly t: number; readonly width: number }) => (
  <Box width={p.width}>
    <Text> </Text>
    <Text {...TX.h1}>FAME-XGA READY</Text>
    <Text {...TX.meta}> | cobuilds: TypeScript build pipeline | </Text>
    <Text {...TX.warnB}>ILLUSTRATIVE DATA</Text>
    <Spacer />
    <Ref {...TX.value}>{clockLabel(p.clock, p.t)}</Ref>
    <Text> </Text>
  </Box>
)

export const CleanFooter = (p: { readonly focus: 0 | CleanPanelId; readonly width: number }) => (
  <Box width={p.width}>
    <Text {...TX.label}> keys: </Text>
    <Ref {...TX.brand}>[1-6]</Ref>
    <Text {...TX.label}> panels  </Text>
    <Ref {...TX.brand}>[7/c]</Ref>
    <Text {...TX.label}> charts  </Text>
    <Text {...TX.brand}>[a]</Text>
    <Text {...TX.label}> approve  </Text>
    <Text {...TX.brand}>[n]</Text>
    <Text {...TX.label}> git note  </Text>
    <Text {...TX.brand}>[q]</Text>
    <Text {...TX.label}> quit</Text>
    <Spacer />
    <Text {...TX.meta}>{p.focus === 0 ? "start" : CLEAN_PANELS.find((x) => x.id === p.focus)!.name}</Text>
    <Text> </Text>
  </Box>
)

/** Before the first panel key: the block logo, revealed row by row, and the panel list. */
export const CleanStart = (p: { readonly t: number; readonly width: number }) => {
  const shown = Math.min(LOGO_ROWS, Math.floor((Math.max(0, p.t) * MS_PER_S) / LOGO_ROW_MS) + 1)
  const rows = logoRows("FAME-XGA")
  return (
    <Box flexDirection="column" width={p.width} paddingX={1}>
      <Text> </Text>
      {rows.map((r, i) => (
        <Text {...TX.h1}>{i < shown ? r : ""}</Text>
      ))}
      <Text> </Text>
      <Text {...TX.value}>Cobuilds demo: a TypeScript workload, R2 dependency and build caches, Bayesian bisect, lease locks.</Text>
      <Text {...TX.label}>
        Press <Ref {...TX.brand}>1-7</Ref> to open a panel:
      </Text>
      {CLEAN_PANELS.map((x) => (
        <Text {...TX.label}>
          {"  "}
          <Ref {...TX.brand}>{String(x.id)}</Ref> {x.name}
        </Text>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Panel 1

export const EnvironmentPanel = (p: CleanPanelProps) => {
  const w = contentWidth(p.width)
  const f = environmentFigures()
  return (
    <Panel title="ENVIRONMENT STATUS" keyLabel="1" color={C.cyan} focused width={p.width}>
      <Row2 width={w} left={<KV label="namespace:">{ENVIRONMENT.namespace}</KV>} right={<KV label="jurisdiction:">{ENVIRONMENT.jurisdiction}</KV>} />
      <Row2
        width={w}
        left={<KV label="repo:">{ENVIRONMENT.repo}</KV>}
        right={
          <KV label="status:">
            <Text {...TX.okB}>{ENVIRONMENT.status}</Text>
          </KV>
        }
      />
      <Row2
        width={w}
        left={<KV label="branch:">{ENVIRONMENT.branch}</KV>}
        right={
          <KV label="commits:">
            <Num d={f.commits} {...TX.value} />
          </KV>
        }
      />
      <Row2
        width={w}
        left={
          <KV label="R2:">
            <Text {...TX.okB}>{ENVIRONMENT.r2}</Text>
          </KV>
        }
        right={<KV label="bucket:">{ENVIRONMENT.bucket}</KV>}
      />
      <Row2
        width={w}
        left={
          <KV label="runner:">
            <Ref>{`${RUNNER.platform}-${RUNNER.arch}`}</Ref>
          </KV>
        }
        right={
          <KV label="node abi:">
            <Ref>{RUNNER.abi}</Ref>
          </KV>
        }
      />
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Panel 2

export const DependenciesPanel = (p: CleanPanelProps) => {
  const w = contentWidth(p.width)
  const f = dependencyFigures()
  const phase = depsPhase(p.st)
  const hit = phase === "hit"
  return (
    <Panel title="DEPENDENCIES: NODE_MODULES CACHE" keyLabel="2" color={C.blue} focused width={p.width}>
      <Row2
        width={w}
        left={
          <KV label="lockfile:">
            <Ref>{shortDigest(DEPENDENCIES.lockfileSha256, DIGEST_SHOWN)}</Ref>
          </KV>
        }
        right={hit ? <Text {...TX.okB}>STATE: HIT</Text> : <Text {...TX.warnB}>STATE: RESTORING</Text>}
      />
      <Row2
        width={w}
        left={
          <KV label="size:">
            <Num d={f.size} digits={0} {...TX.value} />
          </KV>
        }
        right={
          <KV label="restore:">
            {hit ? <Num d={f.restore} {...TX.value} /> : <Text {...TX.warn}>downloading and verifying</Text>}
          </KV>
        }
      />
      <Row2
        width={w}
        left={
          <KV label="platform:">
            <Ref>{`${RUNNER.platform}-${RUNNER.arch}`}</Ref>
          </KV>
        }
        right={
          <KV label="abi:">
            <Ref>{RUNNER.abi}</Ref>
          </KV>
        }
      />
      <KV label="saved:">
        {hit ? (
          <Text>
            <Num d={f.saved} {...TX.okB} />
            <Text {...TX.label}> (this session: </Text>
            <Num d={f.sessionSaved} {...TX.value} />
            <Text {...TX.label}> across </Text>
            <Num d={f.restores} {...TX.value} />
            <Text {...TX.label}>)</Text>
          </Text>
        ) : (
          <Text {...TX.meta}>pending</Text>
        )}
      </KV>
      <KV label="R2 key:">
        <Ref {...TX.meta}>{f.key}</Ref>
      </KV>
      <KV label="commit rule:">
        <Text {...TX.meta}>tarball first (If-None-Match), manifest.json last; no manifest = ignored</Text>
      </KV>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Panel 3

export const BuildPanel = (p: CleanPanelProps) => {
  const w = contentWidth(p.width)
  const f = buildFigures()
  const phase = buildPhase(p.st)
  const checked = phase === "rebuilding" || phase === "published"
  return (
    <Panel title="INCREMENTAL BUILD" keyLabel="3" color={C.yellow} focused width={p.width}>
      <Row2
        width={w}
        left={
          <KV label="source:">
            <Num d={f.sources} {...TX.value} />
          </KV>
        }
        right={
          <KV label="cache:">
            {checked ? (
              <Text>
                <Num d={f.hits} {...TX.ok} />
                <Text {...TX.label}> / </Text>
                <Num d={f.misses} {...TX.warn} />
              </Text>
            ) : (
              <Text {...TX.warn}>hashing sources</Text>
            )}
          </KV>
        }
      />
      <Row2
        width={w}
        left={
          <KV label="affected:">
            <Num d={f.affected} {...TX.value} />
          </KV>
        }
        right={
          <KV label="rebuild:">
            {phase === "published" ? <Num d={f.rebuild} {...TX.value} /> : <Text {...TX.meta}>pending</Text>}
          </KV>
        }
      />
      <KV label="tool:">
        <Ref>{BUILD.toolVersion}</Ref>
      </KV>
      <KV label="status:">
        {phase === "rebuilding" ? (
          <Text>
            <Text {...TX.warnB}>BUILD: REBUILDING</Text>
            <Text {...TX.label}> (rebuilding </Text>
            <Num d={f.affected} {...TX.value} />
            <Text {...TX.label}>)</Text>
          </Text>
        ) : phase === "published" ? (
          <Text {...TX.okB}>BUILD: OUTPUTS PUBLISHED</Text>
        ) : (
          <Text {...TX.warn}>BUILD: CHECKING CACHE</Text>
        )}
      </KV>
      <KV label="outputs:">{phase === "published" ? <Num d={f.outputs} suffix=" emitted" {...TX.value} /> : <Text {...TX.meta}>pending</Text>}</KV>
      <KV label="R2 PUT:">
        <Ref {...TX.meta}>{f.key}</Ref>
        <Text {...(phase === "published" ? TX.okB : TX.meta)}>{phase === "published" ? " OK" : " waiting"}</Text>
      </KV>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Panel 4

export const BisectPanel = (p: CleanPanelProps) => {
  const w = contentWidth(p.width)
  const s = statusAt(p.st, p.statuses)
  const review = reviewPhase(p.st, p.statuses)
  return (
    <Panel title="BAYESIAN BISECT" keyLabel="4" color={C.magenta} focused width={p.width}>
      {s === null ? (
        <Text {...TX.meta}>waiting for the status route</Text>
      ) : (
        <BisectBody s={s} w={w} st={p.st} review={review} />
      )}
    </Panel>
  )
}

const BisectBody = (p: { readonly s: BisectStatus; readonly w: number; readonly st: CleanState; readonly review: "closed" | "open" | "approved" }) => {
  const f = bisectFigures(p.s)
  return (
    <Box flexDirection="column" width={p.w}>
      <KV label="session:">
        <Ref>{p.s.id}</Ref>
        <Text {...TX.meta}> (status route GET /api/bisect/:id)</Text>
      </KV>
      <Row2
        width={p.w}
        left={
          <KV label="range:">
            <Num d={f.range} {...TX.value} />
          </KV>
        }
        right={
          <KV label="steps:">
            <Num d={f.steps} bare {...TX.value} />
            <Text {...TX.label}> of </Text>
            <Num d={f.maxSteps} {...TX.value} />
          </KV>
        }
      />
      <Row2
        width={p.w}
        left={
          <KV label="culprit:">
            <Ref {...TX.strong}>{f.culprit}</Ref>
          </KV>
        }
        right={
          <KV label="confidence:">
            <Num d={f.confidence} {...TX.strong} />
          </KV>
        }
      />
      <Row2
        width={p.w}
        left={
          <KV label="predicate:">
            <Ref>{BISECT.predicate}</Ref>
          </KV>
        }
        right={
          <KV label="observations:">
            <Num d={f.passes} {...TX.ok} />
            <Text {...TX.label}> / </Text>
            <Num d={f.fails} {...TX.bad} />
          </KV>
        }
      />
      <KV label="posterior:">
        <AsciiBar fraction={f.confidence.value} width={CW.bar} on={f.converged ? TX.okB : TX.lock} />
      </KV>
      <KV label="status:">
        {f.converged ? (
          <Text {...TX.okB}>BISECT: CONVERGED</Text>
        ) : (
          <Text>
            <Text {...TX.warnB}>BISECT: TESTING</Text>
            <Text {...TX.label}> next </Text>
            <Ref>{f.next ?? ""}</Ref>
          </Text>
        )}
      </KV>
      <KV label="review:">
        {p.review === "open" ? (
          <Text {...TX.warnB}>APPROVAL GATE: press a to approve the culprit</Text>
        ) : p.review === "approved" ? (
          <Text>
            <Text {...TX.okB}>REVIEW APPROVED</Text>
            <Text {...TX.label}>{p.st.noteAt === null ? " by user; press n to write the git note" : " by user"}</Text>
          </Text>
        ) : (
          <Text {...TX.meta}>opens when the session converges</Text>
        )}
      </KV>
      {p.st.noteAt === null ? null : (
        <Box flexDirection="column" width={p.w}>
          <Text>
            <Text {...TX.okB}>GIT NOTE WRITTEN</Text>
            <Text {...TX.label}> on </Text>
            <Ref {...TX.strong}>{f.culprit}</Ref>
            <Text {...TX.meta}> (refs/notes/bisect)</Text>
          </Text>
          <KV label="  session:">
            <Ref>{p.s.id}</Ref>
          </KV>
          <KV label="  culprit:">
            <Ref>{f.culpritMessage}</Ref>
          </KV>
          <KV label="  confidence:">
            <Num d={f.confidence} {...TX.value} />
          </KV>
          <KV label="  predicate:">
            <Ref>{BISECT.predicate}</Ref>
          </KV>
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Panel 5

export const CoordinationPanel = (p: CleanPanelProps) => {
  const pol = leasePolicyFigures()
  const phase = coordinationPhase(p.st)
  return (
    <Panel title="COORDINATION: LEASE LOCKS" keyLabel="5" color={C.magenta} focused width={p.width}>
      <Text {...TX.meta}>
        R2 conditional writes: acquire If-None-Match, renew If-Match every <Num d={pol.renew} digits={0} {...TX.meta} />, lease <Num d={pol.lease} digits={0} {...TX.meta} />
      </Text>
      <Box>
        <Cell {...TX.label} width={CW.agent}>
          agent
        </Cell>
        <Cell {...TX.label} width={CW.op}>
          operation
        </Cell>
        <Cell {...TX.label} width={CW.state}>
          state
        </Cell>
        <Cell {...TX.label} width={CW.ttl}>
          TTL
        </Cell>
        <Text {...TX.label}>last renewal</Text>
      </Box>
      {leaseFigures().map((l) => (
        <Box>
          <Cell {...TX.value} width={CW.agent}>
            {l.agent}
          </Cell>
          <Cell {...TX.lock} width={CW.op}>
            {l.op}
          </Cell>
          <Cell {...TX.okB} width={CW.state}>
            ACTIVE
          </Cell>
          <Num d={l.ttl} digits={0} width={CW.ttl} {...TX.value} />
          <Num d={l.heartbeat} digits={0} suffix=" ago" {...TX.value} />
        </Box>
      ))}
      <Text> </Text>
      {phase === "heartbeat" ? (
        <Text>
          <Text {...TX.okB}>HEARTBEAT: ALL AGENTS FRESH</Text>
          <Text {...TX.label}> (</Text>
          <Num d={pol.fresh} {...TX.value} />
          <Text {...TX.label}> renewed within </Text>
          <Num d={pol.renew} digits={0} {...TX.value} />
          <Text {...TX.label}>, no contention)</Text>
        </Text>
      ) : (
        <Text {...TX.meta}>reading the lease objects</Text>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Panel 6

const KIND_LOOK: Readonly<Record<CleanKind, TextLook>> = {
  SYSTEM: TX.brand,
  ENV: TX.info,
  ARTIFACT: TX.brand,
  DEPS: TX.info,
  BUILD: TX.warn,
  BISECT: TX.lock,
  REVIEW: TX.warnB,
  NOTES: TX.okB,
  COST: TX.warnB
}

const triggered = (st: CleanState, statuses: ReadonlyArray<BisectStatus>, tr: CleanEvent["trigger"]): boolean => {
  switch (tr.on) {
    case "launch":
      return true
    case "deps":
      return tr.phase === "restoring" ? depsPhase(st) !== "unvisited" : depsPhase(st) === "hit"
    case "build": {
      const b = buildPhase(st)
      return tr.phase === "checking" ? b !== "unvisited" : tr.phase === "checked" ? b === "rebuilding" || b === "published" : b === "published"
    }
    case "bisect":
      return bisectStep(st) >= tr.step && statuses.length > 0
    case "approved":
      return st.approvedAt !== null
    case "note":
      return st.noteAt !== null
  }
}

/** The rows of the event stream visible in a state (oldest first). */
export const visibleEvents = (st: CleanState, statuses: ReadonlyArray<BisectStatus>): ReadonlyArray<CleanEvent> =>
  cleanEvents()
    .filter((e) => triggered(st, statuses, e.trigger))
    .sort((a, b) => a.at.value - b.at.value)

export const CleanEventStream = (p: CleanPanelProps & { readonly maxRows: number }) => {
  const rows = visibleEvents(p.st, p.statuses)
  const last = rows.slice(Math.max(0, rows.length - Math.max(1, p.maxRows)))
  return (
    <Panel title="EVENT STREAM: CLEAN RUN" keyLabel="6" color={C.cyan} focused width={p.width}>
      {last.map((e) => (
        <Box>
          <Num d={e.at} prefix="T+" width={CW.clock} {...TX.meta} />
          <Cell {...KIND_LOOK[e.kind]} width={CW.kind}>
            {e.kind}
          </Cell>
          <Parts parts={e.parts} {...TX.value} />
        </Box>
      ))}
    </Panel>
  )
}

