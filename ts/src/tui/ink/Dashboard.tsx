/**
 * The whole screen: header, the panels laid out by `layoutFor` (grouped in
 * row bands by `bands`, exactly as the snapshot renderer composes them),
 * footer. Pure: the same props give the same tree.
 */
import { Box } from "ink"
import { bands, isFocused, layoutFor, type Slot } from "../frame.js"
import type { DashboardInput, UiState } from "../model.js"
import { footer, header } from "../rows.js"
import { ArtifactsPanel } from "./panels/ArtifactsPanel.js"
import { BisectPanel } from "./panels/BisectPanel.js"
import { CostPanel } from "./panels/CostPanel.js"
import { EventStream } from "./panels/EventStream.js"
import { LeasePanel } from "./panels/LeasePanel.js"
import { NodeModulesPanel } from "./panels/NodeModulesPanel.js"
import type { PanelProps } from "./panels/props.js"
import { RowText } from "./PanelBox.js"

/** Props of the dashboard. */
export interface DashboardProps {
  readonly input: DashboardInput
  readonly ui: UiState
  readonly cols: number
  readonly rows: number
}

const SlotView = ({ slot, ...p }: PanelProps & { readonly slot: Slot }) => {
  switch (slot.key) {
    case 1:
      return <ArtifactsPanel {...p} />
    case 2:
      return <NodeModulesPanel {...p} />
    case 3:
      return <LeasePanel {...p} />
    case 4:
      return <BisectPanel {...p} />
    case 5:
      return <CostPanel {...p} />
    case null:
      return <EventStream {...p} />
  }
}

/** Header row. */
export const Header = ({ input, ui, cols }: Omit<DashboardProps, "rows">) => <RowText row={header(input, ui, cols)} />

/** Footer row: the controls. */
export const Footer = ({ cols }: { readonly cols: number }) => <RowText row={footer(cols)} />

/** The dashboard, exactly `cols` x `rows`. */
export const Dashboard = ({ input, ui, cols, rows }: DashboardProps) => {
  const layout = layoutFor(cols, rows, ui.focus)
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header input={input} ui={ui} cols={cols} />
      {bands(layout).map((band) => (
        <Box key={band[0]?.y ?? 0} flexDirection="row" height={band[0]?.h ?? 0}>
          {band.map((slot) => (
            <SlotView key={slot.x} slot={slot} input={input} ui={ui} width={slot.w} height={slot.h} focused={isFocused(layout, slot, ui)} />
          ))}
        </Box>
      ))}
      <Footer cols={cols} />
    </Box>
  )
}
