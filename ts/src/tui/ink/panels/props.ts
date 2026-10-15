/** Props shared by the six panel components (no globals: everything a panel draws comes in here). */
import { LAYOUT } from "../../constants.js"
import type { DashboardInput, UiState } from "../../model.js"

export interface PanelProps {
  readonly input: DashboardInput
  readonly ui: UiState
  readonly width: number
  readonly height: number
  readonly focused: boolean
}

/** Cells inside the border. */
export const innerWidth = (width: number): number => Math.max(0, width - LAYOUT.border)
