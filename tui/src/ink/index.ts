/**
 * An Ink-shaped shim: `Box`, `Text`, `Newline`, `Spacer`, `render`,
 * `useInput`, `useStdout`, with Ink's prop names, so that the panel
 * components (`src/panels/*.tsx`) are written as Ink components and would
 * run on Ink unchanged. It has no dependencies and is backed by the demo's
 * segment renderer (`../ansi.ts`).
 *
 * Supported subset (anything else is a type error, not silently ignored;
 * row children are stretched to the row's height, Ink's default `alignItems`):
 * - `Box`: `flexDirection` row (default, as in Ink) or column; `width`;
 *   `flexGrow` (row children without a width share the free space);
 *   `borderStyle` single | round | double | bold; `borderColor`;
 *   `borderDimColor`; `paddingX`, `paddingLeft`, `paddingRight`; `gap`
 *   (columns in a row, rows in a column); `marginTop`, `marginBottom`.
 * - `Text`: `color`, `backgroundColor`, `bold`, `dimColor`, `underline`,
 *   `wrap` ("truncate" | "truncate-end"; long lines are cut at the box edge).
 *   Nested `Text` inherits and overrides styles, as in Ink.
 * - Hooks are called while a tree is laid out (`render` or
 *   `renderToLines`): `useInput` registers a key handler with the running
 *   `render` instance; `useStdout` returns its output stream.
 *
 * Every string a `Text` displays goes through `sanitize` (G4 in
 * `../glyphs.ts`), so emoji, joiners, controls and stray combining marks in
 * data can never change the width of a line.
 */
import { type Line, type Seg, type Style, fit, lineWidth, render as renderLine, type RenderMode, s, truncate } from "../ansi.ts"
import { sanitize } from "../glyphs.ts"
import type { Color, Component, InkElement, InkNode, NamedColor } from "./types.ts"

export type { Color, Component, InkElement, InkNode, NamedColor } from "./types.ts"

// ---------------------------------------------------------------------------
// Components (markers: the layout engine recognises them by identity)

export interface TextProps {
  readonly color?: Color | undefined
  readonly backgroundColor?: Color | undefined
  readonly bold?: boolean | undefined
  readonly dimColor?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly wrap?: "truncate" | "truncate-end"
  readonly children?: InkNode
}

export type BorderStyle = "single" | "round" | "double" | "bold"

export interface BoxProps {
  readonly flexDirection?: "row" | "column"
  readonly width?: number
  readonly flexGrow?: number
  readonly borderStyle?: BorderStyle
  readonly borderColor?: Color
  readonly borderDimColor?: boolean
  readonly paddingX?: number
  readonly paddingLeft?: number
  readonly paddingRight?: number
  readonly gap?: number
  readonly marginTop?: number
  readonly marginBottom?: number
  readonly children?: InkNode
}

const marker = (name: string): Component => {
  const f = (): InkNode => {
    throw new Error(`<${name}> is laid out by the shim and must not be called directly`)
  }
  Object.defineProperty(f, "name", { value: name })
  return f
}

export const Text = marker("Text") as (props: TextProps) => InkElement
export const Box = marker("Box") as (props: BoxProps) => InkElement
/** A line break inside `Text` (Ink: `<Newline />`). */
export const Newline = marker("Newline") as (props: { readonly count?: number }) => InkElement
/** Flexible space in a row (Ink: `<Spacer />`). */
export const Spacer = marker("Spacer") as (props: Record<string, never>) => InkElement

/** React-style `createElement(type, props, ...children)` (for code that does not use JSX). */
export const createElement = <P extends object>(type: (props: P) => InkNode, props: P, ...children: InkNode[]): InkElement => ({
  type: type as Component,
  props: children.length === 0 ? (props as Record<string, unknown>) : { ...(props as Record<string, unknown>), children },
  key: null
})

// ---------------------------------------------------------------------------
// Colours

const NAMED: Readonly<Record<NamedColor, string>> = {
  black: "#000000",
  red: "#FF0059",
  green: "#00FF87",
  yellow: "#FFD700",
  blue: "#0087FF",
  magenta: "#FF00FF",
  cyan: "#00D7FF",
  white: "#FFFFFF",
  gray: "#585858",
  grey: "#585858",
  redBright: "#FF5F87",
  greenBright: "#5FFFAF",
  yellowBright: "#FFFF5F",
  blueBright: "#5FAFFF",
  magentaBright: "#FF5FFF",
  cyanBright: "#5FFFFF",
  whiteBright: "#FFFFFF"
}

const hexOf = (c: Color | undefined): string | undefined => (c === undefined ? undefined : c.startsWith("#") ? c : NAMED[c as NamedColor])

const textStyle = (p: TextProps, inherited: Style): Style => {
  const fg = hexOf(p.color) ?? inherited.fg
  const bg = hexOf(p.backgroundColor) ?? inherited.bg
  const bold = p.bold ?? inherited.bold
  const dim = p.dimColor ?? inherited.dim
  const underline = p.underline ?? inherited.underline
  return {
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(bold ? { bold: true } : {}),
    ...(dim ? { dim: true } : {}),
    ...(underline ? { underline: true } : {})
  }
}

const styleOrUndefined = (st: Style): Style | undefined => (Object.keys(st).length === 0 ? undefined : st)

// ---------------------------------------------------------------------------
// Hooks

export interface Key {
  readonly upArrow: boolean
  readonly downArrow: boolean
  readonly leftArrow: boolean
  readonly rightArrow: boolean
  readonly pageUp: boolean
  readonly pageDown: boolean
  readonly return: boolean
  readonly escape: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly tab: boolean
  readonly backspace: boolean
  readonly delete: boolean
  readonly meta: boolean
}

export type InputHandler = (input: string, key: Key) => void

export interface StdoutLike {
  readonly columns?: number
  readonly rows?: number
  write(chunk: string): unknown
  on?(event: "resize", listener: () => void): unknown
  off?(event: "resize", listener: () => void): unknown
}

interface HookContext {
  readonly inputs: Array<{ readonly handler: InputHandler; readonly isActive: boolean }>
  readonly stdout: StdoutLike
}

let current: HookContext | null = null

const NULL_STDOUT: StdoutLike = { write: () => true }

/** Ink's `useInput`: `handler(input, key)` for every key while the tree is mounted by `render`. */
export const useInput = (handler: InputHandler, options: { readonly isActive?: boolean } = {}): void => {
  current?.inputs.push({ handler, isActive: options.isActive ?? true })
}

/** Ink's `useStdout`. */
export const useStdout = (): { readonly stdout: StdoutLike; readonly write: (data: string) => void } => {
  const stdout = current?.stdout ?? NULL_STDOUT
  return { stdout, write: (data: string) => void stdout.write(data) }
}

/** Decode a raw stdin chunk the way Ink does (the subset the demo uses). */
export const parseKey = (data: string): { readonly input: string; readonly key: Key } => {
  const k = {
    upArrow: data === "\x1b[A",
    downArrow: data === "\x1b[B",
    rightArrow: data === "\x1b[C",
    leftArrow: data === "\x1b[D",
    pageUp: data === "\x1b[5~",
    pageDown: data === "\x1b[6~",
    return: data === "\r",
    escape: data === "\x1b",
    tab: data === "\t",
    backspace: data === "\x7f" || data === "\b",
    delete: data === "\x1b[3~",
    ctrl: data.length === 1 && data.charCodeAt(0) < 0x20 && data !== "\r" && data !== "\t" && data !== "\x1b",
    meta: data.startsWith("\x1b") && data.length === 2,
    shift: data.length === 1 && data >= "A" && data <= "Z"
  }
  const input = k.ctrl ? String.fromCharCode(data.charCodeAt(0) + 0x60) : data.startsWith("\x1b") ? "" : data
  return { input, key: k }
}

// ---------------------------------------------------------------------------
// Layout

const isElement = (n: InkNode): n is InkElement => typeof n === "object" && n !== null && !Array.isArray(n)

/** Children as a flat list (arrays and fragments flattened, `null`/`false`/`true`/`undefined` dropped). */
const flatten = (n: InkNode): InkNode[] => {
  if (n === null || n === undefined || typeof n === "boolean") return []
  if (Array.isArray(n)) return (n as ReadonlyArray<InkNode>).flatMap(flatten)
  return [n]
}

const PRIMITIVES = new Set<Component>([Text, Box, Newline, Spacer])

/** Expand user components until the node is a primitive, a string or a number. */
const expand = (n: InkNode): InkNode[] =>
  flatten(n).flatMap((c) => (isElement(c) && !PRIMITIVES.has(c.type) ? expand(c.type(c.props)) : [c]))

/** Inline runs of a `Text` subtree: lines of segments (a `Newline` starts a new line). */
const inline = (n: InkNode, style: Style): Seg[][] => {
  const lines: Seg[][] = [[]]
  const push = (text: string, st: Style) => {
    const parts = text.split("\n")
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p !== "") lines[lines.length - 1]!.push(s(sanitize(p), styleOrUndefined(st)))
    })
  }
  const walk = (node: InkNode, st: Style) => {
    for (const c of expand(node)) {
      if (typeof c === "string") push(c, st)
      else if (typeof c === "number") push(String(c), st)
      else if (isElement(c)) {
        if (c.type === Text) walk(c.props["children"] as InkNode, textStyle(c.props as TextProps, st))
        else if (c.type === Newline) for (let i = 0; i < ((c.props["count"] as number | undefined) ?? 1); i++) lines.push([])
        else throw new Error("<Box> cannot be nested inside <Text> (as in Ink)")
      }
    }
  }
  walk(n, style)
  return lines
}

const BORDERS: Readonly<Record<BorderStyle, readonly [string, string, string, string, string, string]>> = {
  single: ["┌", "┐", "└", "┘", "─", "│"],
  round: ["╭", "╮", "╰", "╯", "─", "│"],
  double: ["╔", "╗", "╚", "╝", "═", "║"],
  bold: ["┌", "┐", "└", "┘", "─", "│"]
}

const blank = (w: number): Line => (w <= 0 ? [] : [s(" ".repeat(w))])

/** Natural (content) width of a node laid out without a width limit. */
const naturalWidth = (n: InkNode): number => {
  const rows = layoutNode(n, Number.MAX_SAFE_INTEGER / 4, true)
  return rows.reduce((m, l) => Math.max(m, lineWidth(l)), 0)
}

/**
 * Lay out a node at `width` columns. Every returned line is exactly `width`
 * columns wide unless `natural` is set (then lines are not padded).
 */
const layoutNode = (n: InkNode, width: number, natural = false): Line[] => {
  const w = Math.max(0, Math.floor(width))
  const pad = (l: Line): Line => (natural ? truncate(l, w) : fit(l, w))
  const out: Line[] = []
  for (const c of expand(n)) {
    if (typeof c === "string" || typeof c === "number") {
      out.push(...inline(c, {}).map(pad))
    } else if (isElement(c)) {
      if (c.type === Text) out.push(...inline(c, {}).map(pad))
      else if (c.type === Newline) out.push(...Array.from({ length: (c.props["count"] as number | undefined) ?? 1 }, () => pad([])))
      else if (c.type === Spacer) out.push(pad([]))
      else if (c.type === Box) out.push(...layoutBox(c.props as BoxProps, w, natural))
    }
  }
  return out
}

const layoutBox = (p: BoxProps, avail: number, natural: boolean, stretchTo = 0): Line[] => {
  const outer = Math.min(avail, p.width ?? avail)
  const border = p.borderStyle === undefined ? null : BORDERS[p.borderStyle]
  const padL = p.paddingLeft ?? p.paddingX ?? 0
  const padR = p.paddingRight ?? p.paddingX ?? 0
  const inner = Math.max(0, outer - (border ? 2 : 0) - padL - padR)
  const gap = p.gap ?? 0
  const kids = expand(p.children)
  let body: Line[]
  if ((p.flexDirection ?? "row") === "column") {
    body = []
    kids.forEach((k, i) => {
      if (i > 0) for (let g = 0; g < gap; g++) body.push(blank(inner))
      body.push(...layoutNode(k, inner))
    })
  } else {
    body = layoutRow(kids, inner, gap)
  }
  const innerNatural = natural && p.width === undefined && border === null
  // Ink's default `alignItems: stretch`: a row child grows to the row's height.
  const chrome = (border ? 2 : 0) + (p.marginTop ?? 0) + (p.marginBottom ?? 0)
  while (body.length + chrome < stretchTo) body.push(blank(inner))
  const lines = body.map((l) => (innerNatural ? truncate(l, inner) : fit(l, inner)))
  const sideL = blank(padL)
  const sideR = blank(padR)
  let result: Line[]
  if (border === null) {
    result = lines.map((l) => [...sideL, ...l, ...sideR])
  } else {
    const fg = hexOf(p.borderColor)
    const st: Style | undefined = styleOrUndefined({ ...(fg === undefined ? {} : { fg }), ...(p.borderDimColor ? { dim: true } : {}), ...(p.borderStyle === "bold" ? { bold: true } : {}) })
    const [tl, tr, bl, br, h, v] = border
    const span = Math.max(0, outer - 2)
    result = [
      [s(tl + h.repeat(span) + tr, st)],
      ...lines.map((l): Line => [s(v, st), ...sideL, ...l, ...sideR, s(v, st)]),
      [s(bl + h.repeat(span) + br, st)]
    ]
  }
  const top = Array.from({ length: p.marginTop ?? 0 }, () => blank(outer))
  const bottom = Array.from({ length: p.marginBottom ?? 0 }, () => blank(outer))
  return [...top, ...result, ...bottom].map((l) => (natural && p.width === undefined ? l : fit(l, outer)))
}

/** A row: fixed-width boxes keep their width, texts take their natural width, the rest share what is left. */
const layoutRow = (kids: ReadonlyArray<InkNode>, inner: number, gap: number): Line[] => {
  if (kids.length === 0) return []
  const fixed = kids.map((k): number | null => {
    if (isElement(k) && k.type === Box) {
      const bp = k.props as BoxProps
      if (bp.width !== undefined) return bp.width
      return (bp.flexGrow ?? 0) > 0 ? null : null
    }
    if (isElement(k) && k.type === Spacer) return null
    return naturalWidth(k)
  })
  const gaps = gap * (kids.length - 1)
  const used = fixed.reduce<number>((a, b) => a + (b ?? 0), 0)
  const flexible = fixed.filter((f) => f === null).length
  const free = Math.max(0, inner - used - gaps)
  const share = flexible === 0 ? 0 : Math.floor(free / flexible)
  let extra = flexible === 0 ? 0 : free - share * flexible
  const widths = fixed.map((f) => {
    if (f !== null) return f
    const w = share + (extra > 0 ? 1 : 0)
    extra = Math.max(0, extra - 1)
    return w
  })
  const laid = kids.map((k, i) => layoutNode(k, widths[i]!))
  const h = Math.max(...laid.map((c) => c.length))
  const cols = kids.map((k, i) => (isElement(k) && k.type === Box && laid[i]!.length < h ? layoutBox(k.props as BoxProps, widths[i]!, false, h) : laid[i]!))
  return Array.from({ length: h }, (_, row) => {
    const line: Seg[] = []
    cols.forEach((c, i) => {
      if (i > 0 && gap > 0) line.push(s(" ".repeat(gap)))
      line.push(...(c[row] ?? blank(widths[i]!)))
    })
    return line
  })
}

/**
 * Lay out a tree at `columns` columns: every line is exactly `columns`
 * wide. (Extension, like ink-testing-library's `lastFrame()`.)
 */
export const renderToLines = (tree: InkNode, columns: number, stdout: StdoutLike = NULL_STDOUT): Line[] => {
  const saved = current
  current = { inputs: [], stdout }
  try {
    return layoutNode(tree, columns)
  } finally {
    current = saved
  }
}

export const renderToString = (tree: InkNode, columns: number, mode: RenderMode = { color: false }): string =>
  renderToLines(tree, columns).map((l) => renderLine(l, mode)).join("\n")

// ---------------------------------------------------------------------------
// render

export interface StdinLike {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  setEncoding?(enc: "utf8"): unknown
  on(event: "data", listener: (chunk: string) => void): unknown
  off(event: "data", listener: (chunk: string) => void): unknown
  resume?(): unknown
  pause?(): unknown
}

export interface RenderOptions {
  readonly stdout?: StdoutLike
  readonly stdin?: StdinLike
  /** Ink: exit on Ctrl-C (default true). The demo handles Ctrl-C itself. */
  readonly exitOnCtrlC?: boolean
  /** Colour and ASCII mode of the output (shim extension; Ink decides from the terminal). */
  readonly mode?: RenderMode
}

export interface Instance {
  rerender(tree: InkNode): void
  unmount(): void
  waitUntilExit(): Promise<void>
  clear(): void
  /** The lines of the last frame (shim extension). */
  lastFrame(): ReadonlyArray<Line>
}

/**
 * Ink's `render`: draws the tree at the terminal width, redraws on
 * `rerender` and on resize, and delivers keys to `useInput` handlers.
 * Frames are drawn from the top-left corner without clearing (no flicker);
 * a resize clears the screen once.
 */
export const render = (tree: InkNode, options: RenderOptions = {}): Instance => {
  const stdout = options.stdout ?? (process.stdout as unknown as StdoutLike)
  const stdin = options.stdin ?? (process.stdin as unknown as StdinLike)
  const mode = options.mode ?? { color: true }
  let ctx: HookContext = { inputs: [], stdout }
  let last: Line[] = []
  let currentTree = tree
  let mounted = true
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((r) => {
    resolveExit = r
  })
  const draw = () => {
    if (!mounted) return
    const saved = current
    ctx = { inputs: [], stdout }
    current = ctx
    try {
      last = layoutNode(currentTree, stdout.columns ?? 80)
    } finally {
      current = saved
    }
    stdout.write("\x1b[H" + last.map((l) => renderLine(l, mode)).join("\r\n"))
  }
  const onData = (chunk: string) => {
    if (chunk === "\x03" && (options.exitOnCtrlC ?? true)) {
      instance.unmount()
      return
    }
    const { input, key } = parseKey(chunk)
    for (const h of ctx.inputs) if (h.isActive) h.handler(input, key)
  }
  const onResize = () => {
    stdout.write("\x1b[2J")
    draw()
  }
  if (stdin.isTTY === true) stdin.setRawMode?.(true)
  stdin.setEncoding?.("utf8")
  stdin.on("data", onData)
  stdin.resume?.()
  stdout.on?.("resize", onResize)
  const instance: Instance = {
    rerender: (t) => {
      currentTree = t
      draw()
    },
    unmount: () => {
      if (!mounted) return
      mounted = false
      stdin.off("data", onData)
      stdout.off?.("resize", onResize)
      if (stdin.isTTY === true) stdin.setRawMode?.(false)
      stdin.pause?.()
      resolveExit()
    },
    waitUntilExit: () => exited,
    clear: () => void stdout.write("\x1b[2J\x1b[H"),
    lastFrame: () => last
  }
  draw()
  return instance
}
