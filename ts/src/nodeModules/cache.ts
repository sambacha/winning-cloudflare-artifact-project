/**
 * The `node_modules` cache on the existing blob store (`../cache/blobStore.ts`).
 *
 * No new storage primitive: an entry is two create-only objects written with
 * `BlobStore.putIfNoneMatch` (R2 `If-None-Match: *`) and read with
 * `BlobStore.getStream`.
 *
 * ```
 * nm-cache/v1/npm/<lockfile sha256>/<abi>/<platform>-<arch>/
 *   node_modules-<tarball sha256>.tgz   written first
 *   manifest.json                       written last: the commit point
 * ```
 *
 * Read rule: an entry exists only if its manifest exists **and** the tarball
 * it names is present with the digest the manifest records. A tarball without
 * a manifest is a partial write and is never trusted; a manifest whose
 * tarball is gone (expired by the lifecycle rule first) is a miss.
 *
 * Write rule: tarball, then manifest, both create-only. Losing the manifest
 * race means another producer committed the entry first, which is a success.
 *
 * Every report of a restore or an install (`NodeModulesEvent`) is stored
 * create-only under its own run id, so concurrent runners never contend for
 * one key (R2 allows one write per key per second).
 */
import { type BlobStore } from "../cache/blobStore.js"
import { Data, Effect, Option, Schema, Stream } from "../fx/index.js"
import { type StoreError, StoreFailure } from "../store.js"
import { manifestKey, NODE_MODULES_EVENTS_PREFIX, nodeModulesKey, type NodeModulesKeyInput, sha256Hex, tarballKey } from "./key.js"

/** The manifest of an entry (JSON body of `manifest.json`). */
export const NodeModulesManifest = Schema.Struct({
  version: Schema.Literal(1),
  /** The entry prefix (`nodeModulesKey(...)`); must match where the manifest is stored. */
  key: Schema.String,
  lockfileSha256: Schema.String,
  abi: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  /** Informational: the exact versions that produced the tree. */
  nodeVersion: Schema.String,
  npmVersion: Schema.String,
  /** Milliseconds since the epoch (from the Effect clock of the producer). */
  createdAt: Schema.Number,
  tarballSha256: Schema.String,
  tarballBytes: Schema.Number,
  /** SHA-256 of `node_modules/.package-lock.json`: checked after extraction. */
  installedLockSha256: Schema.String,
  /** How long the cold `npm ci` took; the dashboard's "seconds saved" baseline. */
  coldInstallMs: Schema.Number
})
export type NodeModulesManifest = typeof NodeModulesManifest.Type

/** One restore or install, as reported by a runner. */
export const NodeModulesEvent = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  key: Schema.String,
  outcome: Schema.Literals(["hit", "miss"]),
  /** Hit: download + verify + extract. Miss: the cold install. */
  durationMs: Schema.Number,
  /** Hit: the manifest's cold-install time (what the hit avoided). Miss: 0. */
  avoidedMs: Schema.Number,
  tarballBytes: Schema.Number,
  at: Schema.Number
})
export type NodeModulesEvent = typeof NodeModulesEvent.Type

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NodeModulesManifest))
const decodeEventJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NodeModulesEvent))

/** A stored object is not what this module wrote (bad JSON, wrong shape, digest or key mismatch). */
export class NodeModulesCacheCorrupt extends Data.TaggedError("NodeModulesCacheCorrupt")<{
  readonly objectKey: string
  readonly reason: string
}> {}

/** Errors of the cache operations. */
export type NodeModulesCacheError = StoreError | NodeModulesCacheCorrupt

/** Bodies above this are refused when read as JSON (a manifest is well under 1 KiB). */
export const MAX_MANIFEST_BYTES = 64 * 1024

const collect = (key: string, store: BlobStore, maxBytes: number): Effect.Effect<Uint8Array | null, StoreFailure | NodeModulesCacheCorrupt> =>
  Effect.gen(function* () {
    const found = yield* store.getStream(key)
    if (Option.isNone(found)) return null
    const chunks: Array<Uint8Array> = []
    let total = 0
    yield* Stream.runForEach(found.value, (chunk) =>
      Effect.suspend(() => {
        total += chunk.byteLength
        if (total > maxBytes) return Effect.fail(new NodeModulesCacheCorrupt({ objectKey: key, reason: `larger than ${maxBytes} bytes` }))
        chunks.push(chunk)
        return Effect.void
      })
    )
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
  })

const digest = (bytes: Uint8Array) => Effect.promise(() => sha256Hex(bytes))

const text = new TextDecoder()
const utf8 = new TextEncoder()

/**
 * Read an entry's manifest; `None` when there is no committed entry.
 *
 * @param store - The blob store.
 * @param input - What determines the tree.
 */
export const lookupManifest = (
  store: BlobStore,
  input: NodeModulesKeyInput
): Effect.Effect<Option.Option<NodeModulesManifest>, NodeModulesCacheError> =>
  Effect.gen(function* () {
    const entry = nodeModulesKey(input)
    const mKey = manifestKey(entry)
    const body = yield* collect(mKey, store, MAX_MANIFEST_BYTES)
    if (body === null) return Option.none()
    const m = yield* decodeManifestJson(text.decode(body)).pipe(
      Effect.mapError(() => new NodeModulesCacheCorrupt({ objectKey: mKey, reason: "not a node_modules manifest" }))
    )
    if (m.key !== entry || m.lockfileSha256 !== input.lockfileSha256 || m.abi !== input.abi || m.platform !== input.platform || m.arch !== input.arch) {
      return yield* Effect.fail(new NodeModulesCacheCorrupt({ objectKey: mKey, reason: "manifest describes a different entry" }))
    }
    return Option.some(m)
  })

/**
 * Download an entry's tarball and check it against the manifest; `None` if the
 * tarball is gone (a miss, not an error).
 *
 * @param store - The blob store.
 * @param m - The committed manifest.
 * @param maxBytes - Refuse bodies larger than this (defaults to the manifest's size).
 */
export const fetchTarball = (
  store: BlobStore,
  m: NodeModulesManifest,
  maxBytes: number = m.tarballBytes
): Effect.Effect<Option.Option<Uint8Array>, NodeModulesCacheError> =>
  Effect.gen(function* () {
    const tKey = tarballKey(m.key, m.tarballSha256)
    const body = yield* collect(tKey, store, maxBytes)
    if (body === null) return Option.none()
    const d = yield* digest(body)
    if (d !== m.tarballSha256 || body.byteLength !== m.tarballBytes) {
      return yield* Effect.fail(new NodeModulesCacheCorrupt({ objectKey: tKey, reason: "tarball digest or size does not match the manifest" }))
    }
    return Option.some(body)
  })

/** Result of {@link publishEntry}. */
export type PublishOutcome = "published" | "exists"

/** What a producer knows besides the tarball itself. */
export interface PublishInfo {
  readonly nodeVersion: string
  readonly npmVersion: string
  readonly installedLockSha256: string
  readonly coldInstallMs: number
  readonly createdAt: number
}

/**
 * Commit an entry: tarball (create-only, named by digest), then manifest
 * (create-only). `exists` when another producer committed it first.
 *
 * @param store - The blob store.
 * @param input - What determines the tree.
 * @param tarball - The deterministic tarball bytes.
 * @param info - Versions, timings and the installed-lock digest.
 * @returns The outcome and the manifest that was (or would have been) written.
 */
export const publishEntry = (
  store: BlobStore,
  input: NodeModulesKeyInput,
  tarball: Uint8Array,
  info: PublishInfo
): Effect.Effect<{ readonly outcome: PublishOutcome; readonly manifest: NodeModulesManifest }, StoreError> =>
  Effect.gen(function* () {
    const entry = nodeModulesKey(input)
    const tarballSha256 = yield* digest(tarball)
    const manifest: NodeModulesManifest = {
      version: 1,
      key: entry,
      ...input,
      nodeVersion: info.nodeVersion,
      npmVersion: info.npmVersion,
      createdAt: info.createdAt,
      tarballSha256,
      tarballBytes: tarball.byteLength,
      installedLockSha256: info.installedLockSha256,
      coldInstallMs: info.coldInstallMs
    }
    // Same digest = same bytes: a lost race on the tarball is harmless.
    yield* store.putIfNoneMatch(tarballKey(entry, tarballSha256), tarball).pipe(Effect.catchTag("PreconditionFailed", () => Effect.void))
    const outcome = yield* store.putIfNoneMatch(manifestKey(entry), utf8.encode(JSON.stringify(manifest))).pipe(
      Effect.as<PublishOutcome>("published"),
      Effect.catchTag("PreconditionFailed", () => Effect.succeed<PublishOutcome>("exists"))
    )
    return { outcome, manifest }
  })

/** Object key of a run's report. */
export const eventKey = (runId: string): string => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new RangeError("runId must be 1-128 characters of [A-Za-z0-9._-]")
  return `${NODE_MODULES_EVENTS_PREFIX}${runId}.json`
}

/** Store a run's report (create-only; a repeated report for the same run is ignored). */
export const recordEvent = (store: BlobStore, e: NodeModulesEvent): Effect.Effect<void, StoreError> =>
  store.putIfNoneMatch(eventKey(e.runId), utf8.encode(JSON.stringify(e))).pipe(Effect.catchTag("PreconditionFailed", () => Effect.void))

/** Decode a report body; `null` if it is not one (the dashboard skips it). */
export const parseEvent = (body: string): Effect.Effect<NodeModulesEvent | null> =>
  decodeEventJson(body).pipe(Effect.catch(() => Effect.succeed(null)))

/** Decode a manifest body; `null` if it is not one. */
export const parseManifest = (body: string): Effect.Effect<NodeModulesManifest | null> =>
  decodeManifestJson(body).pipe(Effect.catch(() => Effect.succeed(null)))
