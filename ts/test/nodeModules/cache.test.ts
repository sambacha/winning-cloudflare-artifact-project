/**
 * The R2 `node_modules` cache (`src/nodeModules/`).
 *
 * K1 Key = nm-cache/v1/npm/<sha256 lockfile>/<abi>/<platform>-<arch>; it parses back,
 *    distinct inputs give distinct keys, malformed inputs are refused.
 * C1 publish then lookup + fetch returns the same bytes (round trip).
 * C2 The manifest is the commit point: a tarball without a manifest is a
 *    miss; a manifest whose tarball is gone is a miss, not an error.
 * C3 A tampered tarball is reported corrupt (never extracted).
 * C4 Two producers racing: exactly one `published`, the other `exists`; an
 *    orphan tarball from a crashed producer does not block a later producer.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { announce, law } from "../harness.js"
import { makeMemoryBlobStore } from "../../src/cache/blobStore.js"
import { Effect, Exit, Option } from "../../src/fx/index.js"
import {
  fetchTarball,
  lookupManifest,
  NodeModulesCacheCorrupt,
  publishEntry
} from "../../src/nodeModules/cache.js"
import { manifestKey, nodeModulesKey, type NodeModulesKeyInput, parseNodeModulesKey, sha256Hex, tarballKey } from "../../src/nodeModules/key.js"

announce("test/nodeModules/cache.test.ts")

const hex = fc.stringMatching(/^[0-9a-f]{64}$/)
const inputArb: fc.Arbitrary<NodeModulesKeyInput> = fc.record({
  lockfileSha256: hex,
  abi: fc.constantFrom("115", "127", "131", "137"),
  platform: fc.constantFrom("linux", "darwin", "win32"),
  arch: fc.constantFrom("x64", "arm64")
})

const info = { nodeVersion: "v22.21.1", npmVersion: "10.9.4", installedLockSha256: "a".repeat(64), coldInstallMs: 42_000, createdAt: 1 }

describe("node_modules cache key (K1)", () => {
  it("law K1: the key parses back to its input and has the documented shape", () => {
    law(
      "parse(key(x)) = x",
      inputArb,
      (k) => {
        const key = nodeModulesKey(k)
        expect(key).toBe(`nm-cache/v1/npm/${k.lockfileSha256}/${k.abi}/${k.platform}-${k.arch}`)
        expect(parseNodeModulesKey(key)).toEqual(k)
        return { valid: true, boundary: k.abi === "137" }
      },
      200,
      { domain: "random lockfile digests × 4 ABIs × 3 platforms × 2 arches", minValidFraction: 1, minBoundary: 5 }
    )
  })

  it("law K1: distinct inputs give distinct keys", () => {
    law(
      "key is injective",
      fc.tuple(inputArb, inputArb),
      ([a, b]) => {
        const same = JSON.stringify(a) === JSON.stringify(b)
        expect(nodeModulesKey(a) === nodeModulesKey(b)).toBe(same)
        return { valid: !same, boundary: a.lockfileSha256 === b.lockfileSha256 }
      },
      300,
      { domain: "pairs of inputs", minValidFraction: 0.9, minBoundary: 0 }
    )
  })

  it("a patch release (same ABI) keeps the key; malformed inputs are refused", () => {
    const k = { lockfileSha256: "0".repeat(64), abi: "127", platform: "linux", arch: "x64" }
    expect(nodeModulesKey(k)).toBe(nodeModulesKey({ ...k }))
    for (const bad of [
      { ...k, lockfileSha256: "XYZ" },
      { ...k, abi: "v22.21.1" },
      { ...k, platform: "linux/../x" },
      { ...k, arch: "" }
    ]) expect(() => nodeModulesKey(bad)).toThrow(RangeError)
    expect(parseNodeModulesKey("nm-cache/v1/npm/zz/127/linux-x64")).toBeNull()
  })

  it("sha256Hex matches a known vector", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("node_modules cache entries (C1-C4)", () => {
  const input = { lockfileSha256: "1".repeat(64), abi: "127", platform: "linux", arch: "x64" }
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 251)

  it("C1: publish, then lookup + fetch returns the same bytes", async () => {
    const store = makeMemoryBlobStore({ chunkSize: 4096 })
    const r = await Effect.runPromise(publishEntry(store, input, bytes, info))
    expect(r.outcome).toBe("published")
    const m = Option.getOrThrow(await Effect.runPromise(lookupManifest(store, input)))
    expect(m.tarballBytes).toBe(bytes.byteLength)
    expect(m.coldInstallMs).toBe(42_000)
    const got = Option.getOrThrow(await Effect.runPromise(fetchTarball(store, m)))
    expect(got).toEqual(bytes)
    // Order of writes: tarball first, manifest last (the commit point).
    expect(store.writes).toEqual([tarballKey(m.key, m.tarballSha256), manifestKey(m.key)])
  })

  it("C2: a tarball without a manifest is a miss; a manifest without its tarball is a miss", async () => {
    const store = makeMemoryBlobStore()
    const entry = nodeModulesKey(input)
    store.forcePut(tarballKey(entry, await sha256Hex(bytes)), bytes)
    expect(Option.isNone(await Effect.runPromise(lookupManifest(store, input)))).toBe(true)

    const other = makeMemoryBlobStore()
    const { manifest } = await Effect.runPromise(publishEntry(other, input, bytes, info))
    const onlyManifest = makeMemoryBlobStore()
    onlyManifest.forcePut(manifestKey(entry), other.peek(manifestKey(entry))!)
    const m = Option.getOrThrow(await Effect.runPromise(lookupManifest(onlyManifest, input)))
    expect(m).toEqual(manifest)
    expect(Option.isNone(await Effect.runPromise(fetchTarball(onlyManifest, m)))).toBe(true)
  })

  it("C3: a tampered tarball or a manifest for another entry is reported corrupt", async () => {
    const store = makeMemoryBlobStore({ faults: { tamper: (key, body) => (key.endsWith(".tgz") ? body.map((b, i) => (i === 7 ? b ^ 1 : b)) : body) } })
    await Effect.runPromise(publishEntry(store, input, bytes, info))
    const m = Option.getOrThrow(await Effect.runPromise(lookupManifest(store, input)))
    const exit = await Effect.runPromiseExit(fetchTarball(store, m))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("NodeModulesCacheCorrupt")

    const moved = makeMemoryBlobStore()
    const other = { ...input, arch: "arm64" }
    moved.forcePut(manifestKey(nodeModulesKey(other)), store.peek(manifestKey(nodeModulesKey(input)))!)
    const e2 = await Effect.runPromiseExit(lookupManifest(moved, other))
    expect(Exit.isFailure(e2) && JSON.stringify(e2).includes("different entry")).toBe(true)
    expect(new NodeModulesCacheCorrupt({ objectKey: "k", reason: "r" })._tag).toBe("NodeModulesCacheCorrupt")
  })

  it("C4: racing producers commit exactly once; an orphan tarball does not block", async () => {
    const store = makeMemoryBlobStore()
    const other = bytes.map((b) => b ^ 0xff)
    const [a, b] = await Effect.runPromise(Effect.all([publishEntry(store, input, bytes, info), publishEntry(store, input, other, info)], { concurrency: 2 }))
    expect([a.outcome, b.outcome].sort()).toEqual(["exists", "published"])
    const winner = a.outcome === "published" ? a.manifest : b.manifest
    const m = Option.getOrThrow(await Effect.runPromise(lookupManifest(store, input)))
    expect(m.tarballSha256).toBe(winner.tarballSha256)

    // Orphan: a producer wrote its tarball and crashed before the manifest.
    const crashed = makeMemoryBlobStore()
    crashed.forcePut(tarballKey(nodeModulesKey(input), await sha256Hex(other)), other)
    const later = await Effect.runPromise(publishEntry(crashed, input, bytes, info))
    expect(later.outcome).toBe("published")
    expect(Option.getOrThrow(await Effect.runPromise(fetchTarball(crashed, later.manifest)))).toEqual(bytes)
  })
})
