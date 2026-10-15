/**
 * Minimal declarations of `react`, `react/jsx-runtime` and `ink` (the subset
 * the dashboard uses), so `src/tui/ink` type-checks in this repository,
 * where neither package is installed and there is no network.
 *
 * **Unverified against the real packages.** After `npm install` (the final
 * commit adds `ink` and `react` to `package.json`), TypeScript resolves the
 * real packages' types first (an ambient `declare module` is only used when
 * no file resolves) and this file becomes inert; delete it then. Prop names
 * follow the Ink README: `Box` (`flexDirection`, `width`, `height`), `Text`
 * (`color`, `dimColor`, `bold`, `wrap`), `render`, `useInput`, `useApp`,
 * `useStdout`.
 */
declare module "react" {
  export interface ReactElement {
    readonly type: unknown
    readonly props: unknown
    readonly key: string | null
  }
  export type ReactNode = ReactElement | string | number | boolean | null | undefined | ReadonlyArray<ReactNode>
  export type Dispatch<A> = (value: A) => void
  export type SetStateAction<S> = S | ((prev: S) => S)
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>]
  export function useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void
  export function useRef<T>(initial: T): { current: T }
  export function useCallback<F extends (...args: never[]) => unknown>(f: F, deps: ReadonlyArray<unknown>): F
}

declare module "react/jsx-runtime" {
  import type { ReactElement, ReactNode } from "react"
  export namespace JSX {
    type Element = ReactElement
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface IntrinsicElements {}
    interface IntrinsicAttributes {
      readonly key?: string | number
    }
    interface ElementChildrenAttribute {
      readonly children: unknown
    }
  }
  export const Fragment: unique symbol
  export function jsx(type: unknown, props: unknown, key?: string): ReactElement
  export function jsxs(type: unknown, props: unknown, key?: string): ReactElement
  export type { ReactNode }
}

declare module "ink" {
  import type { ReactElement, ReactNode } from "react"
  export type Color = string
  export interface BoxProps {
    readonly flexDirection?: "row" | "column"
    readonly width?: number
    readonly height?: number
    readonly children?: ReactNode
  }
  export interface TextProps {
    readonly color?: Color
    readonly dimColor?: boolean
    readonly bold?: boolean
    readonly wrap?: "wrap" | "truncate" | "truncate-end"
    readonly children?: ReactNode
  }
  export function Box(props: BoxProps): ReactElement
  export function Text(props: TextProps): ReactElement
  export interface Key {
    readonly ctrl: boolean
    readonly escape: boolean
  }
  export function useInput(handler: (input: string, key: Key) => void, options?: { readonly isActive?: boolean }): void
  export function useApp(): { exit: (error?: Error) => void }
  export function useStdout(): { stdout: NodeJS.WriteStream }
  export interface Instance {
    waitUntilExit(): Promise<void>
    unmount(): void
  }
  export function render(tree: ReactElement, options?: { readonly exitOnCtrlC?: boolean }): Instance
}
