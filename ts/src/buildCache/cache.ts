/**
 * The R2 incremental build cache on the existing blob store
 * (`../cache/blobStore.ts`). It adds no new storage primitive. An entry is two
 * create-only objects written with `BlobStore.putIfNoneMatch` (R2
 * `If-None-Match: *`). This is the same protocol as the `node_modules` cache
 * (`../nodeModules/cache.ts`):
 *
 * ```
 * build-cache/v1/build/<input sha256>/<abi>/<platform>-<arch>/
 *   outputs-<tarball sha256>.tgz   written first
 *   manifest.json                  written last: the commit point
 * ```
 *
 * Read rule: an entry exists only if its manifest exists **and** the tarball
 * it names is present with the digest and size the manifest records. A
 * tarball without a manifest is a partial write and is ignored. A manifest
 * whose tarball is gone is a miss, not an error.
 *
 * Write rule: tarball, then manifest, both create-only. Losing the manifest
 * race means another producer committed the entry first, which counts as success.
 *
 * The tarball is produced the same way as the `node_modules` one
 * (`../nodeModules/ensure.ts`). It is GNU tar with sorted entries, mtime 0 and
 * numeric owner 0, compressed with `gzip -n`, so equal outputs give equal bytes.
 */
import { type BlobStore } from "../cache/blobStore.js"
import { Data, Effect, Option, Schema, Stream } from "../fx/index.js"
import { sha256Hex } from "../nodeModules/key.js"
import { type StoreError, StoreFailure } from "../store.js"
import { buildCacheKey, type BuildCacheKeyInput, buildManifestKey, outputsKey } from "./key.js"

/** The manifest of an entry (JSON body of `manifest.json`). */
export const BuildCacheManifest = Schema.Struct({
  version: Schema.Literal(1),
  /** The entry prefix (`buildCacheKey(...)`); must match where the manifest is stored. */
  key: Schema.String,
  inputSha256: Schema.String,
  abi: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  /** Informational: the compiler that produced the outputs (also hashed into `inputSha256`). */
  toolVersion: Schema.String,
  /** Milliseconds since the epoch (from the Effect clock of the producer). */
  createdAt: Schema.Number,
  tarballSha256: Schema.String,
  tarballBytes: Schema.Number,
  /** Number of files in the tarball. */
  outputs: Schema.Number,
  /** How long the build took; the "time saved" baseline of a later hit. */
  buildMs: Schema.Number
})
export type BuildCacheManifest = typeof BuildCacheManifest.Type

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BuildCacheManifest))

/** A stored object is not what this module wrote (bad JSON, wrong shape, digest or key mismatch). */
export class BuildCacheCorrupt extends Data.TaggedError("BuildCacheCorrupt")<{
  readonly objectKey: string
  readonly reason: string
}> {}

/** Errors of the build cache operations. */
export type BuildCacheError = StoreError | BuildCacheCorrupt

/** Bodies above this are refused when read as JSON (a manifest is well under 1 KiB). */
export const MAX_BUILD_MANIFEST_BYTES = 64 * 1024

const collect = (key: string, store: BlobStore, maxBytes: number): Effect.Effect<Uint8Array | null, StoreFailure | BuildCacheCorrupt> =>
  Effect.gen(function* () {
    const found = yield* store.getStream(key)
    if (Option.isNone(found)) return null
    const chunks: Array<Uint8Array> = []
    let total = 0
    yield* Stream.runForEach(found.value, (chunk) =>
      Effect.suspend(() => {
        total += chunk.byteLength
        if (total > maxBytes) return Effect.fail(new BuildCacheCorrupt({ objectKey: key, reason: `larger than ${maxBytes} bytes` }))
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
 * Read an entry's manifest; `None` when there is no committed entry (an
 * orphan tarball without a manifest is `None` too).
 *
 * @param store - The blob store.
 * @param input - What determines the outputs.
 */
export const lookupBuild = (store: BlobStore, input: BuildCacheKeyInput): Effect.Effect<Option.Option<BuildCacheManifest>, BuildCacheError> =>
  Effect.gen(function* () {
    const entry = buildCacheKey(input)
    const mKey = buildManifestKey(entry)
    const body = yield* collect(mKey, store, MAX_BUILD_MANIFEST_BYTES)
    if (body === null) return Option.none()
    const m = yield* decodeManifestJson(text.decode(body)).pipe(Effect.mapError(() => new BuildCacheCorrupt({ objectKey: mKey, reason: "not a build cache manifest" })))
    if (m.key !== entry || m.inputSha256 !== input.inputSha256 || m.abi !== input.abi || m.platform !== input.platform || m.arch !== input.arch) {
      return yield* Effect.fail(new BuildCacheCorrupt({ objectKey: mKey, reason: "manifest describes a different entry" }))
    }
    return Option.some(m)
  })

/**
 * Download an entry's output tarball and check it against the manifest;
 * `None` if the tarball is gone (a miss, not an error).
 */
export const fetchOutputs = (store: BlobStore, m: BuildCacheManifest): Effect.Effect<Option.Option<Uint8Array>, BuildCacheError> =>
  Effect.gen(function* () {
    const tKey = outputsKey(m.key, m.tarballSha256)
    const body = yield* collect(tKey, store, m.tarballBytes)
    if (body === null) return Option.none()
    const d = yield* digest(body)
    if (d !== m.tarballSha256 || body.byteLength !== m.tarballBytes) {
      return yield* Effect.fail(new BuildCacheCorrupt({ objectKey: tKey, reason: "tarball digest or size does not match the manifest" }))
    }
    return Option.some(body)
  })

/** Result of {@link publishBuild}. */
export type BuildPublishOutcome = "published" | "exists"

/** What a producer knows besides the tarball itself. */
export interface BuildPublishInfo {
  readonly toolVersion: string
  readonly outputs: number
  readonly buildMs: number
  readonly createdAt: number
}

/**
 * Commit an entry: tarball (create-only, named by digest), then manifest
 * (create-only). `exists` when another producer committed it first.
 */
export const publishBuild = (
  store: BlobStore,
  input: BuildCacheKeyInput,
  tarball: Uint8Array,
  info: BuildPublishInfo
): Effect.Effect<{ readonly outcome: BuildPublishOutcome; readonly manifest: BuildCacheManifest }, StoreError> =>
  Effect.gen(function* () {
    const entry = buildCacheKey(input)
    const tarballSha256 = yield* digest(tarball)
    const manifest: BuildCacheManifest = {
      version: 1,
      key: entry,
      ...input,
      toolVersion: info.toolVersion,
      createdAt: info.createdAt,
      tarballSha256,
      tarballBytes: tarball.byteLength,
      outputs: info.outputs,
      buildMs: info.buildMs
    }
    // Same digest = same bytes: a lost race on the tarball is harmless.
    yield* store.putIfNoneMatch(outputsKey(entry, tarballSha256), tarball).pipe(Effect.catchTag("PreconditionFailed", () => Effect.void))
    const outcome = yield* store.putIfNoneMatch(buildManifestKey(entry), utf8.encode(JSON.stringify(manifest))).pipe(
      Effect.as<BuildPublishOutcome>("published"),
      Effect.catchTag("PreconditionFailed", () => Effect.succeed<BuildPublishOutcome>("exists"))
    )
    return { outcome, manifest }
  })

/** The GNU tar arguments that make an output tarball byte-identical for identical outputs (shared with `../nodeModules/ensure.ts`). */
export const deterministicTarArgs = (out: string, dir: string): ReadonlyArray<string> => [
  "tar",
  "--sort=name",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--use-compress-program=gzip -n -1",
  "-cf",
  out,
  dir
]
