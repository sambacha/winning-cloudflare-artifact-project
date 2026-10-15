/**
 * The input-digest cache of `planDigests` (`makeFileDigestCache` in
 * `src/cli/workspace.ts`), built on the Effect `Cache`.
 *
 * Rule: every distinct input file is read exactly once per `planDigests`
 * call, however many operations list it and however many operations are
 * hashed concurrently; and the digests are exactly those computed without
 * any sharing (one fresh hash per operation).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { formatDigest } from "../../src/cache/digest.js"
import { computeLookupDigests, type PackageInputs } from "../../src/cache/lookupKey.js"
import { hashInputs, parsePlan, planDigests } from "../../src/cli/workspace.js"
import { InvalidPlan } from "../../src/demo/runner.js"
import { announce, params } from "../harness.js"

announce("test/cli/digestCache.test.ts")

const roots: Array<string> = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A workspace with `files` files `f0..`, and operations each listing a subset of them. */
const workspace = (files: number, uses: ReadonlyArray<ReadonlyArray<number>>) => {
  const dir = mkdtempSync(join(tmpdir(), "cobuild-digest-"))
  roots.push(dir)
  mkdirSync(join(dir, "in"))
  for (let i = 0; i < files; i++) writeFileSync(join(dir, "in", `f${i}.txt`), `content ${i}`)
  const plan = parsePlan({
    operations: uses.map((u, i) => ({
      name: `op${i}`,
      command: `build ${i}`,
      inputs: [...new Set(u)].map((f) => `in/f${f}.txt`),
      deps: i > 0 ? [`op${i - 1}`] : []
    }))
  })
  return { dir, plan }
}

const usesArb = fc.integer({ min: 1, max: 6 }).chain((files) =>
  fc.record({
    files: fc.constant(files),
    uses: fc.array(fc.array(fc.integer({ min: 0, max: files - 1 }), { maxLength: 6 }), { minLength: 1, maxLength: 6 }),
    concurrency: fc.integer({ min: 1, max: 8 })
  })
)

const env = { flushSalt: "1", toolchain: "t" }

describe("input digest cache", () => {
  it("law: each distinct input file is read once, and the digests equal the unshared computation", async () => {
    await fc.assert(
      fc.asyncProperty(usesArb, async ({ files, uses, concurrency }) => {
        const { dir, plan } = workspace(files, uses)
        const reads = new Map<string, number>()
        const read = async (p: string) => {
          reads.set(p, (reads.get(p) ?? 0) + 1)
          return new Uint8Array(readFileSync(p))
        }
        const shared = await planDigests(dir, plan, env, { read, concurrency })
        const distinct = new Set(uses.flat())
        expect(reads.size).toBe(distinct.size)
        for (const n of reads.values()) expect(n).toBe(1)

        const graph = new Map<string, PackageInputs>()
        for (const op of plan.operations) graph.set(op.name, { inputs: await hashInputs(dir, op), deps: op.deps })
        const unshared = computeLookupDigests(env, graph)
        expect([...shared].map(([k, d]) => [k, formatDigest(d)])).toEqual([...unshared].map(([k, d]) => [k, formatDigest(d)]))
      }),
      params(40)
    )
  })

  it("a missing input fails with InvalidPlan (the instance, not a wrapper)", async () => {
    const { dir } = workspace(1, [[0]])
    const plan = parsePlan({ operations: [{ name: "a", command: "x", inputs: ["in/missing.txt"] }] })
    const err = await planDigests(dir, plan, env).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(InvalidPlan)
    expect(String((err as Error).message)).toContain("a: input in/missing.txt does not exist")
  })

  it("a duplicate operation fails with InvalidPlan before any file is read", async () => {
    const { dir } = workspace(1, [[0]])
    const plan = parsePlan({
      operations: [
        { name: "a", command: "x", inputs: ["in/f0.txt"] },
        { name: "a", command: "y", inputs: ["in/f0.txt"] }
      ]
    })
    let reads = 0
    const err = await planDigests(dir, plan, env, {
      read: async (p) => {
        reads++
        return new Uint8Array(readFileSync(p))
      }
    }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(InvalidPlan)
    expect(reads).toBe(0)
  })
})
