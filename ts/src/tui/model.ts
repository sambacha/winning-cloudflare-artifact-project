/**
 * What the dashboard draws: the responses of the Worker's read routes, as
 * they arrive (live mode, `live.ts`) or as the snapshot scenario produces
 * them (`scenario.ts`). The dashboard computes no posterior: the bisect
 * status (ranking, confidence, entropy, next commit) is the status route's
 * body.
 */
import type { StatusBody } from "../worker/bisectRoutes.js"
import type { NodeModulesView } from "../worker/nodeModulesView.js"
import type { BisectResultManifest } from "../worker/resultStore.js"
import type { CostInputs } from "./derive.js"

/** One Artifacts repository row. */
export interface RepoRow {
  readonly name: string
  readonly status: "ok" | "error"
  /** Newest first-parent commit (`/api/artifacts`): id and time. */
  readonly head: string | null
  readonly headAt: number | null
  readonly detail: string
}

/** One operation lease (`/api/locks` lock view, the fields shown). */
export interface LeaseRow {
  readonly cacheKey: string
  readonly owner: string
  readonly status: "building" | "succeeded" | "failed"
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly leaseExpired: boolean
}

/** Event-stream kinds (colour-coded). */
export type EventKind = "push" | "lease" | "cache" | "bisect" | "review" | "error" | "info"

/** One event-stream row. */
export interface DashEvent {
  readonly at: number
  readonly kind: EventKind
  readonly text: string
}

/** Everything one frame shows. */
export interface DashboardInput {
  /** Current time (ms): from the injected clock, or the scenario's. */
  readonly now: number
  readonly title: string
  readonly repos: ReadonlyArray<RepoRow>
  readonly nodeModules: NodeModulesView | null
  readonly leases: ReadonlyArray<LeaseRow>
  readonly bisect: {
    readonly body: StatusBody
    /** Entropy (nats) of the previous status seen, for the delta. */
    readonly previousEntropy: number | null
    readonly result: BisectResultManifest | null
  } | null
  readonly cost: CostInputs
  readonly events: ReadonlyArray<DashEvent>
}

/** Panels selectable with the number keys. */
export type PanelKey = 1 | 2 | 3 | 4 | 5

/** UI state (keys, toggles). */
export interface UiState {
  readonly focus: PanelKey
  readonly watch: boolean
  readonly notes: boolean
  /** Last action message for the footer (e.g. "approved"). */
  readonly status: string
}

export const initialUi: UiState = { focus: 4, watch: true, notes: false, status: "" }
