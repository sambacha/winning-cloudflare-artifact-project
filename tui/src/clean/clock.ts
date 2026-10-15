/**
 * The status-bar clock of the clean scenario.
 *
 * `--fixed-time <iso8601>` pins it. With the flag, every frame of every run
 * shows the same timestamp (the clock does not advance), so two runs diff to
 * empty. Without it the clock is the wall time at launch plus the script
 * time, and two runs differ.
 *
 * This is the dashboard's equivalent of overriding `Clock.currentTimeMillis`.
 * The dashboard is dependency-free and does not use Effect, so the override is
 * a value passed down from `main.ts`, not a Layer.
 */

/** Parse `--fixed-time`. Throws on anything that is not a valid ISO 8601 date-time. */
export const parseFixedTime = (iso: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`--fixed-time expects an ISO 8601 date-time such as 2026-10-14T12:00:00Z, got ${JSON.stringify(iso)}`)
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error(`--fixed-time: ${JSON.stringify(iso)} is not a valid date-time`)
  return ms
}

export type ClockSource = { readonly kind: "fixed"; readonly ms: number } | { readonly kind: "wall"; readonly startMs: number }

/** The current time in ms since the epoch at script time `t` (seconds). */
export const currentTimeMillis = (c: ClockSource, t: number): number => (c.kind === "fixed" ? c.ms : c.startMs + Math.floor(Math.max(0, t)) * 1000)

/** The status-bar label: ISO 8601 in UTC, whole seconds, `Z` suffix. */
export const clockLabel = (c: ClockSource, t: number): string => new Date(currentTimeMillis(c, t)).toISOString().replace(/\.\d{3}Z$/, "Z")
