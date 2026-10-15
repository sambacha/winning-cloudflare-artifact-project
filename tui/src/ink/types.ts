/** Element types of the Ink-shaped shim. */

/**
 * A component is any function from props to a node; props are checked at the JSX call site.
 * eslint-disable-next-line @typescript-eslint/no-explicit-any
 */
export type Component = (props: any) => InkNode

export interface InkElement {
  readonly type: Component
  readonly props: Readonly<Record<string, unknown>>
  readonly key: string | null
}

export type InkNode = InkElement | string | number | boolean | null | undefined | ReadonlyArray<InkNode>

/** Ink's named colours, plus any `#rrggbb`. */
export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "grey"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "magentaBright"
  | "cyanBright"
  | "whiteBright"

export type Color = NamedColor | `#${string}`
