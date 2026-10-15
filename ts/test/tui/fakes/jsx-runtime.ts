/**
 * Test-only stand-in for `react/jsx-runtime` (used only when React is not
 * installed; see `vitest.config.ts`): elements are plain `{ type, props, key }`
 * objects, which `inkTree.ts` lays out.
 */
export const Fragment = Symbol.for("test.fragment")
export const jsx = (type: unknown, props: unknown, key?: string) => ({ type, props, key: key ?? null })
export const jsxs = jsx
export const jsxDEV = jsx
