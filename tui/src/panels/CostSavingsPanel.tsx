/**
 * Panel 5: cost savings against GitHub Actions. The brief's
 * `CostSavingsPanel.tsx`, fixed:
 * - the bars are normalised against the largest of the compared costs (the
 *   brief computed `x / x * maxBar`, so every bar had the same length);
 * - the ROI is `Infinity` (shown "∞") when Cobuilds costs nothing, instead
 *   of a division by zero;
 * - the drivers list ends with its total, which is the Cobuilds monthly
 *   headline (the brief's drivers summed to $141.08 under a $180 headline);
 * - monthly figures are per-run figures × runs per month (the brief's
 *   $2,400/month did not match its 30-run narrative);
 * - break-even and payback are gone: they had no inputs.
 */
import { normalizedBars } from "../derive.ts"
import { GLYPHS } from "../glyphs.ts"
import { Box, Text } from "../ink/index.ts"
import { DIGITS, W } from "../layout.ts"
import { C, TX } from "../theme.ts"
import { Cell, Glyph, Num, Pair, Panel, ProvTag, Ref, taggedTitle } from "./common.tsx"
import type { PanelProps } from "./props.ts"

const MonthlyBox = (p: PanelProps & { readonly w: number }) => {
  const c = p.fig.cost
  const maxBar = Math.max(W.minBar, p.w - W.costBarReserve - W.label)
  const rows = [
    { label: "GitHub Actions (standard runners):", d: c.ghaMonthly, look: TX.bad },
    { label: "GitHub Actions (larger 4-core runners):", d: c.ghaLargerMonthly, look: TX.bad },
    { label: "Cobuilds on Cloudflare (R2, Workers, DO, runner):", d: c.cobuildsMonthly, look: TX.ok }
  ]
  const bars = normalizedBars(
    rows.map((r) => r.d.value),
    maxBar
  )
  return (
    <Panel title={taggedTitle("Monthly CI Cost Comparison", p.state, "cost")} keyLabel="5" color={C.yellow} focused={p.focused} width={p.w}>
      <Text {...TX.meta}>
        {"at "}
        <Num d={c.runsPerMonth} />
        {", "}
        <Num d={c.minutesPerRun} />
        {" on GitHub Actions"}
      </Text>
      {rows.map((r, i) => (
        <Box flexDirection="column">
          <Ref {...TX.label}>{r.label}</Ref>
          <Text>
            <Text {...r.look}>{GLYPHS.barOn.char.repeat(bars[i]!)}</Text>
            <Text> </Text>
            <Num d={r.d} {...TX.value} />
          </Text>
        </Box>
      ))}
      <Text> </Text>
      <Text>
        <Text {...TX.okB}>Savings: </Text>
        <Num d={c.savingsMonthly} {...TX.okB} />
        <Text {...TX.okB}> (</Text>
        <Num d={c.savingsPct} {...TX.okB} />
        <Text {...TX.okB}>) vs standard runners</Text>
      </Text>
      <Text>
        <Text {...TX.label}>Annual:  </Text>
        <Num d={c.annual} {...TX.ok} />
        <Text {...TX.label}>   ROI: </Text>
        <Num d={c.roi} {...TX.ok} />
        <Text {...TX.label}> cost reduction</Text>
      </Text>
      <Text> </Text>
      <Text color={C.white} bold>
        Cobuilds monthly cost, itemised:
      </Text>
      {c.drivers.map((d) => (
        <Box>
          <Text {...TX.label}>{"├─ "}</Text>
          <Ref {...TX.label} width={W.costLabel}>{`${d.driver.name}:`}</Ref>
          <Num d={d.qty} {...TX.meta} />
          <Text {...TX.meta}>{" × "}</Text>
          <Num d={d.price} digits={DIGITS.price} suffix={`/${d.driver.priceUnit}`} {...TX.meta} />
          <Text {...TX.meta}>{" = "}</Text>
          <Num d={d.cost} {...TX.value} />
        </Box>
      ))}
      <Box>
        <Text {...TX.label}>{"├─ "}</Text>
        <Cell {...TX.label} width={W.costLabel}>
          Runner:
        </Cell>
        <Num d={c.cobuildsRunnerMonthly} {...TX.value} />
      </Box>
      <Box>
        <Text {...TX.label}>{"├─ "}</Text>
        <Cell {...TX.label} width={W.costLabel}>
          R2 egress:
        </Cell>
        <Num d={c.cobuildsTransferMonthly} {...TX.value} />
      </Box>
      <Box>
        <Text {...TX.label}>{"└─ "}</Text>
        <Cell color={C.white} bold width={W.costLabel}>
          Total:
        </Cell>
        <Num d={c.cobuildsMonthly} {...TX.okB} />
      </Box>
    </Panel>
  )
}

const PerRunBox = (p: PanelProps & { readonly w: number }) => {
  const c = p.fig.cost
  const head = { color: C.gray, bold: true } as const
  return (
    <Panel title={p.state.feed === undefined ? "Per-Run Cost Breakdown" : <Text>Per-Run Cost Breakdown<ProvTag prov="DEMO" /></Text>} color={C.yellow} focused={p.focused} width={p.w}>
      <Box>
        <Cell {...head} width={W.costLabel}>
          Item
        </Cell>
        <Cell {...head} width={W.costCell} align="right">
          GHA
        </Cell>
        <Cell {...head} width={W.costCell} align="right">
          Cobuilds
        </Cell>
      </Box>
      {c.perRun.map((r) => (
        <Box>
          <Cell {...TX.label} width={W.costLabel}>
            {r.item}
          </Cell>
          {r.gha === null ? (
            <Cell {...TX.meta} width={W.costCell} align="right">
              N/A
            </Cell>
          ) : (
            <Num d={r.gha} bare digits={DIGITS.cents} width={W.costCell} align="right" {...TX.value} />
          )}
          {r.cobuilds === null ? (
            <Cell {...TX.meta} width={W.costCell} align="right">
              N/A
            </Cell>
          ) : (
            <Num d={r.cobuilds} bare digits={DIGITS.perRun} width={W.costCell} align="right" {...TX.ok} />
          )}
        </Box>
      ))}
      <Box>
        <Cell color={C.white} bold width={W.costLabel}>
          Total per run
        </Cell>
        <Num d={c.ghaPerRun} bare digits={DIGITS.cents} width={W.costCell} align="right" {...TX.badB} />
        <Num d={c.cobuildsPerRun} bare digits={DIGITS.perRun} width={W.costCell} align="right" {...TX.okB} />
      </Box>
      <Box>
        <Cell {...TX.label} width={W.costLabel}>
          Savings per run
        </Cell>
        <Cell width={W.costCell}> </Cell>
        <Num d={c.savingsPerRun} bare width={W.costCell} align="right" {...TX.okB} />
      </Box>
      <Box>
        <Cell {...TX.label} width={W.costLabel}>
          Reduction
        </Cell>
        <Cell width={W.costCell}> </Cell>
        <Num d={c.reductionPct} width={W.costCell} align="right" {...TX.okB} />
      </Box>
      <Text> </Text>
      <Text>
        <Text {...TX.label}>This run so far: </Text>
        <Num d={p.state.costSoFar} digits={DIGITS.perRun} {...TX.okB} />
        <Text {...TX.label}> (GHA equivalent </Text>
        <Num d={p.state.ghaEquivalent} {...TX.bad} />
        <Text {...TX.label}>)</Text>
      </Text>
      <Text> </Text>
      <Text color={C.white} bold>
        Inputs (illustrative):
      </Text>
      {c.assumptions.map((a, i) => (
        <Box>
          <Text {...TX.label}>{i === c.assumptions.length - 1 ? "└─ " : "├─ "}</Text>
          <Cell {...TX.label} width={W.nameCell + W.ellipsis + W.ellipsis}>{`${a.label}:`}</Cell>
          <Num d={a.value} digits={a.value.unit === "USD" ? DIGITS.price : undefined} suffix={a.per} {...TX.meta} />
        </Box>
      ))}
      <Box>
        <Glyph name="middot" {...TX.meta} />
        <Text {...TX.meta}> Unit prices of the drivers are listed in the monthly box.</Text>
      </Box>
    </Panel>
  )
}

export const CostSavingsPanel = (p: PanelProps) => (
  <Pair width={p.width} left={(w) => <MonthlyBox {...p} w={w} />} right={(w) => <PerRunBox {...p} w={w} />} />
)
