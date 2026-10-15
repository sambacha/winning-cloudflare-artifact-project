/**
 * Node module-loader hook: transpiles `.tsx` files with TypeScript
 * (`jsx: react-jsx`, `jsxImportSource: #ink`) and leaves every other file to
 * Node (which strips the types of `.ts` files itself). Registered by
 * `register.ts`.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { loadTypeScript } from "./typescript.ts"

interface LoadResult {
  readonly format: string
  readonly source?: string | Uint8Array
  readonly shortCircuit?: boolean
}
type NextLoad = (url: string, context: unknown) => Promise<LoadResult>

export const transpileTsx = (source: string, fileName: string): string => {
  const ts = loadTypeScript()
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit["ReactJSX"],
      jsxImportSource: "#ink",
      module: ts.ModuleKind["ESNext"],
      target: ts.ScriptTarget["ES2022"],
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: true
    }
  })
  return out.outputText
}

export async function load(url: string, context: unknown, nextLoad: NextLoad): Promise<LoadResult> {
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const file = fileURLToPath(url)
    return { format: "module", source: transpileTsx(readFileSync(file, "utf8"), file), shortCircuit: true }
  }
  return nextLoad(url, context)
}
