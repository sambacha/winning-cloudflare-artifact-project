/**
 * Locate the TypeScript compiler, which is needed only to transpile the
 * `.tsx` panel components at load time (Node strips types from `.ts` files
 * itself, but does not support JSX). Order: `tui/node_modules/typescript`
 * (the `typescript` devDependency, after `pnpm install`), then the copy
 * installed for `ts/` in this repository.
 */
import { createRequire } from "node:module"

/** The subset of the TypeScript compiler API used here and by the lint tests. */
export interface TsNode {
  readonly kind: number
  readonly parent?: TsNode
  getText(sourceFile?: TsSourceFile): string
  getStart(sourceFile?: TsSourceFile): number
}
export interface TsSourceFile extends TsNode {
  getLineAndCharacterOfPosition(pos: number): { readonly line: number; readonly character: number }
}
export interface TS {
  readonly version: string
  transpileModule(source: string, options: { readonly fileName: string; readonly compilerOptions: Readonly<Record<string, unknown>> }): { readonly outputText: string }
  createSourceFile(fileName: string, text: string, target: number, setParentNodes: boolean, kind: number): TsSourceFile
  forEachChild(node: TsNode, cb: (child: TsNode) => void): void
  readonly SyntaxKind: Readonly<Record<string, number>>
  readonly ScriptTarget: Readonly<Record<string, number>>
  readonly ScriptKind: Readonly<Record<string, number>>
  readonly JsxEmit: Readonly<Record<string, number>>
  readonly ModuleKind: Readonly<Record<string, number>>
}

let cached: TS | null = null

export const loadTypeScript = (): TS => {
  if (cached !== null) return cached
  const fromTui = createRequire(new URL("../../package.json", import.meta.url))
  const fromRepo = createRequire(new URL("../../../ts/package.json", import.meta.url))
  const errors: string[] = []
  for (const req of [fromTui, fromRepo]) {
    try {
      cached = req("typescript") as TS
      return cached
    } catch (e) {
      errors.push((e as Error).message.split("\n")[0]!)
    }
  }
  throw new Error(`TypeScript is needed to load the .tsx panels; run \`pnpm install\` in tui/ (or ts/). ${errors.join("; ")}`)
}
