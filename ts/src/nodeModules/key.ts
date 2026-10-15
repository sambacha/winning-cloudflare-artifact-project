/**
 * The R2 key of a cached `node_modules` tree.
 *
 * The key names exactly the inputs that determine the installed tree:
 *
 * | input | why |
 * |---|---|
 * | `sha256(package-lock.json)` | a different lockfile is a different tree |
 * | Node ABI (`process.versions.modules`) | native addons link against it; a patch release keeps it |
 * | `process.platform`-`process.arch` | prebuilt binaries (esbuild, rollup) differ |
 * | `v1` | the cache format; bumping it invalidates every entry |
 *
 * The full Node version is deliberately **not** in the key (a patch release
 * would miss for no reason), and neither is the npm version (lockfile v3 is
 * stable across npm 7+; a format change bumps `v1`).
 *
 * Worker-safe: hashing uses WebCrypto, available in Node 22 and in Workers.
 */

/** Cache-format version; part of every key. */
export const NODE_MODULES_CACHE_VERSION = "v1"

/**
 * Top-level namespace of this cache in the bucket. It is needed because the
 * cobuild lock and the build cache already own `v1/<scope>/…`
 * (`../cache/scope.ts`): a bare `v1/npm/` prefix would collide with a scope
 * named `npm`, and the 30-day lifecycle rule on it would then expire lock
 * objects, which breaks mutual exclusion.
 */
export const NODE_MODULES_NAMESPACE = "nm-cache"

/** Key prefix of every entry (also the prefix of the 30-day lifecycle rule). */
export const NODE_MODULES_PREFIX = `${NODE_MODULES_NAMESPACE}/${NODE_MODULES_CACHE_VERSION}/npm/`

/** Key prefix of the per-run restore/install reports the dashboard aggregates. */
export const NODE_MODULES_EVENTS_PREFIX = `${NODE_MODULES_NAMESPACE}/${NODE_MODULES_CACHE_VERSION}/events/`

/** What determines the contents of `node_modules`. */
export interface NodeModulesKeyInput {
  /** Lower-case hex SHA-256 of the exact bytes of `package-lock.json`. */
  readonly lockfileSha256: string
  /** Node ABI version (`process.versions.modules`), e.g. `"127"` for Node 22. */
  readonly abi: string
  /** `process.platform`, e.g. `"linux"`. */
  readonly platform: string
  /** `process.arch`, e.g. `"x64"`. */
  readonly arch: string
}

const HEX64 = /^[0-9a-f]{64}$/
const TOKEN = /^[a-z0-9_]{1,32}$/

/** Lower-case hex of bytes. */
export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")

/** SHA-256 of `bytes`, lower-case hex (WebCrypto). */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return toHex(await crypto.subtle.digest("SHA-256", copy))
}

/** Is `k` a well-formed key input? Returns the reason it is not, or `null`. */
export const checkKeyInput = (k: NodeModulesKeyInput): string | null => {
  if (!HEX64.test(k.lockfileSha256)) return "lockfileSha256 must be 64 lower-case hex digits"
  if (!/^[0-9]{1,4}$/.test(k.abi)) return `abi must be a decimal ABI number, got ${JSON.stringify(k.abi)}`
  if (!TOKEN.test(k.platform)) return `platform must match ${TOKEN.source}, got ${JSON.stringify(k.platform)}`
  if (!TOKEN.test(k.arch)) return `arch must match ${TOKEN.source}, got ${JSON.stringify(k.arch)}`
  return null
}

/**
 * The entry's key prefix: `nm-cache/v1/npm/<lockfile sha256>/<abi>/<platform>-<arch>`.
 * Throws `RangeError` for a malformed input (never a silently odd key).
 */
export const nodeModulesKey = (k: NodeModulesKeyInput): string => {
  const problem = checkKeyInput(k)
  if (problem !== null) throw new RangeError(problem)
  return `${NODE_MODULES_PREFIX}${k.lockfileSha256}/${k.abi}/${k.platform}-${k.arch}`
}

/** Parse a key produced by {@link nodeModulesKey}; `null` if it is not one. */
export const parseNodeModulesKey = (key: string): NodeModulesKeyInput | null => {
  if (!key.startsWith(NODE_MODULES_PREFIX)) return null
  const parts = key.slice(NODE_MODULES_PREFIX.length).split("/")
  if (parts.length !== 3) return null
  const [lockfileSha256, abi, pa] = parts as [string, string, string]
  const dash = pa.indexOf("-")
  if (dash <= 0) return null
  const k = { lockfileSha256, abi, platform: pa.slice(0, dash), arch: pa.slice(dash + 1) }
  return checkKeyInput(k) === null ? k : null
}

/** Object key of an entry's manifest (the entry's commit point). */
export const manifestKey = (entry: string): string => `${entry}/manifest.json`

/**
 * Object key of an entry's tarball. The tarball is named by its own digest,
 * so an orphan left by a producer that crashed before writing the manifest
 * never blocks a later producer (whose bytes may differ).
 */
export const tarballKey = (entry: string, tarballSha256: string): string => {
  if (!HEX64.test(tarballSha256)) throw new RangeError("tarball digest must be 64 lower-case hex digits")
  return `${entry}/node_modules-${tarballSha256}.tgz`
}
