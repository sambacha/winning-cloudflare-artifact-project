/**
 * Cache-entry manifest (decision D-3).
 *
 * The lookup key names the manifest; the manifest names each output file's
 * blob by content digest and holds all entry metadata (build duration for the
 * restore deadline, encoding). It is written once, create-only, after every
 * blob it names: that single write is the commit point.
 *
 * Paths are validated when parsing: a manifest is data from a writer, and a
 * path such as `../../.bashrc` or `/etc/passwd` must never let a restore write
 * outside its staging directory.
 */
import { Result, Schema } from "../fx/index.js"
import { type Digest, formatDigest, parseDigest } from "./digest.js"

/** True for a relative, normalised, `/`-separated path with no `.`/`..`/empty segments. */
export const isSafeRelativePath = (p: string): boolean => {
  if (p.length === 0 || p.length > 4096) return false
  if (p.includes("\\") || p.includes("\u0000")) return false
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
}

/**
 * True iff no path of the set is a directory of another (`a` and `a/b`): a
 * file and a directory cannot share a name, so such a set can be published
 * but never restored onto a filesystem. Found by the filesystem round-trip
 * law in `test/cache/publishLaws.test.ts`; both `publish` and the manifest
 * decoder reject such sets now.
 */
export const isTreeShaped = (paths: ReadonlyArray<string>): boolean => {
  const set = new Set(paths)
  return paths.every((p) => {
    const segs = p.split("/")
    return segs.slice(0, -1).every((_, i) => !set.has(segs.slice(0, i + 1).join("/")))
  })
}

const DigestString = Schema.String.pipe(
  Schema.check(Schema.makeFilter<string>((s) => parseDigest(s) !== null || "unknown or malformed digest"))
)
const SafePath = Schema.String.pipe(
  Schema.check(Schema.makeFilter<string>((s) => isSafeRelativePath(s) || "unsafe path"))
)
const NonNegInt = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

export const ManifestFile = Schema.Struct({
  path: SafePath,
  blob: DigestString,
  size: NonNegInt,
  encoding: Schema.Literal("identity")
})
export type ManifestFile = typeof ManifestFile.Type

export const CacheManifest = Schema.Struct({
  format: Schema.Literal("rush-cache-manifest"),
  version: Schema.Literal(1),
  lookup: DigestString,
  /** Wall time of the build that produced this entry (the restore deadline uses it, D-11). */
  buildMs: NonNegInt,
  /** Assigned from the writer's clock; informational only (D-6: never used for expiry decisions). */
  createdAt: NonNegInt,
  files: Schema.Array(ManifestFile).pipe(
    Schema.check(
      Schema.makeFilter<ReadonlyArray<ManifestFile>>((fs) => new Set(fs.map((f) => f.path)).size === fs.length || "duplicate path"),
      Schema.makeFilter<ReadonlyArray<ManifestFile>>((fs) => isTreeShaped(fs.map((f) => f.path)) || "a path is both a file and a directory")
    )
  )
})
export type CacheManifest = typeof CacheManifest.Type

const decode = Schema.decodeUnknownResult(Schema.fromJsonString(CacheManifest))

export const encodeManifest = (m: CacheManifest): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(m))

/** Parse a manifest body; any defect is `Left` (and becomes a cache miss). */
export const decodeManifest = (body: Uint8Array): Result.Result<CacheManifest, string> => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch {
    return Result.fail("manifest is not UTF-8")
  }
  return Result.mapError(decode(text), (e) => e.message)
}

export const blobDigestOf = (f: ManifestFile): Digest => parseDigest(f.blob)!

export const makeManifest = (args: {
  readonly lookup: Digest
  readonly buildMs: number
  readonly createdAt: number
  readonly files: ReadonlyArray<{ readonly path: string; readonly blob: Digest; readonly size: number }>
}): CacheManifest => ({
  format: "rush-cache-manifest",
  version: 1,
  lookup: formatDigest(args.lookup),
  buildMs: Math.max(0, Math.round(args.buildMs)),
  createdAt: Math.max(0, Math.round(args.createdAt)),
  files: args.files.map((f) => ({
    path: f.path,
    blob: formatDigest(f.blob),
    size: f.size,
    encoding: "identity" as const
  }))
})
