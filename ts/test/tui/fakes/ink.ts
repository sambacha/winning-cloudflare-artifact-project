/** Test-only stand-in for `ink`: `Box` and `Text` are identity markers laid out by `inkTree.ts`. */
const marker = (name: string) => {
  const f = (): never => {
    throw new Error(`<${name}> must be laid out, not called`)
  }
  Object.defineProperty(f, "name", { value: name })
  return f
}
export const Box = marker("Box")
export const Text = marker("Text")
export const render = marker("render")
export const useInput = marker("useInput")
export const useApp = marker("useApp")
export const useStdout = marker("useStdout")
