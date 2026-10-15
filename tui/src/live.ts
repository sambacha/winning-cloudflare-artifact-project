/**
 * Live lock rows for the dashboard, read from the cobuild state Worker
 * (`ts/src/worker/handler.ts`, `GET /api/locks?context=<ctx>`).
 *
 * This file has no imports, so the TUI stays independent of the lock code:
 * the Worker's JSON shape is restated here and checked at run time, and a
 * contract test on the `ts/` side (`ts/test/worker/tuiContract.test.ts`)
 * feeds this module real Worker responses produced from real lock objects.
 *
 * Time. The dashboard draws lock cards against its own clock `t` (seconds).
 * A live row is placed on that clock relative to the moment of the poll:
 * `expiresAt = t + (expiresAtMs − nowMs) / 1000`, and the same for the last
 * heartbeat, so the countdown and "hb: Ns ago" are exact at the poll and
 * advance with `t` until the next poll.
 */

export type LiveStatus = "building" | "succeeded" | "failed"

export interface LiveLock {
  readonly key: string
  readonly cacheKey: string
  readonly etag: string
  readonly owner: string
  readonly status: LiveStatus
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly leaseExpired: boolean
  readonly buildCacheKey: string | null
  readonly failedAt: number | null
  readonly logKey: string | null
}

export interface LiveLockError {
  readonly key: string
  readonly error: string
}

export interface LiveLocks {
  readonly context: string
  readonly locks: ReadonlyArray<LiveLock | LiveLockError>
  readonly truncated: boolean
}

/** The fields of the dashboard's `Lock` row (structurally identical to `scenario.ts`'s `Lock`). */
export interface LiveRow {
  readonly op: string
  readonly holder: string | null
  readonly state: "BUILDING" | "SUCCEEDED" | "FAILED"
  readonly progress: number
  readonly lastWrite: number | null
  readonly expiresAt: number | null
  readonly etag: string | null
  readonly via: string
  readonly prev: string | null
  readonly result: string | null
  readonly key: string
  readonly live: true
}

export class LiveFormatError extends Error {
  override readonly name = "LiveFormatError"
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k]
  if (typeof v !== "string") throw new LiveFormatError(`field ${k} must be a string`)
  return v
}
const num = (o: Record<string, unknown>, k: string): number => {
  const v = o[k]
  if (typeof v !== "number" || !Number.isFinite(v)) throw new LiveFormatError(`field ${k} must be a finite number`)
  return v
}
const strOrNull = (o: Record<string, unknown>, k: string): string | null => (o[k] === null ? null : str(o, k))
const numOrNull = (o: Record<string, unknown>, k: string): number | null => (o[k] === null ? null : num(o, k))

/** Validate a `GET /api/locks` response body. Throws `LiveFormatError` on any mismatch. */
export const parseLiveLocks = (body: unknown): LiveLocks => {
  if (!isObj(body) || !Array.isArray(body["locks"]) || typeof body["truncated"] !== "boolean") {
    throw new LiveFormatError("expected { context, locks: [...], truncated }")
  }
  const locks = body["locks"].map((l): LiveLock | LiveLockError => {
    if (!isObj(l)) throw new LiveFormatError("lock entry must be an object")
    if (typeof l["error"] === "string") return { key: str(l, "key"), error: l["error"] }
    const status = l["status"]
    if (status !== "building" && status !== "succeeded" && status !== "failed") throw new LiveFormatError("bad status")
    if (typeof l["leaseExpired"] !== "boolean") throw new LiveFormatError("field leaseExpired must be a boolean")
    return {
      key: str(l, "key"),
      cacheKey: str(l, "cacheKey"),
      etag: str(l, "etag"),
      owner: str(l, "owner"),
      status,
      acquiredAt: num(l, "acquiredAt"),
      heartbeatAt: num(l, "heartbeatAt"),
      expiresAt: num(l, "expiresAt"),
      leaseExpired: l["leaseExpired"],
      buildCacheKey: strOrNull(l, "buildCacheKey"),
      failedAt: numOrNull(l, "failedAt"),
      logKey: strOrNull(l, "logKey")
    }
  })
  return { context: str(body, "context"), locks, truncated: body["truncated"] }
}

/**
 * Dashboard rows for the live locks at poll time `nowMs`, placed on the
 * dashboard clock `t` (seconds). Undecodable lock objects are dropped here;
 * `liveErrors` lists them.
 */
export const toLiveRows = (live: LiveLocks, nowMs: number, t: number): ReadonlyArray<LiveRow> =>
  live.locks
    .filter((l): l is LiveLock => !("error" in l))
    .map((l) => {
      const at = (ms: number) => t + (ms - nowMs) / 1000
      const base = {
        op: l.cacheKey,
        holder: l.owner,
        etag: l.etag.replace(/^"|"$/g, ""),
        prev: null,
        key: l.key,
        live: true as const
      }
      switch (l.status) {
        case "building":
          return {
            ...base,
            state: "BUILDING" as const,
            progress: 0,
            lastWrite: at(l.heartbeatAt),
            expiresAt: at(l.expiresAt),
            via: l.leaseExpired ? "lease expired: takeover allowed (If-Match)" : "If-None-Match / If-Match renewals",
            result: null
          }
        case "succeeded":
          return {
            ...base,
            state: "SUCCEEDED" as const,
            progress: 1,
            lastWrite: at(l.heartbeatAt),
            expiresAt: null,
            via: "published (If-Match)",
            result: l.buildCacheKey
          }
        case "failed":
          return {
            ...base,
            state: "FAILED" as const,
            progress: 1,
            lastWrite: at(l.failedAt ?? l.heartbeatAt),
            expiresAt: null,
            via: "failure marker (If-Match)",
            result: l.logKey === null ? "failed (no log)" : `failed, log: ${l.logKey}`
          }
      }
    })

export const liveErrors = (live: LiveLocks): ReadonlyArray<string> =>
  live.locks.flatMap((l) => ("error" in l ? [`${l.key}: ${l.error}`] : []))

/** Replace the scripted lock rows with live ones and mark the state as live. */
export const withLiveLocks = <S extends { readonly locks: ReadonlyArray<unknown> }>(
  state: S,
  rows: ReadonlyArray<LiveRow>
): S & { readonly live: true } => ({ ...state, locks: rows, live: true })

/** Fetch and validate the live locks of one context. */
export const fetchLiveLocks = async (
  workerUrl: string,
  token: string,
  context: string,
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> = fetch
): Promise<LiveLocks> => {
  const url = `${workerUrl.replace(/\/+$/, "")}/api/locks?context=${encodeURIComponent(context)}`
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new LiveFormatError(`Worker answered HTTP ${res.status}`)
  return parseLiveLocks(await res.json())
}
