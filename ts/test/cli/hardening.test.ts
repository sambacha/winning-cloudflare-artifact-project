/**
 * In-process checks of the production-hardening rules (the subprocess
 * checks are in `e2e.test.ts`, "hardening"):
 *
 * - R1 `buildCommandEnv`: a variable reaches a build command iff it is not a
 *   credential (`R2_*`, `CLOUDFLARE_*`, `AWS_*`, the API token names, or a
 *   name listed in `COBUILD_STRIP_ENV`, case-insensitively); the operation
 *   variables always win.
 * - R2 `envNonNegInt`: accepts exactly the decimal non-negative safe integers
 *   (unset/empty gives the default); everything else is a usage error.
 * - R3 `cobuildsEnabled`: opt-in; unset/empty/0/false/no/off is off,
 *   1/true/yes/on is on (any case), anything else is a usage error.
 * - R4 `makeFsBucket`: a NaN, infinite or negative rate window is refused
 *   at construction (it used to reject every write after the first).
 * - R5 `workerConfig`: no default scope, no empty token, TTL a positive
 *   integer.
 * - R6 `mapBounded`: same results as `map`, in order, never more than
 *   `limit` calls in flight.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"
import { announce, params } from "../harness.js"
import { cobuildsEnabled, envNonNegInt, UsageError } from "../../src/cli/main.js"
import { buildCommandEnv, isSecretEnvName } from "../../src/cli/workspace.js"
import { makeFsBucket } from "../../src/fsBucket.js"
import { mapBounded } from "../../src/worker/handler.js"
import { workerConfig } from "../../src/worker/index.js"
import { makeFakeBucket } from "../worker/fakeBucket.js"
import { makeMemoryStore } from "../../src/index.js"
import { Duration, Redacted } from "../../src/fx/index.js"

announce("test/cli/hardening.test.ts")
const dirs: Array<string> = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const SECRET_PREFIXES = ["R2_", "CLOUDFLARE_", "AWS_"]
const SECRET_NAMES = ["COBUILDS_API_TOKEN", "BAYESECT_API_TOKEN", "API_TOKEN", "ARTIFACTS_API_TOKEN"]
const nameArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/),
  fc.tuple(fc.constantFrom(...SECRET_PREFIXES), fc.stringMatching(/^[A-Za-z0-9_]{0,8}$/)).map(([p, s]) => p + s),
  fc.tuple(fc.constantFrom(...SECRET_NAMES), fc.boolean()).map(([n, lower]) => (lower ? n.toLowerCase() : n))
)

describe("R1 build command environment", () => {
  it("law: kept iff not a credential and not listed in COBUILD_STRIP_ENV; operation variables win", () => {
    fc.assert(
      fc.property(
        fc.dictionary(nameArb, fc.string({ maxLength: 8 }), { maxKeys: 12 }),
        fc.array(nameArb, { maxLength: 3 }),
        fc.dictionary(fc.constantFrom("COBUILD_OPERATION", "COBUILD_LOOKUP"), fc.string({ maxLength: 8 })),
        (base, strip, extra) => {
          const env: Record<string, string> = { ...base, COBUILD_STRIP_ENV: strip.join(",") }
          const stripSet = new Set(strip.map((s) => s.toUpperCase()))
          const out = buildCommandEnv(env, extra)
          for (const [k, v] of Object.entries(env)) {
            const upper = k.toUpperCase()
            const secret = SECRET_NAMES.includes(upper) || SECRET_PREFIXES.some((p) => upper.startsWith(p)) || stripSet.has(upper)
            expect(isSecretEnvName(k, stripSet)).toBe(secret)
            if (k in extra) expect(out[k]).toBe(extra[k])
            else if (secret) expect(k in out).toBe(false)
            else expect(out[k]).toBe(v)
          }
          for (const k of Object.keys(out)) expect(k in env || k in extra).toBe(true)
        }
      ),
      params(300)
    )
  })
  it("counterexample (the old `{ ...process.env, ...env }`): R2_SECRET_ACCESS_KEY is passed through", () => {
    const env = { R2_SECRET_ACCESS_KEY: "s", PATH: "/bin" }
    expect({ ...env }).toHaveProperty("R2_SECRET_ACCESS_KEY")
    expect(buildCommandEnv(env, {})).toEqual({ PATH: "/bin" })
  })
})

describe("R2 numeric environment variables", () => {
  it("law: accepted iff a non-negative safe integer; unset or blank gives the default", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.nat().map(String), fc.integer({ min: -1000, max: -1 }).map(String), fc.double().map(String), fc.string({ maxLength: 6 })),
        fc.nat(),
        (raw, dflt) => {
          const n = Number(raw)
          const blank = raw.trim() === ""
          const ok = blank || (Number.isSafeInteger(n) && n >= 0)
          if (ok) expect(envNonNegInt({ X: raw }, "X", dflt)).toBe(blank ? dflt : n)
          else expect(() => envNonNegInt({ X: raw }, "X", dflt)).toThrow(UsageError)
        }
      ),
      params(500)
    )
    expect(envNonNegInt({}, "X", 7)).toBe(7)
  })
})

describe("R3 RUSH_COBUILD_ENABLED is opt-in", () => {
  it("law: off for unset/0/false/no/off, on for 1/true/yes/on (any case), otherwise a usage error", () => {
    const off = ["", "0", "false", "no", "off"]
    const on = ["1", "true", "yes", "on"]
    const caseVariants = (s: string) => fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((bs) => [...s].map((c, i) => (bs[i] ? c.toUpperCase() : c)).join(""))
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...off, ...on).chain(caseVariants), fc.string({ maxLength: 6 })), (raw) => {
        const v = raw.trim().toLowerCase()
        if (off.includes(v)) expect(cobuildsEnabled({ RUSH_COBUILD_ENABLED: raw })).toBe(false)
        else if (on.includes(v)) expect(cobuildsEnabled({ RUSH_COBUILD_ENABLED: raw })).toBe(true)
        else expect(() => cobuildsEnabled({ RUSH_COBUILD_ENABLED: raw })).toThrow(UsageError)
      }),
      params(300)
    )
    expect(cobuildsEnabled({})).toBe(false)
  })
})

describe("R4 fs bucket rate window", () => {
  it("NaN, infinite and negative windows are refused; finite non-negative ones accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "cobuild-hard-"))
    dirs.push(dir)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5]) expect(() => makeFsBucket(dir, { rateLimitMs: bad }), String(bad)).toThrow(RangeError)
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), (ok) => {
        expect(() => makeFsBucket(dir, { rateLimitMs: ok })).not.toThrow()
      }),
      params(100)
    )
  })
})

describe("R5 Worker configuration fails closed", () => {
  const bucket = makeFakeBucket({ locks: makeMemoryStore(0) })
  it("missing or invalid scope, empty token, bad TTL are refused; a valid configuration passes", () => {
    expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "t" })).toBe("string")
    expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "t", COBUILD_SCOPE: "" })).toBe("string")
    expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "t", COBUILD_SCOPE: "Not Valid" })).toBe("string")
    expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "", COBUILD_SCOPE: "trusted" })).toBe("string")
    for (const ttl of ["abc", "0", "-5", "1.5", "NaN", ""]) {
      expect(typeof workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "t", COBUILD_SCOPE: "trusted", BISECT_TOKEN_TTL_S: ttl }), ttl).toBe("string")
    }
    const cfg = workerConfig({ CACHE_BUCKET: bucket, API_TOKEN: "t", COBUILD_SCOPE: "pr", BISECT_TOKEN_TTL_S: "600" })
    if (typeof cfg === "string") throw new Error(cfg)
    // `toEqual` cannot see inside a `Redacted`, so the token is compared unwrapped.
    expect({ ...cfg, token: Redacted.value(cfg.token) }).toEqual({ scope: "pr", token: "t", tokenTtl: Duration.minutes(10) })
  })
})

describe("R6 bounded-concurrency map", () => {
  it("law: results equal map, in order; in-flight calls never exceed the limit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { maxLength: 40 }), fc.integer({ min: 1, max: 8 }), async (xs, limit) => {
        let inFlight = 0
        let peak = 0
        const out = await mapBounded(xs, limit, async (x) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((r) => setTimeout(r, Math.abs(x) % 3))
          inFlight--
          return x * 2
        })
        expect(out).toEqual(xs.map((x) => x * 2))
        expect(peak).toBeLessThanOrEqual(limit)
      }),
      params(60)
    )
  })
})
