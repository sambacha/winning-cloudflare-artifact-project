/**
 * The R2 key of a cached incremental-build output set.
 *
 * ```
 * build-cache/v1/build/<sha256(sources + toolVersion)>/<abi>/<platform>-<arch>/
 *   outputs-<tarball sha256>.tgz   written first
 *   manifest.json                  written last: the commit point
 * ```
 *
 * | input | why |
 * |---|---|
 * | `sha256(sources + toolVersion)` | different sources or a different compiler give different outputs |
 * | Node ABI (`process.versions.modules`) | the same rule as the `node_modules` cache: a patch release keeps it |
 * | `process.platform`-`process.arch` | emitted native artefacts differ |
 * | `v1` | the cache format; bumping it invalidates every entry |
 *
 * The prefix is `build-cache/`, never a bare `v1/build/`: `v1/<scope>/`
 * belongs to the cobuild lease locks and the BLAKE3 cache
 * (`../cache/scope.ts`), and a lifecycle rule on `v1/build/` would expire the
 * lock objects of a scope named `build` (`../nodeModules/key.ts` makes the
 * same choice with `nm-cache/`).
 *
 * Build outputs live in R2, never in Artifacts (1 GB per repository, and Git
 * indexes trees by hash, which is the wrong model for build products).
 *
 * Worker-safe: hashing uses WebCrypto.
 */
import { manifestKey as entryManifestKey, sha256Hex } from "../nodeModules/key.js"

/** Cache-format version; part of every key. */
export const BUILD_CACHE_VERSION = "v1"

/** Top-level namespace of this cache in the bucket (lifecycle rules apply to it, never to `v1/`). */
export const BUILD_CACHE_NAMESPACE = "build-cache"

/** Key prefix of every entry (also the prefix of the lifecycle rule). */
export const BUILD_CACHE_PREFIX = `${BUILD_CACHE_NAMESPACE}/${BUILD_CACHE_VERSION}/build/`

/** What determines the outputs of a build. */
export interface BuildCacheKeyInput {
  /** Lower-case hex SHA-256 of the canonical encoding of the sources and the tool version ({@link buildInputDigest}). */
  readonly inputSha256: string
  /** Node ABI version (`process.versions.modules`), e.g. `"127"`. */
  readonly abi: string
  /** `process.platform`, e.g. `"linux"`. */
  readonly platform: string
  /** `process.arch`, e.g. `"x64"`. */
  readonly arch: string
}

/** One source file of a build. */
export interface BuildSource {
  /** Repository-relative path with `/` separators. */
  readonly path: string
  readonly bytes: Uint8Array
}

const HEX64 = /^[0-9a-f]{64}$/
const TOKEN = /^[a-z0-9_]{1,32}$/

const utf8 = new TextEncoder()

/**
 * The canonical byte encoding of `sources + toolVersion` that is hashed.
 *
 * Sources are sorted by path (the caller's order does not matter). Each one is
 * framed as `path NUL byteLength NUL bytes`, so moving bytes from one file to
 * the next, or renaming a file, changes the encoding. The tool version comes
 * last, framed the same way under the reserved name `NUL tool` (no path
 * starts with NUL).
 *
 * @throws RangeError if two sources have the same path or a path is empty or contains NUL.
 */
export const buildInputEncoding = (sources: ReadonlyArray<BuildSource>, toolVersion: string): Uint8Array => {
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const s of sorted) {
    if (s.path.length === 0 || s.path.includes("\0")) throw new RangeError(`invalid source path ${JSON.stringify(s.path)}`)
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.path === sorted[i - 1]!.path) throw new RangeError(`duplicate source path ${JSON.stringify(sorted[i]!.path)}`)
  }
  const parts: Uint8Array[] = []
  const frame = (name: string, bytes: Uint8Array) => {
    parts.push(utf8.encode(`${name}\0${bytes.byteLength}\0`), bytes)
  }
  for (const s of sorted) frame(s.path, s.bytes)
  frame("\0tool", utf8.encode(toolVersion))
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** `sha256(sources + toolVersion)` as lower-case hex (see {@link buildInputEncoding}). */
export const buildInputDigest = async (sources: ReadonlyArray<BuildSource>, toolVersion: string): Promise<string> =>
  sha256Hex(buildInputEncoding(sources, toolVersion))

/** Is `k` a well-formed key input? Returns the reason it is not, or `null`. */
export const checkBuildKeyInput = (k: BuildCacheKeyInput): string | null => {
  if (!HEX64.test(k.inputSha256)) return "inputSha256 must be 64 lower-case hex digits"
  if (!/^[0-9]{1,4}$/.test(k.abi)) return `abi must be a decimal ABI number, got ${JSON.stringify(k.abi)}`
  if (!TOKEN.test(k.platform)) return `platform must match ${TOKEN.source}, got ${JSON.stringify(k.platform)}`
  if (!TOKEN.test(k.arch)) return `arch must match ${TOKEN.source}, got ${JSON.stringify(k.arch)}`
  return null
}

/**
 * The entry's key prefix: `build-cache/v1/build/<input sha256>/<abi>/<platform>-<arch>`.
 * Throws `RangeError` for a malformed input.
 */
export const buildCacheKey = (k: BuildCacheKeyInput): string => {
  const problem = checkBuildKeyInput(k)
  if (problem !== null) throw new RangeError(problem)
  return `${BUILD_CACHE_PREFIX}${k.inputSha256}/${k.abi}/${k.platform}-${k.arch}`
}

/** Parse a key produced by {@link buildCacheKey}; `null` if it is not one. */
export const parseBuildCacheKey = (key: string): BuildCacheKeyInput | null => {
  if (!key.startsWith(BUILD_CACHE_PREFIX)) return null
  const parts = key.slice(BUILD_CACHE_PREFIX.length).split("/")
  if (parts.length !== 3) return null
  const [inputSha256, abi, pa] = parts as [string, string, string]
  const dash = pa.indexOf("-")
  if (dash <= 0) return null
  const k = { inputSha256, abi, platform: pa.slice(0, dash), arch: pa.slice(dash + 1) }
  return checkBuildKeyInput(k) === null ? k : null
}

/** Object key of an entry's manifest (the commit point; same layout as the `node_modules` cache). */
export const buildManifestKey = (entry: string): string => entryManifestKey(entry)

/** Object key of an entry's output tarball, named by its own digest (an orphan never blocks a later producer). */
export const outputsKey = (entry: string, tarballSha256: string): string => {
  if (!HEX64.test(tarballSha256)) throw new RangeError("tarball digest must be 64 lower-case hex digits")
  return `${entry}/outputs-${tarballSha256}.tgz`
}
