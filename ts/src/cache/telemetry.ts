/**
 * Telemetry split (decision D-14).
 *
 * - Client outcome reports: only the client knows whether a "hit" was
 *   accepted or rejected (digest mismatch, deadline) and rebuilt. Worker-side
 *   metrics cannot tell these apart (`worker_metric_blind`) and overstate the
 *   hit rate (`worker_hit_rate_overstates`).
 * - Unsampled counters for rare events: a 1-in-k sample can show zero for an
 *   event that happened fewer than k times (`sampled_count_zero`).
 * - Billing / exact counts deduplicate by event id, because delivery is
 *   at-least-once: counting deliveries over-counts (`naive_count_overcounts`),
 *   counting distinct ids does not (`idempotent_count_dup`).
 */
import type { MissReason } from "./restore.js"

export type Outcome =
  | { readonly kind: "hit"; readonly restoreMs: number }
  | { readonly kind: "miss"; readonly reason: MissReason | "breaker_open" }

export interface OutcomeReport {
  /** Unique per (job, lookup attempt); used for deduplication. */
  readonly eventId: string
  readonly scope: string
  readonly lookup: string
  readonly outcome: Outcome
}

/** Exactly-once counts over an at-least-once delivery channel. */
export class IdempotentCounter<K extends string> {
  private readonly seen = new Map<string, K>()

  /** Record a delivery; returns `false` for a redelivery (already counted). */
  record(eventId: string, kind: K): boolean {
    if (this.seen.has(eventId)) return false
    this.seen.set(eventId, kind)
    return true
  }

  count(kind: K): number {
    let n = 0
    for (const k of this.seen.values()) if (k === kind) n++
    return n
  }

  get total(): number {
    return this.seen.size
  }
}

/** Hit rate as the jobs experienced it: accepted hits / all attempts. */
export const effectiveHitRate = (reports: ReadonlyArray<OutcomeReport>): number => {
  const unique = new Map(reports.map((r) => [r.eventId, r] as const))
  if (unique.size === 0) return 0
  let hits = 0
  for (const r of unique.values()) if (r.outcome.kind === "hit") hits++
  return hits / unique.size
}
