/** Test-only stand-in for `react` (hooks are not exercised by the tree tests). */
const unsupported = (name: string) => () => {
  throw new Error(`${name} is not available in the test stand-in for react`)
}
export const useState = unsupported("useState")
export const useEffect = unsupported("useEffect")
export const useRef = unsupported("useRef")
export const useCallback = unsupported("useCallback")
export default { useState, useEffect, useRef, useCallback }
