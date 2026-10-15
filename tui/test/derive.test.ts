/**
 * Laws of `src/derive.ts` (rules R1–R6) and of input validation, checked on
 * random inputs from the whole valid domain (every number of `inputs.json`
 * perturbed, zeroed or kept; list elements dropped), not on the demo's own
 * values.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { InputError, parseInputs } from "../src/data.ts"
import {
  agreesAtPrecision,
  amdahl,
  BRIEF_SCC_BIT,
  BRIEF_SET_B,
  barCells,
  dataNotes,
  type Derived,
  deriveFigures,
  type Figures,
  format,
  normalizedBars,
  ratio
} from "../src/derive.ts"
import { genRawInputs, isDeriveError, RAW, tryInputs } from "./gen.ts"
import { announce, law, refutes, type Rng } from "./prop.ts"

announce("test/derive.test.ts")

const isDerived = (x: unknown): x is Derived =>
  typeof x === "object" && x !== null && "value" in x && "unit" in x && "formula" in x && "deps" in x

/** Every `Derived` reachable from a value, with its path. */
const allDerived = (x: unknown, path = "fig"): Array<{ path: string; d: Derived }> => {
  if (isDerived(x)) return [{ path, d: x }]
  if (Array.isArray(x)) return x.flatMap((v, i) => allDerived(v, `${path}[${i}]`))
  if (typeof x === "object" && x !== null) return Object.entries(x).flatMap(([k, v]) => allDerived(v, `${path}.${k}`))
  return []
}

const close = (a: number, b: number, what: string): void => {
  if (a === b) return
  const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} ≠ ${b}`)
}

/** Figures of random inputs, or null when the inputs are invalid. */
const figuresOf = (r: Rng): { fig: Figures; raw: Record<string, unknown> } | null => {
  const raw = genRawInputs(r)
  const inp = tryInputs(raw)
  if (inp === null) return null
  try {
    return { fig: deriveFigures(inp), raw }
  } catch (e) {
    if (isDeriveError(e)) return null
    throw e
  }
}

test("R1/R2: every derived figure has a unit, a formula and dependencies, and formats with its unit", () => {
  law(
    "derived figures are complete",
    300,
    figuresOf,
    (x) => {
      if (x === null) return { valid: false, boundary: false }
      const ds = allDerived(x.fig)
      assert.ok(ds.length > 0)
      for (const { path, d } of ds) {
        assert.equal(typeof d.value, "number", path)
        assert.ok(!Number.isNaN(d.value), `${path} is NaN`)
        assert.ok(d.unit.length > 0, `${path} has no unit`)
        assert.ok(d.formula.trim().length > 0, `${path} has no formula`)
        assert.ok(d.deps.length > 0, `${path} has no dependencies`)
        const text = format(d)
        assert.ok(text.length > 0)
        if (!Number.isFinite(d.value)) assert.ok(text.includes("∞"), `${path}: ${text}`)
      }
      return { valid: true, boundary: ds.some(({ d }) => !Number.isFinite(d.value)) }
    },
    { domain: "perturbed inputs (numbers ×[0,3], 8% zeroed; list elements dropped; 10% zero Cobuilds cost)", minValidFraction: 0.9, minBoundary: 3 }
  )
})

test("R3: every total equals the sum of the items it is shown with", () => {
  law(
    "totals are sums",
    300,
    figuresOf,
    (x) => {
      if (x === null) return { valid: false, boundary: false }
      const c = x.fig.cost
      close(c.ghaPerRun.value, c.perRun.reduce((a, r) => a + (r.gha?.value ?? 0), 0), "GHA per run")
      close(c.cobuildsPerRun.value, c.perRun.reduce((a, r) => a + (r.cobuilds?.value ?? 0), 0), "Cobuilds per run")
      close(c.driversTotal.value, c.drivers.reduce((a, d) => a + d.cost.value, 0), "drivers total")
      for (const d of c.drivers) close(d.cost.value, d.qty.value * d.price.value, `driver ${d.driver.id}`)
      close(x.fig.cache.stored.value, x.fig.cache.blobs.reduce((a, b) => a + b.size.value, 0), "stored")
      for (const p of x.fig.phases) {
        close(p.total.value, p.import.value + p.enumFilter.value + p.traversal.value, `phase ${p.variant}`)
        if (p.total.value > 0) close(p.importPct.value + p.enumFilterPct.value + p.traversalPct.value, 100, `phase ${p.variant} shares`)
      }
      // Cobuilds monthly = the itemised monthly drivers + the per-run runner and transfer times runs.
      close(c.cobuildsMonthly.value, c.driversTotal.value + c.cobuildsRunnerMonthly.value + c.cobuildsTransferMonthly.value, "Cobuilds monthly")
      return { valid: true, boundary: c.drivers.some((d) => d.cost.value === 0) }
    },
    { domain: "as above", minValidFraction: 0.9, minBoundary: 10 }
  )
})

test("R4: monthly figures are per-run figures times runs per month; savings and ROI follow from them", () => {
  law(
    "monthly = per run × runs",
    300,
    figuresOf,
    (x) => {
      if (x === null) return { valid: false, boundary: false }
      const c = x.fig.cost
      const runs = c.runsPerMonth.value
      close(c.ghaMonthly.value, c.ghaPerRun.value * runs, "GHA monthly")
      close(c.ghaLargerMonthly.value, c.ghaLargerPerRun.value * runs, "GHA larger monthly")
      close(c.cobuildsMonthly.value, c.cobuildsPerRun.value * runs, "Cobuilds monthly")
      close(c.savingsMonthly.value, c.ghaMonthly.value - c.cobuildsMonthly.value, "savings")
      close(c.annual.value, c.savingsMonthly.value * 12, "annual")
      if (c.cobuildsMonthly.value === 0) assert.equal(c.roi.value, c.ghaMonthly.value === 0 ? 0 : Infinity)
      else close(c.roi.value, c.ghaMonthly.value / c.cobuildsMonthly.value, "ROI")
      return { valid: true, boundary: c.cobuildsMonthly.value === 0 }
    },
    { domain: "as above", minValidFraction: 0.9, minBoundary: 3 }
  )
})

test("R4 rejects a model whose monthly headline is typed rather than derived", () => {
  // Broken variant: the monthly GHA cost is a constant; the law must notice once the inputs vary.
  const typed = (fig: Figures) => ({ ...fig.cost, ghaMonthly: { ...fig.cost.ghaMonthly, value: deriveFigures(parseInputs(RAW)).cost.ghaMonthly.value } })
  assert.ok(
    refutes(100, figuresOf, (x) => {
      if (x === null) return true
      const c = typed(x.fig)
      return Math.abs(c.ghaMonthly.value - c.ghaPerRun.value * c.runsPerMonth.value) < 1e-9
    })
  )
})

test("R5: ratio is ∞ for a zero denominator and a/b otherwise; format shows ∞", () => {
  law(
    "ratio",
    500,
    (r) => ({ a: r.chance(0.2) ? 0 : r.next() * 1000, b: r.chance(0.3) ? 0 : r.next() * 1000 }),
    ({ a, b }) => {
      const q = ratio(a, b)
      if (b === 0) assert.equal(q, a === 0 ? 0 : Infinity)
      else close(q, a / b, "a/b")
      if (q === Infinity) assert.match(format({ value: q, unit: "×", formula: "f", deps: ["d"] }), /∞/)
      return { valid: true, boundary: b === 0 }
    },
    { domain: "a, b ∈ {0} ∪ [0, 1000)", minValidFraction: 1, minBoundary: 50 }
  )
})

test("bars: barCells clamps to [0, width]; normalizedBars gives the largest value the full bar and keeps order", () => {
  law(
    "bars",
    600,
    (r) => ({
      f: r.pick([Number.NaN, -1, 0, 1, 2, Infinity, r.next(), r.next() * 3 - 1]),
      w: r.int(0, 40),
      values: Array.from({ length: r.int(1, 6) }, () => (r.chance(0.2) ? 0 : r.chance(0.1) ? -r.next() : r.next() * 1e4)),
      maxBar: r.int(1, 40)
    }),
    ({ f, w, values, maxBar }) => {
      const n = barCells(f, w)
      assert.ok(Number.isInteger(n) && n >= 0 && n <= w, `barCells(${f}, ${w}) = ${n}`)
      if (f >= 1) assert.equal(n, w)
      if (!(f > 0)) assert.equal(n, 0)
      const bars = normalizedBars(values, maxBar)
      const top = Math.max(...values)
      bars.forEach((b, i) => {
        assert.ok(b >= 0 && b <= maxBar)
        if (values[i]! <= 0) assert.equal(b, 0)
        else assert.ok(b >= 1)
        if (values[i] === top && top > 0) assert.equal(b, maxBar)
        bars.forEach((c, j) => {
          if (values[i]! < values[j]!) assert.ok(b <= c, "order not kept")
        })
      })
      // Not all bars the same length unless the values are (the brief's x / x * maxBar bug).
      const distinctPositive = new Set(values.filter((v) => v > 0)).size
      if (distinctPositive > 1 && Math.min(...values.filter((v) => v > 0)) / top < 0.5 - 1 / maxBar) assert.ok(new Set(bars).size > 1)
      return { valid: true, boundary: f >= 1 || !(f > 0) || values.every((v) => v <= 0) }
    },
    { domain: "fractions incl. NaN/±∞/out of range; widths 0–40; 1–6 values incl. 0 and negatives", minValidFraction: 1, minBoundary: 100 }
  )
  // Broken variant (the brief's chart): every bar normalised against itself.
  const selfNormalised = (values: number[], maxBar: number) => values.map((v) => (v / v) * maxBar)
  assert.ok(refutes(100, (r) => [r.next() * 10 + 1, r.next() * 10 + 20], (vs) => new Set(selfNormalised(vs, 30)).size > 1))
})

test("Amdahl: the prediction lies between the serial part and the one-core time and falls with cores", () => {
  law(
    "amdahl",
    400,
    (r) => {
      const one = r.next() * 1000 + 1e-3
      return { one, serial: r.chance(0.1) ? 0 : r.chance(0.1) ? one : r.next() * one, cores: r.int(1, 256) }
    },
    ({ one, serial, cores }) => {
      const p = amdahl(one, serial, cores)
      assert.ok(p >= serial - 1e-9 && p <= one + 1e-9)
      assert.ok(amdahl(one, serial, cores + 1) <= p + 1e-9)
      if (cores === 1) close(p, one, "one core")
      return { valid: true, boundary: cores === 1 || serial === 0 || serial === one }
    },
    { domain: "oneCore ∈ (0, 1000], serial ∈ [0, oneCore], cores 1–256", minValidFraction: 1, minBoundary: 30 }
  )
})

test("format: every unit is shown, money has a $ sign, and bare drops only the suffix", () => {
  const units = ["USD", "USD/run", "USD/month", "USD/year", "%", "×", "s", "ms", "MB", "GB", "GB-month", "M ops", "theorems", "runs/month", "cores", "lines"] as const
  law(
    "format",
    600,
    (r) => ({ unit: r.pick(units), value: r.chance(0.1) ? 0 : r.chance(0.05) ? Infinity : (r.next() - 0.2) * 10 ** r.int(0, 6) }),
    ({ unit, value }) => {
      const d: Derived = { value, unit, formula: "f", deps: ["d"] }
      const text = format(d)
      if (unit.startsWith("USD") && Number.isFinite(value)) assert.match(text, /\$/)
      if (unit.includes("/") && unit.startsWith("USD")) assert.ok(text.endsWith(unit.slice(3)), text)
      if (!unit.startsWith("USD") && unit !== "cores" && unit !== "ms" && unit !== "MB") assert.ok(text.includes(unit === "GB-month" ? "GB-month" : unit), `${text} lacks ${unit}`)
      const bare = format(d, { bare: true })
      assert.ok(!/[a-zA-Z%×]/.test(bare.replace("∞", "")), `bare ${bare}`)
      return { valid: true, boundary: value === 0 || !Number.isFinite(value) }
    },
    { domain: "16 units, values 0, ∞ and −20%..80% of 10^0..10^6", minValidFraction: 1, minBoundary: 50 }
  )
})

test("data notes: the verdict is 'agrees' exactly when the brief's figure equals the derived one at the brief's precision", () => {
  law(
    "data notes",
    200,
    figuresOf,
    (x) => {
      if (x === null) return { valid: false, boundary: false }
      const inp = parseInputs(x.raw)
      const notes = dataNotes(inp, x.fig)
      for (const n of notes) {
        if (n.derived === null) assert.equal(n.verdict, "not derivable")
        else if (n.verdict === "agrees" || n.verdict === "differs") {
          assert.ok("value" in n.stated)
          assert.equal(n.verdict === "agrees", agreesAtPrecision(n.stated.value, n.derived.value), n.figure)
        }
        assert.ok(n.decision.length > 0)
      }
      return { valid: true, boundary: notes.some((n) => n.verdict === "agrees") }
    },
    { domain: "as above", minValidFraction: 0.9, minBoundary: 5 }
  )
})

/**
 * Load a planted source mutant of a module in `src/` (a patched copy next to
 * the original, so its relative imports resolve; removed right after import).
 */
const loadSrcMutant = async <M>(file: string, patches: ReadonlyArray<readonly [string, string]>): Promise<M> => {
  const src = new URL(`../src/${file}`, import.meta.url)
  let code = readFileSync(src, "utf8")
  for (const [from, to] of patches) {
    if (!code.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from}`)
    code = code.replace(from, to)
  }
  const copy = new URL(`../src/${file.replace(/\.ts$/, "")}.mutant-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.ts`, import.meta.url)
  writeFileSync(copy, code)
  try {
    return (await import(copy.href)) as M
  } finally {
    rmSync(copy, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Validation messages name the field (replaces an assertion that accepted any
// message containing "must be").

/** Path of a field as the messages write it: `a.b[2].c`. */
const fieldPath = (p: ReadonlyArray<string>): string => p.map((k, i) => (/^\d+$/.test(k) ? `[${k}]` : i === 0 ? k : `.${k}`)).join("")
const numberPaths = (x: unknown, path: string[] = []): string[][] =>
  typeof x === "number"
    ? [path]
    : Array.isArray(x)
      ? x.flatMap((v, i) => numberPaths(v, [...path, String(i)]))
      : typeof x === "object" && x !== null
        ? Object.entries(x).flatMap(([k, v]) => numberPaths(v, [...path, k]))
        : []
const NUMBER_PATHS = numberPaths(RAW)
const BAD_NUMBERS = [-1, -1e-9, Number.NaN, Infinity, "12", null] as const
const genBadNumber = (r: Rng) => ({ path: r.pick(NUMBER_PATHS), bad: r.pick(BAD_NUMBERS) })
const withValue = (path: ReadonlyArray<string>, bad: unknown): Record<string, unknown> => {
  const raw = structuredClone(RAW) as Record<string, unknown>
  let o = raw as Record<string, unknown>
  for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>
  o[path[path.length - 1]!] = bad
  return raw
}
type DataModule = { parseInputs: typeof parseInputs; InputError: typeof InputError }
/**
 * Requirement: a bad number anywhere is rejected with an input error whose
 * message names the field by its full path — the bare key is ambiguous
 * (`perTheoremMs` exists once per algorithm), and "must be" alone names nothing.
 */
const rejectsNamingField = (m: DataModule, c: { path: ReadonlyArray<string>; bad: unknown }): boolean => {
  try {
    m.parseInputs(withValue(c.path, c.bad))
    return false
  } catch (e) {
    return e instanceof m.InputError && e.message.includes(fieldPath(c.path))
  }
}
const REAL_DATA: DataModule = { parseInputs, InputError }
const NUM_MESSAGE = "throw new InputError(`${path}.${k} must be a finite number"
/** Mutant 1: the message names only the bare key. */
const bareKeyMessage = () => loadSrcMutant<DataModule>("data.ts", [[NUM_MESSAGE, "throw new InputError(`${k} must be a finite number"]])
/** Mutant 2: the message names no field at all. */
const noFieldMessage = () => loadSrcMutant<DataModule>("data.ts", [[NUM_MESSAGE, "throw new InputError(`value must be a finite number"]])
/** The assertion the old test made (any message with the bare key, or any "must be"). */
const oldAssertion = (m: DataModule, c: { path: ReadonlyArray<string>; bad: unknown }): boolean => {
  try {
    m.parseInputs(withValue(c.path, c.bad))
    return false
  } catch (e) {
    return e instanceof m.InputError && (e.message.includes(c.path[c.path.length - 1]!) || /must be/.test(e.message))
  }
}

test("validation law: a negative, non-finite or mistyped number anywhere in the inputs is rejected, naming the field by its full path", () => {
  law(
    "bad numbers rejected with the field path",
    400,
    genBadNumber,
    (c) => {
      assert.ok(rejectsNamingField(REAL_DATA, c), `${fieldPath(c.path)} = ${String(c.bad)}`)
      return { valid: true, boundary: c.path[0] === "run" || c.path.some((k) => /^\d+$/.test(k)) }
    },
    { domain: `every numeric field of inputs.json (${NUMBER_PATHS.length}) set to −1, −1e−9, NaN, ∞, a string or null`, minValidFraction: 1, minBoundary: 20 }
  )
  // The domain is finite: check all of it, too.
  for (const path of NUMBER_PATHS) for (const bad of BAD_NUMBERS) assert.ok(rejectsNamingField(REAL_DATA, { path, bad }), `${fieldPath(path)} = ${String(bad)}`)
})

test("validation counterexample 1 (mutant: bare key): algorithms[2].perTheoremMs = −1 — the old assertion accepts the mutant, the law does not", async () => {
  const m = await bareKeyMessage()
  const c = { path: ["algorithms", "2", "perTheoremMs"], bad: -1 }
  assert.equal(rejectsNamingField(REAL_DATA, c), true)
  assert.equal(oldAssertion(m, c), true)
  assert.equal(rejectsNamingField(m, c), false)
})

test("validation counterexample 2 (mutant: no field): briefStated.phaseShares[1].import = NaN — the old assertion accepts the mutant, the law does not", async () => {
  const m = await noFieldMessage()
  const c = { path: ["briefStated", "phaseShares", "1", "import"], bad: Number.NaN }
  assert.equal(rejectsNamingField(REAL_DATA, c), true)
  assert.equal(oldAssertion(m, c), true)
  assert.equal(rejectsNamingField(m, c), false)
})

test("validation negation 1: the law is refuted for the bare-key mutant", async () => {
  const m = await bareKeyMessage()
  assert.equal(refutes(200, genBadNumber, (c) => rejectsNamingField(m, c)), true)
})

test("validation negation 2: the law is refuted for the no-field mutant", async () => {
  const m = await noFieldMessage()
  assert.equal(refutes(200, genBadNumber, (c) => rejectsNamingField(m, c)), true)
})

// ---------------------------------------------------------------------------
// The brief's algorithm figures are compared with the algorithm they name
// (replaces nothing: the generator kept the algorithm list whole, so the
// absent and reordered cases were never exercised).

/**
 * Inputs where the algorithm list may be reordered, and an algorithm renamed
 * (consistently in phases and auditCache, so the inputs stay valid).
 */
const genAlgorithmVariants = (r: Rng): Record<string, unknown> => {
  const raw = genRawInputs(r) as Record<string, unknown>
  const algs = raw["algorithms"] as Array<{ name: string; perTheoremMs: number }>
  if (r.chance(0.5)) {
    for (let i = algs.length - 1; i > 0; i--) {
      const j = r.int(0, i)
      ;[algs[i], algs[j]] = [algs[j]!, algs[i]!]
    }
  }
  if (r.chance(0.5)) {
    const victim = r.pick(algs)
    const fresh = `variant-${r.int(1, 999)}`
    for (const p of raw["phases"] as Array<{ variant: string }>) if (p.variant === victim.name) p.variant = fresh
    const ac = raw["auditCache"] as { coldVariant: string }
    if (ac.coldVariant === victim.name) ac.coldVariant = fresh
    victim.name = fresh
  }
  return raw
}
const BRIEF_ALGORITHM_NOTES = [
  { figure: "SCC+bit total", name: BRIEF_SCC_BIT, pick: (a: Figures["algorithms"][number]) => a.total },
  { figure: "Set B speedup", name: BRIEF_SET_B, pick: (a: Figures["algorithms"][number]) => a.speedup }
] as const
type DeriveModule = { dataNotes: typeof dataNotes; deriveFigures: typeof deriveFigures }
/**
 * Requirement: each of the brief's algorithm figures is compared with the
 * algorithm of the name it refers to, wherever that algorithm is in the list;
 * if there is no algorithm of that name the figure is "not derivable".
 */
const algorithmNotesFollowRule = (m: DeriveModule, raw: Record<string, unknown>): boolean | null => {
  const inp = tryInputs(raw)
  if (inp === null) return null
  let fig: Figures
  try {
    fig = m.deriveFigures(inp)
  } catch (e) {
    if (isDeriveError(e) || (e as Error).name === "DeriveError") return null
    throw e
  }
  const notes = m.dataNotes(inp, fig)
  return BRIEF_ALGORITHM_NOTES.every(({ figure, name, pick }) => {
    const n = notes.find((x) => x.figure === figure)
    if (n === undefined) return false
    const a = fig.algorithms.find((x) => x.name === name)
    if (a === undefined) return n.derived === null && n.verdict === "not derivable"
    return n.derived !== null && Object.is(n.derived.value, pick(a).value) && n.derived.formula === pick(a).formula
  })
}
const REAL_DERIVE: DeriveModule = { dataNotes, deriveFigures }
/** Mutant 1: the code this law replaced — Set B falls back to the first algorithm, SCC+bit is the last one. */
const fallbackToFirst = () =>
  loadSrcMutant<DeriveModule>("derive.ts", [
    ['byName(BRIEF_SCC_BIT, "SCC+bit total", st("sccBitTotalS", b.sccBitTotalS, "ms"), (a) => a.total,', 'cmp("SCC+bit total", st("sccBitTotalS", b.sccBitTotalS, "ms"), fig.algorithms[fig.algorithms.length - 1]!.total,'],
    ['byName(BRIEF_SET_B, "Set B speedup", st("setBSpeedup", b.setBSpeedup, "×"), (a) => a.speedup,', 'cmp("Set B speedup", st("setBSpeedup", b.setBSpeedup, "×"), (fig.algorithms.find((a) => a.name === "Set B") ?? fig.algorithms[0]!).speedup,']
  ])
/** Mutant 2: positions of the demo data hard-coded (Set B is index 2, SCC+bit index 3). */
const positional = () =>
  loadSrcMutant<DeriveModule>("derive.ts", [
    ['byName(BRIEF_SCC_BIT, "SCC+bit total", st("sccBitTotalS", b.sccBitTotalS, "ms"), (a) => a.total,', 'cmp("SCC+bit total", st("sccBitTotalS", b.sccBitTotalS, "ms"), fig.algorithms[3]!.total,'],
    ['byName(BRIEF_SET_B, "Set B speedup", st("setBSpeedup", b.setBSpeedup, "×"), (a) => a.speedup,', 'cmp("Set B speedup", st("setBSpeedup", b.setBSpeedup, "×"), fig.algorithms[2]!.speedup,']
  ])

test("data notes law: the brief's algorithm figures are compared with the algorithm they name; absent → not derivable", () => {
  law(
    "algorithm figures by name",
    300,
    genAlgorithmVariants,
    (raw) => {
      const ok = algorithmNotesFollowRule(REAL_DERIVE, raw)
      if (ok === null) return { valid: false, boundary: false }
      assert.ok(ok, JSON.stringify(raw["algorithms"]))
      const names = (raw["algorithms"] as Array<{ name: string }>).map((a) => a.name)
      return { valid: true, boundary: !names.includes(BRIEF_SET_B) || !names.includes(BRIEF_SCC_BIT) }
    },
    { domain: "random inputs; algorithm list shuffled in half the cases, one algorithm renamed in half", minValidFraction: 0.5, minBoundary: 10 }
  )
})

/** The demo inputs with one algorithm renamed (in phases and auditCache too) and/or the algorithm list reversed. */
const demoWith = (opts: { readonly rename?: readonly [string, string]; readonly reverse?: boolean }): Record<string, unknown> => {
  const raw = structuredClone(RAW) as Record<string, unknown>
  const algs = raw["algorithms"] as Array<{ name: string }>
  if (opts.rename !== undefined) {
    const [from, to] = opts.rename
    for (const a of algs) if (a.name === from) a.name = to
    for (const p of raw["phases"] as Array<{ variant: string }>) if (p.variant === from) p.variant = to
    const ac = raw["auditCache"] as { coldVariant: string }
    if (ac.coldVariant === from) ac.coldVariant = to
  }
  if (opts.reverse === true) algs.reverse()
  return raw
}

test("data notes counterexample 1 (mutant: fallback to the first algorithm): Set B renamed — the figure is not derivable, not 1×", async () => {
  const m = await fallbackToFirst()
  const raw = demoWith({ rename: [BRIEF_SET_B, "Set B (renamed)"] })
  assert.equal(algorithmNotesFollowRule(REAL_DERIVE, raw), true)
  assert.equal(algorithmNotesFollowRule(m, raw), false)
  // On the demo inputs as they are, the mutant is indistinguishable:
  assert.equal(algorithmNotesFollowRule(m, structuredClone(RAW) as Record<string, unknown>), true)
})

test("data notes counterexample 2 (mutant: demo positions): algorithms listed in reverse — each figure still uses its named algorithm", async () => {
  const m = await positional()
  const raw = demoWith({ reverse: true })
  assert.equal(algorithmNotesFollowRule(REAL_DERIVE, raw), true)
  assert.equal(algorithmNotesFollowRule(m, raw), false)
  assert.equal(algorithmNotesFollowRule(m, structuredClone(RAW) as Record<string, unknown>), true)
})

test("data notes negation 1: the law is refuted for the fallback-to-first mutant", async () => {
  const m = await fallbackToFirst()
  assert.equal(refutes(300, genAlgorithmVariants, (raw) => algorithmNotesFollowRule(m, raw) !== false), true)
})

test("data notes negation 2: the law is refuted for the demo-positions mutant", async () => {
  const m = await positional()
  assert.equal(refutes(300, genAlgorithmVariants, (raw) => algorithmNotesFollowRule(m, raw) !== false), true)
})
