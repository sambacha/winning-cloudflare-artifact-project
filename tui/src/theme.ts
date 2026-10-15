/** Palette and typography levels from the design brief. */
import type { Style } from "./ansi.ts"
import type { Color } from "./ink/types.ts"

export const C = {
  cyan: "#00D7FF", // branding, headers
  green: "#00FF87", // success, verified, merged
  yellow: "#FFD700", // in progress, building
  red: "#FF0059", // failed, conflict, expired
  magenta: "#FF00FF", // lock operations, BLAKE3
  blue: "#0087FF", // cache, pending, info
  gray: "#585858", // dim, secondary
  white: "#FFFFFF", // primary text, values
  black: "#000000"
} as const satisfies Record<string, Color>

/** Segment styles (for the frame chrome drawn by `view.ts`). */
export const T = {
  h1: { fg: C.cyan, bold: true },
  label: { fg: C.gray },
  value: { fg: C.white },
  meta: { fg: C.gray, dim: true },
  ok: { fg: C.green },
  okB: { fg: C.green, bold: true },
  warn: { fg: C.yellow },
  warnB: { fg: C.yellow, bold: true },
  bad: { fg: C.red },
  badB: { fg: C.red, bold: true },
  lock: { fg: C.magenta },
  info: { fg: C.blue },
  brand: { fg: C.cyan }
} as const satisfies Record<string, Style>

/** The same levels as `<Text>` props (for the panel components). */
export interface TextLook {
  readonly color: Color
  readonly bold?: boolean
  readonly dimColor?: boolean
}

export const TX = {
  h1: { color: C.cyan, bold: true },
  label: { color: C.gray },
  value: { color: C.white },
  strong: { color: C.white, bold: true },
  meta: { color: C.gray, dimColor: true },
  ok: { color: C.green },
  okB: { color: C.green, bold: true },
  warn: { color: C.yellow },
  warnB: { color: C.yellow, bold: true },
  bad: { color: C.red },
  badB: { color: C.red, bold: true },
  lock: { color: C.magenta },
  info: { color: C.blue },
  brand: { color: C.cyan }
} as const satisfies Record<string, TextLook>

/** Border colour of a panel: brighter when it has the focus. */
export const border = (color: string, focused: boolean): Style => (focused ? { fg: color, bold: true } : { fg: color, dim: true })
