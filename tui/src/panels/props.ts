/** Props shared by the panel components. */
import type { Inputs } from "../data.ts"
import type { Figures } from "../derive.ts"
import { BLINK_ON_TICKS, BLINK_TICKS } from "../layout.ts"
import type { State } from "../scenario.ts"

export interface PanelProps {
  readonly state: State
  readonly fig: Figures
  readonly inputs: Inputs
  /** Total width of the panel, borders included. */
  readonly width: number
  readonly focused: boolean
  /** UI clock (ticks), for blinking; ignored when `anim` is false. */
  readonly tick: number
  /** Motion policy: false under `--no-anim`, `CI`, `TERM=dumb` (glyphs stay in their "on" phase). */
  readonly anim: boolean
}

/** Blink phase: always "on" without animation. */
export const blink = (p: { readonly anim: boolean; readonly tick: number }): boolean => !p.anim || p.tick % BLINK_TICKS < BLINK_ON_TICKS
