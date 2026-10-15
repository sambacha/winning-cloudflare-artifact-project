/**
 * The R2 incremental build cache (`src/buildCache/`).
 *
 * B1 Key = build-cache/v1/build/<sha256(sources + toolVersion)>/<abi>/<platform>-<arch>.
 *    It parses back, it is never under the lock/BLAKE3 namespace `v1/`, and
 *    malformed inputs are refused.
 * B2 The input digest depends on every source byte, every path and the tool
 *    version, and not on the order the sources are listed in.
 * B3 publish then lookup + fetch returns the same bytes. Writes go tarball
 *    first, manifest last.
 * B4 The manifest is the commit point: a tarball without a manifest is a
 *    miss, and a manifest whose tarball is gone is a miss.
 * B5 A tampered tarball, or a manifest for another entry, is reported corrupt.
 * B6 Two producers race: exactly one gets `published`, the other `exists`.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law } from "../harness.js"
import { makeMemoryBlobStore } from "../../src/cache/blobStore.js"
import { Effect, Exit, Option } from "../../src/fx/index.js"
import { fetchOutputs, lookupBuild, publishBuild } from "../../src/buildCache/cache.js"
import {
  BUILD_CACHE_PREFIX,
  buildCacheKey,
  type BuildCacheKeyInput,
  buildInputDigest,
  buildManifestKey,
  type BuildSource,
  outputsKey,
  parseBuildCacheKey
} from "../../src/buildCache/key.js"
import { NODE_MODULES_PREFIX } from "../../src/nodeModules/key.js"

announce("test/buildCache/cache.test.ts")

const utf8 = new TextEncoder()
const hex = fc.stringMatching(/^[0-9a-f]{64}$/)
const inputArb: fc.Arbitrary<BuildCacheKeyInput> = fc.record({
  inputSha256: hex,
  abi: fc.constantFrom("115", "127", "131", "137"),
  platform: fc.constantFrom("linux", "darwin", "win32"),
  arch: fc.constantFrom("x64", "arm64")
})

const info = { toolVersion: "typescript@5.9.3", outputs: 12, buildMs: 1200, createdAt: 1 }

describe("build cache key (B1, B2)", () => {
  it("law B1: the key parses back, has the documented shape, and stays out of v1/", () => {
    law(
      "parse(key(x)) = x",
      inputArb,
      (k) => {
        const key = buildCacheKey(k)
        expect(key).toBe(`build-cache/v1/build/${k.inputSha256}/${k.abi}/${k.platform}-${k.arch}`)
        expect(key.startsWith("v1/")).toBe(false)
        expect(key.startsWith(NODE_MODULES_PREFIX)).toBe(false)
        expect(parseBuildCacheKey(key)).toEqual(k)
        return { valid: true, boundary: k.abi === "137" }
      },
      200,
      { domain: "random input digests x 4 ABIs x 3 platforms x 2 arches", minValidFraction: 1, minBoundary: 5 }
    )
  })

  it("malformed inputs are refused; foreign keys do not parse", () => {
    const k = { inputSha256: "0".repeat(64), abi: "127", platform: "linux", arch: "x64" }
    for (const bad of [{ ...k, inputSha256: "XYZ" }, { ...k, abi: "v22.21.1" }, { ...k, platform: "linux/../x" }, { ...k, arch: "" }]) {
      expect(() => buildCacheKey(bad)).toThrow(RangeError)
    }
    expect(parseBuildCacheKey(`${NODE_MODULES_PREFIX}${"0".repeat(64)}/127/linux-x64`)).toBeNull()
    expect(parseBuildCacheKey(`${BUILD_CACHE_PREFIX}zz/127/linux-x64`)).toBeNull()
  })

  const src = (path: string, body: string): BuildSource => ({ path, bytes: utf8.encode(body) })

  it("law B2: the digest ignores source order and changes with any byte, path or tool version", async () => {
    const files = [src("src/a.ts", "export const a = 1\n"), src("src/b.ts", "export const b = 2\n"), src("src/c.ts", "export {}\n")]
    const base = await buildInputDigest(files, "tsc 5.9.3")
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await buildInputDigest([...files].reverse(), "tsc 5.9.3")).toBe(base)
    expect(await buildInputDigest(files, "tsc 5.9.4")).not.toBe(base)
    expect(await buildInputDigest([files[0]!, files[1]!, src("src/d.ts", "export {}\n")], "tsc 5.9.3")).not.toBe(base)
    expect(await buildInputDigest([files[0]!, files[1]!, src("src/c.ts", "export {} \n")], "tsc 5.9.3")).not.toBe(base)
    // Moving bytes across a file boundary changes the digest (framing).
    expect(await buildInputDigest([src("x", "ab"), src("y", "c")], "t")).not.toBe(await buildInputDigest([src("x", "a"), src("y", "bc")], "t"))
    await expect(buildInputDigest([src("x", "a"), src("x", "b")], "t")).rejects.toThrow(RangeError)
  })
})

describe("build cache entries (B3-B6)", () => {
  const input = { inputSha256: "2".repeat(64), abi: "127", platform: "linux", arch: "x64" }
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 17) % 251)

  it("B3: publish, then lookup + fetch returns the same bytes, tarball written before manifest", async () => {
    const store = makeMemoryBlobStore({ chunkSize: 4096 })
    const r = await Effect.runPromise(publishBuild(store, input, bytes, info))
    expect(r.outcome).toBe("published")
    const m = Option.getOrThrow(await Effect.runPromise(lookupBuild(store, input)))
    expect(m.outputs).toBe(12)
    expect(m.buildMs).toBe(1200)
    expect(Option.getOrThrow(await Effect.runPromise(fetchOutputs(store, m)))).toEqual(bytes)
    expect(store.writes).toEqual([outputsKey(m.key, m.tarballSha256), buildManifestKey(m.key)])
  })

  it("B4: a tarball without a manifest is ignored; a manifest without its tarball is a miss", async () => {
    const store = makeMemoryBlobStore()
    const entry = buildCacheKey(input)
    const r = await Effect.runPromise(publishBuild(makeMemoryBlobStore(), input, bytes, info))
    store.forcePut(outputsKey(entry, r.manifest.tarballSha256), bytes)
    expect(Option.isNone(await Effect.runPromise(lookupBuild(store, input)))).toBe(true)

    const onlyManifest = makeMemoryBlobStore()
    onlyManifest.forcePut(buildManifestKey(entry), utf8.encode(JSON.stringify(r.manifest)))
    const m = Option.getOrThrow(await Effect.runPromise(lookupBuild(onlyManifest, input)))
    expect(Option.isNone(await Effect.runPromise(fetchOutputs(onlyManifest, m)))).toBe(true)
  })

  it("B5: a tampered tarball or a manifest for another entry is corrupt", async () => {
    const store = makeMemoryBlobStore({ faults: { tamper: (key, body) => (key.endsWith(".tgz") ? body.map((b, i) => (i === 3 ? b ^ 1 : b)) : body) } })
    await Effect.runPromise(publishBuild(store, input, bytes, info))
    const m = Option.getOrThrow(await Effect.runPromise(lookupBuild(store, input)))
    const exit = await Effect.runPromiseExit(fetchOutputs(store, m))
    expect(Exit.isFailure(exit) && JSON.stringify(exit).includes("BuildCacheCorrupt")).toBe(true)

    const moved = makeMemoryBlobStore()
    const other = { ...input, arch: "arm64" }
    moved.forcePut(buildManifestKey(buildCacheKey(other)), store.peek(buildManifestKey(buildCacheKey(input)))!)
    const e2 = await Effect.runPromiseExit(lookupBuild(moved, other))
    expect(Exit.isFailure(e2) && JSON.stringify(e2).includes("different entry")).toBe(true)
  })

  it("B6: racing producers commit exactly once", async () => {
    const store = makeMemoryBlobStore()
    const other = bytes.map((b) => b ^ 0xff)
    const [a, b] = await Effect.runPromise(Effect.all([publishBuild(store, input, bytes, info), publishBuild(store, input, other, info)], { concurrency: 2 }))
    expect([a.outcome, b.outcome].sort()).toEqual(["exists", "published"])
    const winner = a.outcome === "published" ? a.manifest : b.manifest
    const m = Option.getOrThrow(await Effect.runPromise(lookupBuild(store, input)))
    expect(m.tarballSha256).toBe(winner.tarballSha256)
  })
})
