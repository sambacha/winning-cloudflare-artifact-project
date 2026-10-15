/**
 * `GET /api/node-modules`: the `node_modules` cache as the dashboard shows it
 * (one row per cache entry, plus session totals), aggregated from the
 * objects the runners wrote (`../nodeModules/cache.ts`):
 *
 * - entries: every `manifest.json` under `nm-cache/v1/npm/`;
 * - restores / installs: every report under `nm-cache/v1/events/`.
 *
 * Read only. Durations stay in milliseconds and sizes in bytes here; the TUI
 * formats them (`../tui/derive.ts`).
 */
import { Effect } from "../fx/index.js"
import { type NodeModulesEvent, type NodeModulesManifest, parseEvent, parseManifest } from "../nodeModules/cache.js"
import { NODE_MODULES_EVENTS_PREFIX, NODE_MODULES_PREFIX } from "../nodeModules/key.js"
import type { R2BucketLike, R2ObjectSummary } from "./r2Bucket.js"

/** One cache entry with its usage. */
export interface NodeModulesEntryView {
  readonly key: string
  readonly lockfileSha256: string
  readonly abi: string
  readonly platform: string
  readonly arch: string
  readonly nodeVersion: string
  readonly tarballBytes: number
  readonly coldInstallMs: number
  readonly createdAt: number
  readonly hits: number
  readonly misses: number
  /** Mean restore time over the hits (`null` without hits). */
  readonly meanRestoreMs: number | null
  /** Sum over the hits of the cold-install time each one avoided. */
  readonly savedMs: number
}

/** The response body. */
export interface NodeModulesView {
  readonly entries: ReadonlyArray<NodeModulesEntryView>
  readonly totals: {
    readonly hits: number
    readonly misses: number
    readonly storedBytes: number
    readonly savedMs: number
    readonly meanRestoreMs: number | null
    readonly meanColdInstallMs: number | null
  }
  /** Reports without a matching entry (expired by the lifecycle rule, or the entry was never committed). */
  readonly orphanEvents: number
  readonly truncated: boolean
}

const mean = (xs: ReadonlyArray<number>): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)

/**
 * Pure aggregation (tested on its own).
 *
 * @param manifests - Decoded manifests.
 * @param events - Decoded reports.
 * @param truncated - Whether a listing was cut short.
 */
export const aggregateNodeModules = (manifests: ReadonlyArray<NodeModulesManifest>, events: ReadonlyArray<NodeModulesEvent>, truncated: boolean): NodeModulesView => {
  const byKey = new Map(manifests.map((m) => [m.key, m]))
  const entries = [...byKey.values()]
    .sort((a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1))
    .map((m): NodeModulesEntryView => {
      const mine = events.filter((e) => e.key === m.key)
      const hits = mine.filter((e) => e.outcome === "hit")
      return {
        key: m.key,
        lockfileSha256: m.lockfileSha256,
        abi: m.abi,
        platform: m.platform,
        arch: m.arch,
        nodeVersion: m.nodeVersion,
        tarballBytes: m.tarballBytes,
        coldInstallMs: m.coldInstallMs,
        createdAt: m.createdAt,
        hits: hits.length,
        misses: mine.length - hits.length,
        meanRestoreMs: mean(hits.map((e) => e.durationMs)),
        savedMs: hits.reduce((s, e) => s + Math.max(0, e.avoidedMs - e.durationMs), 0)
      }
    })
  const known = events.filter((e) => byKey.has(e.key))
  const hits = known.filter((e) => e.outcome === "hit")
  return {
    entries,
    totals: {
      hits: hits.length,
      misses: known.length - hits.length,
      storedBytes: entries.reduce((s, e) => s + e.tarballBytes, 0),
      savedMs: entries.reduce((s, e) => s + e.savedMs, 0),
      meanRestoreMs: mean(hits.map((e) => e.durationMs)),
      meanColdInstallMs: mean(entries.map((e) => e.coldInstallMs))
    },
    orphanEvents: events.length - known.length,
    truncated
  }
}

/**
 * Read and aggregate the cache from the bucket.
 *
 * @param bucket - The R2 binding (read only).
 * @param listAll - Paged listing (the handler's `listAll`).
 * @param mapBounded - Bounded-concurrency map (the handler's `mapBounded`).
 * @param max - Listing cap per prefix.
 */
export const loadNodeModulesView = async (
  bucket: R2BucketLike,
  listAll: (b: R2BucketLike, prefix: string, max: number) => Promise<{ objects: Array<R2ObjectSummary>; truncated: boolean }>,
  mapBounded: <A, B>(xs: ReadonlyArray<A>, limit: number, f: (a: A) => Promise<B>) => Promise<Array<B>>,
  max: number
): Promise<NodeModulesView> => {
  const entryObjects = await listAll(bucket, NODE_MODULES_PREFIX, max)
  const eventObjects = await listAll(bucket, NODE_MODULES_EVENTS_PREFIX, max)
  const text = async (key: string) => {
    const o = await bucket.get(key)
    return o === null ? null : o.text()
  }
  const manifests = await mapBounded(
    entryObjects.objects.filter((o) => o.key.endsWith("/manifest.json")),
    16,
    async (o) => {
      const t = await text(o.key)
      const m = t === null ? null : await Effect.runPromise(parseManifest(t))
      // A manifest is trusted only where it says it lives.
      return m !== null && `${m.key}/manifest.json` === o.key ? m : null
    }
  )
  const events = await mapBounded(eventObjects.objects, 16, async (o) => {
    const t = await text(o.key)
    return t === null ? null : Effect.runPromise(parseEvent(t))
  })
  return aggregateNodeModules(
    manifests.filter((m): m is NodeModulesManifest => m !== null),
    events.filter((e): e is NodeModulesEvent => e !== null),
    entryObjects.truncated || eventObjects.truncated
  )
}
