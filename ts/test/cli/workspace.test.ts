/**
 * Plan parsing, input hashing and on-disk restore staging of the `cobuild`
 * CLI (`src/cli/workspace.ts`).
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "../../src/fx/index.js"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { announce, law, lawAsync, mutantKilled, mutantKilledAsync } from "../harness.js"
import { formatDigest } from "../../src/cache/digest.js"
import { hashInputs, makeWorkspaceStaging, parsePlan, planDigests } from "../../src/cli/workspace.js"
import { computeLookupDigests, type KeyEnvironment, type PackageInputs } from "../../src/cache/lookupKey.js"
import type { Digest } from "../../src/cache/digest.js"
import { InvalidPlan } from "../../src/demo/runner.js"

announce("test/cli/workspace.test.ts")

const roots: Array<string> = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "cobuild-ws-"))
  roots.push(d)
  return d
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe("plan parsing", () => {
  it("accepts a minimal plan and fills defaults", () => {
    const p = parsePlan({ operations: [{ name: "a", command: "true" }] })
    expect(p).toEqual({ flushSalt: "1", toolchain: "", operations: [{ name: "a", deps: [], command: "true", inputs: [], outputs: [] }] })
  })

  it("regression (recorded): seven hand-picked invalid plans are rejected", () => {
    const bad: Array<unknown> = [
      { operations: [] },
      { operations: [{ name: "a", command: "x", inputs: ["../secret"] }] },
      { operations: [{ name: "a", command: "x", outputs: ["/abs"] }] },
      { operations: [{ name: "a", command: "x", outputs: ["out"] }, { name: "b", command: "y", outputs: ["out/b"] }] },
      { operations: [{ name: "a", command: "x", outputs: ["out", "out"] }] },
      { operations: [{ name: " spaced", command: "x" }] },
      { operations: [{ name: "a", command: "" }] }
    ]
    for (const b of bad) expect(() => parsePlan(b), JSON.stringify(b)).toThrow(InvalidPlan)
  })
})

/*
 * Plan validity as a rule (replaces seven hand-picked invalid plans): a plan
 * is accepted iff it has ≥ 1 operation; every name matches
 * [A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}; every command is non-empty; every
 * input and output path is a non-empty relative path of '/'-separated
 * segments, none empty, "." or "..", without '\\' or NUL, ≤ 4096 chars; and
 * no declared output equals another or lies inside another (as a SEGMENT
 * prefix: "out" and "output" do not overlap).
 */
const SEGMENTS = ["out", "output", "a", "b", "dist", "src", ".", "..", "", "x y", "a\\b", "n\u0000"]
const pathArb = fc.oneof(
  { weight: 12, arbitrary: fc.array(fc.constantFrom("out", "output", "a", "b", "dist", "src", "x y"), { minLength: 1, maxLength: 3 }).map((xs) => xs.join("/")) },
  { weight: 2, arbitrary: fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 3 }).map((xs) => xs.join("/")) },
  { weight: 1, arbitrary: fc.constantFrom("/abs", "a/", "/", "a//b", "./a") }
)
const nameArb = fc.oneof(
  { weight: 15, arbitrary: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,12}$/) },
  { weight: 1, arbitrary: fc.constantFrom(" spaced", "-lead", "", "a".repeat(128), "a".repeat(129), "ü", "a b") }
)
const planArb = fc.record({
  operations: fc.array(
    fc.record({
      name: nameArb,
      command: fc.oneof({ weight: 15, arbitrary: fc.constant("make") }, { weight: 1, arbitrary: fc.constant("") }),
      inputs: fc.array(pathArb, { maxLength: 2 }),
      outputs: fc.array(pathArb, { maxLength: 2 })
    }),
    { minLength: 0, maxLength: 3 }
  )
})
type RawPlan = { operations: Array<{ name: string; command: string; inputs: string[]; outputs: string[] }> }
/** Oracle written from the rule, comparing segment lists (not strings). */
const planIsValid = (p: RawPlan): boolean => {
  if (p.operations.length === 0) return false
  const pathOk = (x: string) => x.length > 0 && x.length <= 4096 && !x.includes("\\") && !x.includes("\u0000") && x.split("/").every((seg) => !["", ".", ".."].includes(seg))
  for (const op of p.operations) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(op.name) || op.command.length === 0) return false
    if (![...op.inputs, ...op.outputs].every(pathOk)) return false
  }
  const outs = p.operations.flatMap((op) => op.outputs.map((o) => o.split("/")))
  for (let i = 0; i < outs.length; i++) {
    for (let j = 0; j < outs.length; j++) {
      if (i !== j && outs[i]!.length <= outs[j]!.length && outs[i]!.every((seg, k) => outs[j]![k] === seg)) return false
    }
  }
  return true
}
type Parse = (json: unknown) => unknown
const accepts = (parse: Parse, p: RawPlan): boolean => {
  try {
    parse(p)
    return true
  } catch (e) {
    if (!(e instanceof InvalidPlan)) throw e
    return false
  }
}
/** Mutant 1: a lenient validator that normalises "a//b", "a/./b", "a/" instead of rejecting them (only ".." and absolute paths fail). */
const lenientPaths: Parse = (json) => {
  const p = json as RawPlan
  const norm = (x: string) => (x.startsWith("/") || x.split("/").includes("..") ? x : x.split("/").filter((s) => s !== "" && s !== ".").join("/") || x)
  return parsePlan({ ...p, operations: p.operations.map((op) => ({ ...op, inputs: op.inputs.map(norm), outputs: op.outputs.map(norm) })) })
}
/** Mutant 2: overlap tested by string prefix ("out" would contain "output"). */
const stringPrefixOverlap: Parse = (json) => {
  const plan = parsePlan(json)
  const outs = plan.operations.flatMap((op) => op.outputs)
  outs.forEach((a, i) => outs.forEach((b, j) => {
    if (i !== j && b.startsWith(a)) throw new InvalidPlan(`overlap ${a} ${b}`)
  }))
  return plan
}

describe("plan validity law", () => {
  it("law: parsePlan accepts exactly the plans the rule calls valid; both verdicts occur", () => {
    let valid = 0
    law(
      "parsePlan ⇔ rule",
      planArb,
      (p) => {
        expect(accepts(parsePlan, p), JSON.stringify(p)).toBe(planIsValid(p))
        if (planIsValid(p)) valid++
        const outs = p.operations.flatMap((o) => o.outputs)
        return { valid: true, boundary: p.operations.length === 0 || outs.some((a, i) => outs.some((b, j) => i !== j && b.startsWith(a))) }
      },
      500,
      { domain: "0–4 operations; names valid or near-miss; paths from safe/unsafe segments, absolute, trailing/double slashes; overlapping outputs", minValidFraction: 1, minBoundary: 40 }
    )
    expect(valid).toBeGreaterThan(50)
    expect(valid).toBeLessThan(450)
  })

  it("counterexample 1 (mutant: lenient normalisation): an output \"out//x\" must be rejected", () => {
    const p = { operations: [{ name: "a", command: "make", inputs: [], outputs: ["out//x"] }] }
    expect(planIsValid(p)).toBe(false)
    expect(accepts(parsePlan, p)).toBe(false)
    expect(accepts(lenientPaths, p)).toBe(true)
  })

  it("counterexample 2 (mutant: string-prefix overlap): outputs \"out\" and \"output\" do not overlap", () => {
    const p = { operations: [{ name: "a", command: "make", inputs: [], outputs: ["out"] }, { name: "b", command: "make", inputs: [], outputs: ["output"] }] }
    expect(planIsValid(p)).toBe(true)
    expect(accepts(parsePlan, p)).toBe(true)
    expect(accepts(stringPrefixOverlap, p)).toBe(false)
  })

  it("negation 1: the law is refuted for the lenient-normalisation mutant", () => {
    expect(mutantKilled(planArb, (p) => accepts(lenientPaths, p) === planIsValid(p), 400)).toBe(true)
  })

  it("negation 2: the law is refuted for the string-prefix-overlap mutant", () => {
    // Generated plans plus two outputs that are string- but not segment-prefixes (the region where the mutant differs).
    const withNearOverlap = planArb.map((p) => ({ operations: [...p.operations, { name: "near-1", command: "make", inputs: [], outputs: ["gen"] }, { name: "near-2", command: "make", inputs: [], outputs: ["generated"] }] }))
    expect(mutantKilled(withNearOverlap, (p) => accepts(stringPrefixOverlap, p) === planIsValid(p), 200)).toBe(true)
  })
})

describe("input hashing", () => {
  it("regression (recorded): one edit/revert/rename sequence on a two-operation plan", async () => {
    const d = fresh()
    mkdirSync(join(d, "src/sub"), { recursive: true })
    writeFileSync(join(d, "src/a.txt"), "a")
    writeFileSync(join(d, "src/sub/b.txt"), "b")
    const plan = (cmd: string) =>
      parsePlan({ operations: [{ name: "gen", command: cmd, inputs: ["src"] }, { name: "use", deps: ["gen"], command: "true" }] })
    const env = { flushSalt: "1", toolchain: "t" }
    const keys = async (cmd = "build") => {
      const m = await planDigests(d, plan(cmd), env)
      return { gen: formatDigest(m.get("gen")!), use: formatDigest(m.get("use")!) }
    }
    const k0 = await keys()
    expect(await keys()).toEqual(k0) // deterministic
    writeFileSync(join(d, "src/sub/b.txt"), "B")
    const k1 = await keys()
    expect(k1.gen).not.toBe(k0.gen)
    expect(k1.use).not.toBe(k0.use) // a dependency's key is part of the dependent's key
    writeFileSync(join(d, "src/sub/b.txt"), "b")
    expect(await keys()).toEqual(k0)
    expect((await keys("build --prod")).gen).not.toBe(k0.gen)
    const files = await hashInputs(d, plan("build").operations[0]!)
    expect(files.map((f) => f.path)).toEqual([":command", "src/a.txt", "src/sub/b.txt"])
  })

  it("a missing input is a plan error", async () => {
    const d = fresh()
    await expect(planDigests(d, parsePlan({ operations: [{ name: "a", command: "x", inputs: ["nope"] }] }), { flushSalt: "1", toolchain: "" })).rejects.toThrow(
      /input nope does not exist/
    )
  })
})

/*
 * Input hashing as a rule (replaces one edit/revert sequence on one tree):
 * for any tree and any plan "gen (inputs: src) → use (deps: gen)", the key of
 * an operation changes iff its command, the name or content of a file under
 * one of its inputs, or the key of a dependency changes. So:
 *   - editing or renaming a file under src/, or editing gen's command,
 *     changes gen's key and use's key;
 *   - editing a file outside every input changes neither;
 *   - recomputing without a change gives the same keys.
 */
type Change = "edit-src" | "rename-src" | "command" | "edit-outside" | "none"
const treeCase = fc.record({
  src: fc.uniqueArray(fc.record({ name: fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6})?\.txt$/), body: fc.string({ maxLength: 20 }) }), { minLength: 1, maxLength: 5, selector: (f) => f.name.split("/")[0]! }),
  outside: fc.string({ maxLength: 20 }),
  change: fc.constantFrom<Change>("edit-src", "rename-src", "command", "edit-outside", "none"),
  pick: fc.nat(),
  suffix: fc.string({ minLength: 1, maxLength: 5 })
})
type TreeCase = { src: Array<{ name: string; body: string }>; outside: string; change: Change; pick: number; suffix: string }
type KeyFn = (dir: string, plan: ReturnType<typeof parsePlan>, env: KeyEnvironment) => Promise<Map<string, Digest>>
const keyEnv: KeyEnvironment = { flushSalt: "1", toolchain: "t" }
const hashingFollowsRule = async (keys: KeyFn, c: TreeCase): Promise<boolean> => {
  const d = fresh()
  mkdirSync(join(d, "src"), { recursive: true })
  mkdirSync(join(d, "other"), { recursive: true })
  for (const f of c.src) {
    mkdirSync(join(d, "src", f.name, ".."), { recursive: true })
    writeFileSync(join(d, "src", f.name), f.body)
  }
  writeFileSync(join(d, "other", "notes.txt"), c.outside)
  const plan = (cmd: string) => parsePlan({ operations: [{ name: "gen", command: cmd, inputs: ["src"] }, { name: "use", deps: ["gen"], command: "true" }] })
  const k = async (cmd = "build") => {
    const m = await keys(d, plan(cmd), keyEnv)
    return { gen: formatDigest(m.get("gen")!), use: formatDigest(m.get("use")!) }
  }
  const before = await k()
  const target = c.src[c.pick % c.src.length]!
  let cmd = "build"
  if (c.change === "edit-src") writeFileSync(join(d, "src", target.name), target.body + c.suffix)
  if (c.change === "rename-src") renameSync(join(d, "src", target.name), join(d, "src", `${target.name}.renamed`))
  if (c.change === "command") cmd = `build ${c.suffix}`
  if (c.change === "edit-outside") writeFileSync(join(d, "other", "notes.txt"), c.outside + c.suffix)
  const after = await k(cmd)
  const shouldChange = c.change === "edit-src" || c.change === "rename-src" || c.change === "command"
  return shouldChange ? after.gen !== before.gen && after.use !== before.use : after.gen === before.gen && after.use === before.use
}
/** Mutant 1: the key covers file contents but not file names. */
const contentsOnly: KeyFn = async (dir, plan, env) => {
  const graph = new Map<string, PackageInputs>()
  for (const op of plan.operations) {
    const files = await hashInputs(dir, op)
    const anonymous = files.map((f) => formatDigest(f.digest)).sort().map((dg, i) => ({ path: `f${i}`, digest: files.find((f) => formatDigest(f.digest) === dg)!.digest }))
    graph.set(op.name, { inputs: anonymous, deps: op.deps })
  }
  return computeLookupDigests(env, graph)
}
/** Mutant 2: shallow keys — a dependency's key is not part of the dependent's key. */
const shallow: KeyFn = async (dir, plan, env) => {
  const graph = new Map<string, PackageInputs>()
  for (const op of plan.operations) graph.set(op.name, { inputs: await hashInputs(dir, op), deps: [] })
  return computeLookupDigests(env, graph)
}

describe("input hashing law", () => {
  it("law: keys change exactly with the command, input file names/contents and dependency keys", async () => {
    await lawAsync(
      "planDigests sensitivity and insensitivity",
      treeCase,
      async (c) => {
        expect(await hashingFollowsRule(planDigests, c), JSON.stringify(c)).toBe(true)
        return { valid: c.change !== "none", boundary: c.change === "edit-outside" || c.src.length === 1 }
      },
      60,
      { domain: "1–5 files under src/ (nested), one file outside every input; edit / rename / command / outside edit / no change", minValidFraction: 0.6, minBoundary: 10 }
    )
  }, 120_000)

  it("counterexample 1 (mutant: names not hashed): renaming the only input file", async () => {
    const c: TreeCase = { src: [{ name: "a.txt", body: "x" }], outside: "", change: "rename-src", pick: 0, suffix: "!" }
    expect(await hashingFollowsRule(planDigests, c)).toBe(true)
    expect(await hashingFollowsRule(contentsOnly, c)).toBe(false)
  })

  it("counterexample 2 (mutant: shallow keys): editing gen's input must change use's key", async () => {
    const c: TreeCase = { src: [{ name: "a.txt", body: "x" }], outside: "", change: "edit-src", pick: 0, suffix: "!" }
    expect(await hashingFollowsRule(planDigests, c)).toBe(true)
    expect(await hashingFollowsRule(shallow, c)).toBe(false)
  })

  it("negation 1: the law is refuted for the contents-only mutant", async () => {
    expect(await mutantKilledAsync(treeCase, (c) => hashingFollowsRule(contentsOnly, c), 40)).toBe(true)
  }, 60_000)

  it("negation 2: the law is refuted for the shallow mutant", async () => {
    expect(await mutantKilledAsync(treeCase, (c) => hashingFollowsRule(shallow, c), 40)).toBe(true)
  }, 60_000)
})

describe("workspace restore staging", () => {
  it("replaces each declared output root atomically on commit and refuses paths outside the roots", async () => {
    const d = fresh()
    mkdirSync(join(d, "out/a"), { recursive: true })
    writeFileSync(join(d, "out/a/stale.txt"), "old")
    writeFileSync(join(d, "keep.txt"), "mine")
    const staging = makeWorkspaceStaging(d, ["out/a", "out/b"])
    const s = await Effect.runPromise(staging.begin)
    await Effect.runPromise(s.write("out/a/new.txt", new TextEncoder().encode("ne")))
    await Effect.runPromise(s.write("out/a/new.txt", new TextEncoder().encode("w")))
    const outside = await Effect.runPromise(Effect.result(s.write("keep.txt", new TextEncoder().encode("evil"))))
    expect(Result.isFailure(outside)).toBe(true)
    const escape = await Effect.runPromise(Effect.result(s.write("out/a/../../x", new TextEncoder().encode("evil"))))
    expect(Result.isFailure(escape)).toBe(true)
    // Before commit the destination is untouched.
    expect(readFileSync(join(d, "out/a/stale.txt"), "utf8")).toBe("old")
    await Effect.runPromise(s.commit)
    expect(readFileSync(join(d, "out/a/new.txt"), "utf8")).toBe("new")
    expect(existsSync(join(d, "out/a/stale.txt"))).toBe(false)
    expect(existsSync(join(d, "out/b"))).toBe(true) // a root absent from the entry becomes an empty directory
    expect(readFileSync(join(d, "keep.txt"), "utf8")).toBe("mine")
  })

  it("abort leaves the workspace as it was", async () => {
    const d = fresh()
    mkdirSync(join(d, "out"), { recursive: true })
    writeFileSync(join(d, "out/x"), "x")
    const s = await Effect.runPromise(makeWorkspaceStaging(d, ["out"]).begin)
    await Effect.runPromise(s.write("out/y", new TextEncoder().encode("y")))
    await Effect.runPromise(s.abort)
    expect(readFileSync(join(d, "out/x"), "utf8")).toBe("x")
    expect(existsSync(join(d, "out/y"))).toBe(false)
  })
})
