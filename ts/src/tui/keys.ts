/**
 * Footer controls as a pure mapping from a key press to an action, and the
 * UI-state update for the actions that are purely local. The Ink app
 * (`ink/app.tsx`) performs the remote ones (drive, approve, reject).
 *
 *   [SPACE] trigger  [1-5] panels  [a]pprove  [r]eject  [w]atch  [n]otes  [q]uit
 */
import type { PanelKey, UiState } from "./model.js"

/** What a key does. */
export type KeyAction =
  | { readonly kind: "drive" }
  | { readonly kind: "focus"; readonly panel: PanelKey }
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "watch" }
  | { readonly kind: "notes" }
  | { readonly kind: "quit" }
  | { readonly kind: "none" }

const PANELS: Readonly<Record<string, PanelKey>> = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 }

/**
 * The action for a key press (Ink's `useInput` input string; `ctrlC` for
 * Ctrl-C, which also quits).
 */
export const keyAction = (input: string, ctrlC = false): KeyAction => {
  if (ctrlC) return { kind: "quit" }
  const panel = PANELS[input]
  if (panel !== undefined) return { kind: "focus", panel }
  switch (input) {
    case " ":
      return { kind: "drive" }
    case "a":
      return { kind: "approve" }
    case "r":
      return { kind: "reject" }
    case "w":
      return { kind: "watch" }
    case "n":
      return { kind: "notes" }
    case "q":
      return { kind: "quit" }
    default:
      return { kind: "none" }
  }
}

/** The local part of an action: focus and toggles change the UI state; the rest only set a status message. */
export const applyLocal = (ui: UiState, a: KeyAction): UiState => {
  switch (a.kind) {
    case "focus":
      return { ...ui, focus: a.panel }
    case "watch":
      return { ...ui, watch: !ui.watch, status: ui.watch ? "watch paused" : "watching" }
    case "notes":
      // The note is shown in the bisect panel; focus it so the toggle is visible on small terminals.
      return { ...ui, notes: !ui.notes, focus: 4 }
    case "drive":
      return { ...ui, status: "driving..." }
    case "approve":
      return { ...ui, status: "approving..." }
    case "reject":
      return { ...ui, status: "rejecting..." }
    case "quit":
    case "none":
      return ui
  }
}
