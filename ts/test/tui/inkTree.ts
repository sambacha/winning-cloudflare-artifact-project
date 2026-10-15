/**
 * Lays out an element tree of the dashboard's Ink components as text lines,
 * for tests: `Text` is one line (its string children joined), a column `Box`
 * stacks its children, a row `Box` joins its children's lines side by side,
 * function components are called. Works with the real `react` + `ink`
 * elements as well as the test stand-ins, because it only looks at `type`
 * and `props` and compares `type` with the imported `Box` / `Text`.
 */
import { Box, Text } from "ink"

interface El {
  readonly type: unknown
  readonly props: { readonly children?: unknown; readonly flexDirection?: string; readonly [k: string]: unknown }
}

const isEl = (x: unknown): x is El => typeof x === "object" && x !== null && "type" in x && "props" in x

const flat = (x: unknown): ReadonlyArray<unknown> => (Array.isArray(x) ? x.flatMap(flat) : x === null || x === undefined || x === false || x === true ? [] : [x])

const textOf = (x: unknown): string =>
  flat(x)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isEl(c) && c.type === Text ? textOf(c.props.children) : ""))
    .join("")

/** Text lines of a tree; also returns the `Text` style props seen (for colour checks). */
export const linesOf = (node: unknown): ReadonlyArray<string> => {
  if (!isEl(node)) return []
  if (node.type === Text) return [textOf(node.props.children)]
  if (node.type === Box) {
    const kids = flat(node.props.children).map(linesOf)
    if (node.props.flexDirection === "row") {
      const h = Math.max(0, ...kids.map((k) => k.length))
      return Array.from({ length: h }, (_, i) => kids.map((k) => k[i] ?? "").join(""))
    }
    return kids.flat()
  }
  if (typeof node.type === "function") return linesOf((node.type as (p: unknown) => unknown)(node.props))
  return flat(node.props.children).flatMap(linesOf)
}

/** Count of `Box` / `Text` elements (structure checks). */
export const countTypes = (node: unknown, acc = { box: 0, text: 0 }): { box: number; text: number } => {
  if (!isEl(node)) return acc
  if (node.type === Text) acc.text++
  else if (node.type === Box) acc.box++
  if (typeof node.type === "function" && node.type !== Box && node.type !== Text) return countTypes((node.type as (p: unknown) => unknown)(node.props), acc)
  for (const c of flat(node.props.children)) countTypes(c, acc)
  return acc
}
