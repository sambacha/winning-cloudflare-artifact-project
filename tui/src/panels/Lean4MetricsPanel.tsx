/**
 * Panel 4: Lean 4 CI metrics, as two boxes (axiom audit, build pipeline).
 * The brief's `Lean4MetricsPanel.tsx`, with its `PhaseBar` clamped (see
 * `common.tsx`), colours typed as `Color`, and every figure derived: the
 * phase totals are import + enum/filter + traversal, with traversal =
 * per-theorem time × theorems, so the phase table and the algorithm table
 * agree (the brief had two different totals for the same run).
 */
import { Box, type InkElement, Text } from "../ink/index.ts"
import { W } from "../layout.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { Cell, Glyph, Num, Pair, Panel, PhaseBar, ProvTag, Ref, taggedTitle } from "./common.tsx"
import type { PanelProps } from "./props.ts"

/** Speedup colour: green above the second-best tier, yellow above 1×, red at the baseline. */
const speedLook = (x: number, best: number): TextLook => (x >= best ? TX.okB : x > 1 ? TX.warnB : TX.badB)

const Heading = (p: { readonly children: string }) => (
  <Text color={C.white} bold>
    {p.children}
  </Text>
)

const AuditBox = (p: PanelProps & { readonly w: number }) => {
  const f = p.fig
  const st = p.state
  const speeds = f.algorithms.map((a) => a.speedup.value).sort((a, b) => b - a)
  const tier = speeds[Math.min(speeds.length - 1, 1)] ?? 1
  return (
    <Panel title={taggedTitle("Axiom Audit Performance", p.state, "lean")} keyLabel="4" color={C.green} focused={p.focused} width={p.w}>
      {p.state.feed?.leanAudit != null ? (
        <Text>
          <Text {...TX.label}>{"Measured by lake build: "}</Text>
          <Ref {...TX.okB}>{`${p.state.feed.leanAudit.theorems} theorems`}</Ref>
          <Text {...TX.label}>{" under "}</Text>
          <Ref {...TX.value}>{p.state.feed.leanAudit.prefix}</Ref>
          <Text {...TX.label}>{", "}</Text>
          <Ref {...(p.state.feed.leanAudit.violations === 0 ? TX.okB : TX.badB)}>{`${p.state.feed.leanAudit.violations} violations`}</Ref>
        </Text>
      ) : null}
      {p.state.feed?.leanAudit != null ? <Text {...TX.meta}>The figures below are illustrative.</Text> : null}
      <Text>
        <Text {...TX.label}>Theorems: </Text>
        <Num d={f.project.theorems} {...TX.value} />
        <Text {...TX.label}> │ audited now: </Text>
        <Num d={st.theoremsAudited} bare {...(st.auditDone ? TX.okB : TX.warn)} />
      </Text>
      <Text>
        <Text {...TX.label}>Mathlib: </Text>
        <Num d={f.project.constants} {...TX.value} />
      </Text>
      <Text> </Text>
      <Heading>Algorithm comparison:</Heading>
      <Box>
        <Cell color={C.gray} bold width={W.cell}>
          Algorithm
        </Cell>
        <Cell color={C.gray} bold width={W.wideCell} align="right">
          Per theorem
        </Cell>
        <Cell color={C.gray} bold width={W.wideCell} align="right">
          Total
        </Cell>
        <Cell color={C.gray} bold width={W.wideCell} align="right">
          Speedup
        </Cell>
      </Box>
      {f.algorithms.map((a) => (
        <Box>
          <Ref {...speedLook(a.speedup.value, tier)} width={W.cell}>
            {a.name}
          </Ref>
          <Num d={a.perTheorem} width={W.wideCell} align="right" {...TX.value} />
          <Num d={a.total} width={W.wideCell} align="right" {...TX.value} />
          <Num d={a.speedup} width={W.wideCell} align="right" {...speedLook(a.speedup.value, tier)} />
        </Box>
      ))}
      <Text> </Text>
      <Heading>Audit cache:</Heading>
      <Text>
        <Text {...TX.label}>Cold run:   </Text>
        <Num d={f.auditCache.cold} {...TX.bad} />
        <Text {...TX.meta}> (</Text>
        <Ref {...TX.meta}>{f.auditCache.coldVariant}</Ref>
        <Text {...TX.meta}>)</Text>
      </Text>
      <Text>
        <Text {...TX.label}>Warm cache: </Text>
        <Num d={f.auditCache.warm} {...TX.warn} />
        <Text {...TX.meta}> (hit rate </Text>
        <Num d={f.auditCache.warmHitRate} digits={0} {...TX.meta} />
        <Text {...TX.meta}>)</Text>
      </Text>
      <Text>
        <Text {...TX.label}>Persistent: </Text>
        <Ref {...TX.ok}>{p.inputs.auditCache.persistent}</Ref>
      </Text>
      <Text {...TX.label}>
        {"SCCs: "}
        <Num d={f.graph.sccCount} bare />
        {" │ largest: "}
        <Num d={f.graph.maxScc} />
        {" │ depth: "}
        <Num d={f.graph.maxDepth} />
      </Text>
      <Text {...TX.label}>
        <Ref>{`Edges (d=5): ${p.inputs.graph.edgesD5}`}</Ref>
        {" │ cache file: "}
        <Num d={f.graph.cacheFile} />
      </Text>
      <Text> </Text>
      <Heading>Axiom results:</Heading>
      {p.inputs.axioms.map((a) =>
        !st.auditDone ? (
          <Box>
            <Glyph name="ring" {...TX.label} />
            <Text> </Text>
            <Ref {...TX.label} width={W.nameCell}>
              {a.name}
            </Ref>
            <Text {...TX.warn}>pending</Text>
          </Box>
        ) : (
          <Box>
            <Glyph name="dot" {...(a.found && !a.allowed ? TX.bad : TX.ok)} />
            <Text> </Text>
            <Ref {...TX.value} width={W.nameCell}>
              {a.name}
            </Ref>
            {a.allowed ? (
              <Text {...(a.found ? TX.ok : TX.warn)}>{a.found ? "found (allowed)" : "not used (allowed)"}</Text>
            ) : (
              <Text {...(a.found ? TX.badB : TX.ok)}>{a.found ? "FOUND (forbidden)" : "not found (forbidden)"}</Text>
            )}
          </Box>
        )
      )}
    </Panel>
  )
}

const PipelineBox = (p: PanelProps & { readonly w: number }) => {
  const f = p.fig
  const current = f.phases[f.phases.length - 1]!
  const barW = Math.max(W.minBar, Math.min(W.bar, p.w - W.barReserve))
  const gateOk = p.state.auditDone
  const gates: ReadonlyArray<{ readonly ok: boolean; readonly label: InkElement }> = [
    { ok: f.axioms.forbiddenFound.value === 0, label: <Text>No forbidden axioms detected</Text> },
    {
      ok: true,
      label: (
        <Text>
          {"All "}
          <Num d={f.project.theorems} />
          {" pass"}
        </Text>
      )
    },
    { ok: true, label: <Text>Mathlib cache hit on import</Text> },
    { ok: true, label: <Text>Build reproducible</Text> }
  ]
  const cell = (d: Parameters<typeof Num>[0]["d"], look: TextLook = TX.value) => <Num d={d} width={W.cell} align="right" {...look} />
  return (
    <Panel title={p.state.feed === undefined ? "Build Pipeline" : <Text>Build Pipeline<ProvTag prov="DEMO" /></Text>} color={C.green} focused={p.focused} width={p.w}>
      <Box>
        <Heading>Phase breakdown </Heading>
        <Text {...TX.meta}>(</Text>
        <Num d={f.project.theorems} {...TX.meta} />
        <Text {...TX.meta}>)</Text>
      </Box>
      <Box>
        <Cell color={C.gray} bold width={W.wideCell}>
          Phase
        </Cell>
        {f.phases.map((ph) => (
          <Ref color={C.gray} bold width={W.cell} align="right">
            {ph.variant}
          </Ref>
        ))}
      </Box>
      <Box>
        <Cell {...TX.label} width={W.wideCell}>
          Import
        </Cell>
        {f.phases.map((ph) => cell(ph.import))}
      </Box>
      <Box>
        <Cell {...TX.label} width={W.wideCell}>
          Enum/filter
        </Cell>
        {f.phases.map((ph) => cell(ph.enumFilter))}
      </Box>
      <Box>
        <Cell {...TX.label} width={W.wideCell}>
          Traversal
        </Cell>
        {f.phases.map((ph) => cell(ph.traversal))}
      </Box>
      <Box>
        <Cell color={C.white} bold width={W.wideCell}>
          Total
        </Cell>
        {f.phases.map((ph) => cell(ph.total, TX.strong))}
      </Box>
      <Text> </Text>
      <Ref {...TX.label}>{`${current.variant}:`}</Ref>
      <PhaseBar label="  import" labelWidth={W.phaseLabel} pct={current.importPct} width={barW} color={C.blue} />
      <PhaseBar label="  enum/filter" labelWidth={W.phaseLabel} pct={current.enumFilterPct} width={barW} color={C.magenta} />
      <PhaseBar label="  traversal" labelWidth={W.phaseLabel} pct={current.traversalPct} width={barW} color={C.yellow} />
      <Text> </Text>
      <Text>
        <Text {...TX.label}>Wall time: </Text>
        <Num d={f.resources.wall} {...TX.value} />
        <Text {...TX.label}> (</Text>
        <Ref {...TX.label}>{f.resources.variant}</Ref>
        <Text {...TX.label}>) │ CPU: </Text>
        <Num d={f.resources.cpu} {...TX.value} />
        <Text {...TX.label}> on </Text>
        <Num d={f.resources.cores} {...TX.value} />
      </Text>
      <Text>
        <Text {...TX.label}>Peak memory: </Text>
        <Num d={f.resources.peakMem} digits={0} {...TX.value} />
        <Text {...TX.label}> │ allocated: </Text>
        <Num d={f.resources.allocated} {...TX.value} />
        <Text {...TX.label}> (GC churn)</Text>
      </Text>
      <Text> </Text>
      <Box>
        <Heading>Parallel scaling </Heading>
        <Text {...TX.meta}>(</Text>
        <Num d={f.scaling.theorems} {...TX.meta} />
        <Text {...TX.meta}>)</Text>
      </Box>
      <Box>
        <Cell color={C.gray} bold width={W.cell}>
          Cores
        </Cell>
        <Cell color={C.gray} bold width={W.cell} align="right">
          Time
        </Cell>
        <Cell color={C.gray} bold width={W.cell} align="right">
          Speedup
        </Cell>
        <Cell color={C.gray} bold width={W.cell} align="right">
          Amdahl
        </Cell>
      </Box>
      <Box>
        <Num d={f.scaling.baseCores} bare width={W.cell} {...TX.label} />
        {cell(f.scaling.oneCore)}
      </Box>
      {f.scaling.rows.map((r) => (
        <Box>
          <Num d={r.cores} bare width={W.cell} {...TX.label} />
          {cell(r.total)}
          {cell(r.speedup, TX.ok)}
          {cell(r.amdahl, TX.meta)}
        </Box>
      ))}
      <Box>
        <Glyph name="infinity" {...TX.label} />
        <Cell width={W.cell - 1}> </Cell>
        {cell(f.scaling.limit)}
        <Text {...TX.meta}> (Amdahl limit)</Text>
      </Box>
      <Text> </Text>
      <Heading>CI gate:</Heading>
      {gates.map((g) => (
        <Box>
          {gateOk ? <Glyph name={g.ok ? "ok" : "bad"} {...(g.ok ? TX.okB : TX.badB)} /> : <Glyph name="ellipsis" {...TX.warn} />}
          <Text> </Text>
          <Text {...(gateOk ? TX.value : TX.label)}>{g.label}</Text>
        </Box>
      ))}
    </Panel>
  )
}

export const Lean4MetricsPanel = (p: PanelProps) => (
  <Pair width={p.width} left={(w) => <AuditBox {...p} w={w} />} right={(w) => <PipelineBox {...p} w={w} />} />
)
