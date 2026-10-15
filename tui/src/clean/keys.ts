/**
 * The R2 keys the clean scenario displays. These mirror `ts/src/nodeModules/key.ts`
 * and `ts/src/buildCache/key.ts`, and `ts/test/worker/tuiBisectContract.test.ts`
 * checks that they agree. No imports, so the `ts/` tests can load this file.
 */

export const NM_CACHE_PREFIX = "nm-cache/v1/npm/"
export const BUILD_CACHE_PREFIX = "build-cache/v1/build/"

/** `nm-cache/v1/npm/<sha256(package-lock.json)>/<abi>/<platform>-<arch>`. */
export const nodeModulesKey = (lockfileSha256: string, abi: string, platform: string, arch: string): string =>
  `${NM_CACHE_PREFIX}${lockfileSha256}/${abi}/${platform}-${arch}`

/** `build-cache/v1/build/<sha256(sources + toolVersion)>/<abi>/<platform>-<arch>`. */
export const buildCacheKey = (inputSha256: string, abi: string, platform: string, arch: string): string =>
  `${BUILD_CACHE_PREFIX}${inputSha256}/${abi}/${platform}-${arch}`

/** A digest shortened for display: the first `n` hex digits and "...". */
export const shortDigest = (hex: string, n: number): string => `${hex.slice(0, n)}...`

/** A key with its digest segment shortened (for display only). */
export const shortKey = (prefix: string, hex: string, abi: string, platform: string, arch: string, n: number): string =>
  `${prefix}${shortDigest(hex, n)}/${abi}/${platform}-${arch}`

/** Hex digits of a digest shown before "...". */
export const DIGEST_SHOWN = 6

