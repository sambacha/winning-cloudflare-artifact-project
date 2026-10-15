/**
 * Every number the dashboard displays comes from a function here, as a
 * {@link Quantity}: the value, its unit, and the text shown. Pure (no clock,
 * no I/O): the current time is always an argument.
 */
import { BAR_CELLS, BYTES_PER_KIB, DECIMALS, LN2, MINUTES_PER_HOUR, MS_PER_SECOND, PERCENT, PRICES, PULSE_FRESH_MS, SECONDS_PER_MINUTE } from "./constants.js"

/** A displayed figure. */
export interface Quantity {
  readonly value: number
  readonly unit: string
  readonly text: string
}

const q = (value: number, unit: string, text: string): Quantity => ({ value, unit, text })
const finite = (x: number): number => (Number.isFinite(x) ? x : 0)

/** A count with its unit (`12 hits`). */
export const count = (n: number, unit: string): Quantity => q(Math.max(0, Math.round(finite(n))), unit, `${Math.max(0, Math.round(finite(n)))} ${unit}`)

/** Milliseconds as seconds (`1.8 s`). */
export const seconds = (ms: number): Quantity => {
  const s = finite(ms) / MS_PER_SECOND
  return q(s, "s", `${s.toFixed(DECIMALS.seconds)} s`)
}

/** A duration that reads well at any scale: `42.3 s`, `9 min 27 s`, `2 h 05 min`. */
export const duration = (ms: number): Quantity => {
  const total = Math.max(0, finite(ms)) / MS_PER_SECOND
  if (total < SECONDS_PER_MINUTE) return q(total, "s", `${total.toFixed(DECIMALS.seconds)} s`)
  const mins = Math.floor(total / SECONDS_PER_MINUTE)
  if (mins < MINUTES_PER_HOUR) return q(total, "s", `${mins} min ${String(Math.floor(total - mins * SECONDS_PER_MINUTE)).padStart(2, "0")} s`)
  const h = Math.floor(mins / MINUTES_PER_HOUR)
  return q(total, "s", `${h} h ${String(mins - h * MINUTES_PER_HOUR).padStart(2, "0")} min`)
}

/** Seconds left until `deadline` (never negative): a lease countdown. */
export const countdown = (deadlineMs: number, nowMs: number): Quantity => {
  const s = Math.max(0, Math.ceil((finite(deadlineMs) - finite(nowMs)) / MS_PER_SECOND))
  return q(s, "s", `${s} s`)
}

/** Age of a timestamp (`12 s ago`). */
export const age = (thenMs: number, nowMs: number): Quantity => {
  const s = Math.max(0, Math.floor((finite(nowMs) - finite(thenMs)) / MS_PER_SECOND))
  return q(s, "s", `${duration(s * MS_PER_SECOND).text} ago`)
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const

/** Bytes in binary units (`148.0 MiB`). */
export const bytes = (n: number): Quantity => {
  let v = Math.max(0, finite(n))
  let i = 0
  while (v >= BYTES_PER_KIB && i < BYTE_UNITS.length - 1) {
    v /= BYTES_PER_KIB
    i++
  }
  const unit = BYTE_UNITS[i]!
  return q(v, unit, i === 0 ? `${Math.round(v)} ${unit}` : `${v.toFixed(DECIMALS.bytes)} ${unit}`)
}

/** A ratio in [0, 1] as a percentage (`82.6 %`). */
export const percent = (ratio: number): Quantity => {
  const p = Math.max(0, Math.min(1, finite(ratio))) * PERCENT
  return q(p, "%", `${p.toFixed(DECIMALS.percent)} %`)
}

/** A posterior probability (`96.1 %`). */
export const probability = (p: number): Quantity => percent(p)

/** Entropy given in nats, shown in bits (`3.21 bit`). */
export const entropyBits = (nats: number): Quantity => {
  const b = finite(nats) / LN2
  return q(b, "bit", `${b.toFixed(DECIMALS.bits)} bit`)
}

/** Change of entropy since the previous status (`-0.84 bit`); `null` without a previous one. */
export const entropyDelta = (nats: number, previousNats: number | null): Quantity | null => {
  if (previousNats === null) return null
  const d = (finite(nats) - finite(previousNats)) / LN2
  return q(d, "bit", `${d >= 0 ? "+" : ""}${d.toFixed(DECIMALS.bits)} bit`)
}

/** US dollars (`$0.0042`). */
export const usd = (x: number): Quantity => q(finite(x), "USD", `$${finite(x).toFixed(DECIMALS.usd)}`)

/** Hit rate: hits / (hits + misses); 0 when there were none. */
export const hitRate = (hits: number, misses: number): Quantity => percent(hits + misses === 0 ? 0 : hits / (hits + misses))

/** Filled cells of a PhaseBar for a fraction: clamped to [0, BAR_CELLS]. */
export const barFill = (fraction: number, cells: number = BAR_CELLS): number => Math.max(0, Math.min(cells, Math.round(finite(fraction) * cells)))

/** A PhaseBar: `#` filled, `.` empty, exactly `cells` wide. */
export const bar = (fraction: number, cells: number = BAR_CELLS): string => {
  const filled = Math.max(0, Math.min(BAR_CELLS, barFill(fraction, cells)))
  return "#".repeat(Math.min(filled, cells)) + ".".repeat(Math.max(0, cells - Math.min(filled, cells)))
}

/**
 * Beta-Bernoulli pseudo-counts of one commit from its observation tally
 * (display only): alpha = 1 + failures, beta = 1 + passes; the bar shows the
 * posterior mean failure rate alpha / (alpha + beta).
 */
export const alphaBeta = (fails: number, passes: number): { readonly alpha: Quantity; readonly beta: Quantity; readonly failMean: Quantity } => {
  const a = 1 + Math.max(0, finite(fails))
  const b = 1 + Math.max(0, finite(passes))
  return { alpha: q(a, "a", `a=${a}`), beta: q(b, "b", `b=${b}`), failMean: percent(a / (a + b)) }
}

/** Does a heartbeat pulse now? (fresh heartbeat; blinks with the second). */
export const pulseOn = (heartbeatAtMs: number, nowMs: number): boolean =>
  finite(nowMs) - finite(heartbeatAtMs) < PULSE_FRESH_MS && Math.floor(finite(nowMs) / MS_PER_SECOND) % 2 === 0

/** Inputs of the cost comparison. */
export interface CostInputs {
  /** R2 writes (Class A) and reads (Class B) made by the session. */
  readonly r2ClassA: number
  readonly r2ClassB: number
  /** Bytes stored in R2 (node_modules cache + sessions + manifests). */
  readonly r2StoredBytes: number
  /** Minutes a GitHub Actions job would have spent: every bisect step with a cold `npm ci` + the predicate. */
  readonly ghaMinutes: number
}

/** The cost panel's figures. */
export interface CostView {
  readonly r2Ops: Quantity
  readonly r2Storage: Quantity
  readonly r2Total: Quantity
  readonly gha: Quantity
  readonly savings: Quantity
  readonly ghaMinutes: Quantity
}

/**
 * R2 cost of the session (operations, plus one month of storage) against
 * GitHub Actions minutes for the same work.
 */
export const costView = (c: CostInputs): CostView => {
  const ops = (finite(c.r2ClassA) * PRICES.r2ClassAPerMillion + finite(c.r2ClassB) * PRICES.r2ClassBPerMillion) / PRICES.perMillion
  const gib = Math.max(0, finite(c.r2StoredBytes)) / (BYTES_PER_KIB * BYTES_PER_KIB * BYTES_PER_KIB)
  const storage = gib * PRICES.r2StoragePerGbMonth
  const r2 = ops + storage
  const gha = Math.max(0, finite(c.ghaMinutes)) * PRICES.ghaPerMinute
  return {
    r2Ops: usd(ops),
    r2Storage: usd(storage),
    r2Total: usd(r2),
    gha: usd(gha),
    savings: percent(gha <= 0 ? 0 : (gha - r2) / gha),
    ghaMinutes: q(finite(c.ghaMinutes), "min", `${finite(c.ghaMinutes).toFixed(DECIMALS.seconds)} min`)
  }
}

/** `HH:MM:SS` (UTC) of a timestamp: event-stream clock column. */
export const clock = (ms: number): Quantity => {
  const d = new Date(finite(ms))
  const pad = (n: number) => String(n).padStart(2, "0")
  return q(finite(ms), "ms", `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`)
}
