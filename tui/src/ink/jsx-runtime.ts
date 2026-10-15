/**
 * JSX runtime of the Ink-shaped shim (`tsconfig.json`: `"jsx": "react-jsx"`,
 * `"jsxImportSource": "#ink"`; `package.json` maps `#ink/jsx-runtime` here).
 * Elements are plain data; `./index.ts` lays them out.
 */
import type { InkElement, InkNode } from "./types.ts"

export type { InkElement, InkNode }

export const jsx = (type: InkElement["type"], props: Record<string, unknown>, key?: string): InkElement => ({ type, props, key: key ?? null })
export const jsxs = jsx
export const jsxDEV = jsx

/** `<>…</>`: its children, in order. */
export const Fragment = (props: { readonly children?: InkNode }): InkNode => props.children ?? null

export declare namespace JSX {
  type Element = InkElement
  interface ElementClass {
    readonly never: never
  }
  interface IntrinsicElements {}
  interface ElementChildrenAttribute {
    children: {}
  }
}
