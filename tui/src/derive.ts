/**
 * Every figure the dashboard displays, derived from `inputs.json`.
 *
 * Rules (enforced by `test/derive.test.ts` and `test/lint.test.ts`):
 * - R1. A displayed number is a `Derived`: `{ value, unit, formula, deps }`.
 *   Inputs shown as they are go through `input()` (formula = the input path).
 * - R2. Every `Derived` has a non-empty unit and formula, and its deps name
 *   input paths (`inputs.*`) or other derived figures.
 * - R3. Totals are sums of the displayed items, so an itemised list always
 *   adds up to its headline (the brief's $141.08 vs $180 cannot recur).
 * - R4. Monthly figures are per-run figures times `workload.runsPerMonth`, so
 *   a monthly headline and a per-run cost always agree (the brief's $2,400
 *   vs 30 runs × $1.32 cannot recur).
 * - R5. Ratios with a zero denominator are `Infinity` and are shown as "∞".
 * - R6. Nothing in this file is a raw number except 0, 1, 100 (percent), 12
 *   (months per year), 1000 (unit prefixes) and 60/3600/24 (clock units).
 */
import type { Driver, Inputs } from "./data.ts"

export type Unit =
  | "USD"
  | "USD/run"
  | "USD/month"
  | "USD/year"
  | "%"
  | "×"
  | "s"
  | "ms"
  | "MB"
  | "GB"
  | "GB-month"
  | "M ops"
  | "M req"
  | "M hrs"
  | "theorems"
  | "constants"
  | "files"
  | "packages"
  | "chunks"
  | "repos"
  | "SCCs"
  | "levels"
  | "lines"
  | "runs/month"
  | "min/run"
  | "cores"
  | "blobs"
  | "axioms"
  | "clock"
  | "level"
  | "agents"
  | "ops"
  | "panels"
  | "runs"
  // Units of the clean build-pipeline scenario (`src/clean/`).
  | "commits"
  | "modules"
  | "steps"
  | "hits"
  | "misses"
  | "passes"
  | "fails"
  | "restores"
  | "probability"
  // Units of the charts view (`src/charts/`).
  | "events"
  | "writes"

export interface Derived {
  readonly value: number
  readonly unit: Unit
  readonly formula: string
  readonly deps: ReadonlyArray<string>
}

export const der = (value: number, unit: Unit, formula: string, deps: ReadonlyArray<string>): Derived => ({ value, unit, formula, deps })

/** An input shown as it is (R1). */
export const input = (path: string, value: number, unit: Unit): Derived => der(value, unit, `inputs.${path}`, [`inputs.${path}`])

const sum = (xs: ReadonlyArray<number>): number => xs.reduce((a, b) => a + b, 0)

/** `a / b`, with `Infinity` for a zero denominator (R5; `0 / 0` is 0). */
export const ratio = (a: number, b: number): number => (b === 0 ? (a === 0 ? 0 : Infinity) : a / b)

/** Percentage `a / b × 100` (0 when `b` is 0). */
export const pct = (a: number, b: number): number => (b === 0 ? 0 : (a / b) * 100)

/** A percentage figure as a fraction (for bars). */
export const fractionOfPct = (d: Derived): number => d.value / 100

/** Amdahl prediction: serial part plus the parallel part divided over `cores`. */
export const amdahl = (oneCoreS: number, serialS: number, cores: number): number => serialS + (oneCoreS - serialS) / cores

/** Filled cells of a bar of `w` cells for a fraction (clamped to [0, 1], so ∞ is full; NaN → 0). */
export const barCells = (fraction: number, w: number): number =>
  Math.max(0, Math.min(w, Math.floor((Number.isNaN(fraction) ? 0 : Math.max(0, Math.min(1, fraction))) * w)))

/** Bar lengths of `values` normalised against their maximum (the largest gets `maxBar`; at least 1 for a positive value). */
export const normalizedBars = (values: ReadonlyArray<number>, maxBar: number): number[] => {
  const top = Math.max(0, ...values)
  return values.map((v) => (top === 0 || v <= 0 ? 0 : Math.max(1, Math.round((v / top) * maxBar))))
}

// ---------------------------------------------------------------------------
// Static figures (do not depend on script time)

export interface AlgorithmFigures {
  readonly name: string
  readonly perTheorem: Derived
  readonly total: Derived
  readonly speedup: Derived
}

export interface PhaseFigures {
  readonly variant: string
  readonly import: Derived
  readonly enumFilter: Derived
  readonly traversal: Derived
  readonly total: Derived
  readonly importPct: Derived
  readonly enumFilterPct: Derived
  readonly traversalPct: Derived
}

export interface CostRow {
  readonly item: string
  readonly gha: Derived | null
  readonly cobuilds: Derived | null
}

export interface DriverFigures {
  readonly driver: Driver
  readonly qty: Derived
  readonly price: Derived
  readonly cost: Derived
}

export interface Figures {
  readonly project: { readonly theorems: Derived; readonly constants: Derived; readonly latency: Derived }
  readonly algorithms: ReadonlyArray<AlgorithmFigures>
  readonly phases: ReadonlyArray<PhaseFigures>
  readonly resources: { readonly variant: string; readonly wall: Derived; readonly cpu: Derived; readonly cores: Derived; readonly peakMem: Derived; readonly allocated: Derived }
  readonly auditCache: { readonly coldVariant: string; readonly cold: Derived; readonly warm: Derived; readonly warmHitRate: Derived }
  readonly graph: { readonly sccCount: Derived; readonly maxScc: Derived; readonly maxDepth: Derived; readonly vertices: Derived; readonly cacheFile: Derived }
  readonly scaling: {
    readonly theorems: Derived
    readonly oneCore: Derived
    readonly baseCores: Derived
    readonly limit: Derived
    readonly rows: ReadonlyArray<{ readonly cores: Derived; readonly total: Derived; readonly speedup: Derived; readonly amdahl: Derived }>
  }
  readonly cache: {
    readonly inputs: Derived
    readonly deps: Derived
    readonly zstdLevel: Derived
    readonly blobs: ReadonlyArray<{ readonly digest: string; readonly size: Derived; readonly shared: Derived }>
    readonly blobCount: Derived
    readonly stored: Derived
    readonly raw: Derived
    readonly dedup: Derived
    readonly saved: Derived
    readonly savedPct: Derived
    readonly hitRate: Derived
    readonly chunks: Derived
    readonly buildMs: Derived
  }
  readonly axioms: { readonly forbiddenFound: Derived; readonly checked: Derived }
  readonly cost: {
    readonly runsPerMonth: Derived
    readonly minutesPerRun: Derived
    readonly perRun: ReadonlyArray<CostRow>
    readonly ghaPerRun: Derived
    readonly ghaLargerPerRun: Derived
    readonly cobuildsPerRun: Derived
    readonly savingsPerRun: Derived
    readonly reductionPct: Derived
    readonly drivers: ReadonlyArray<DriverFigures>
    readonly driversTotal: Derived
    readonly cobuildsRunnerMonthly: Derived
    readonly cobuildsTransferMonthly: Derived
    readonly ghaMonthly: Derived
    readonly ghaLargerMonthly: Derived
    readonly cobuildsMonthly: Derived
    readonly savingsMonthly: Derived
    readonly savingsPct: Derived
    readonly annual: Derived
    readonly roi: Derived
    readonly assumptions: ReadonlyArray<{ readonly label: string; readonly value: Derived; readonly per: string }>
  }
}

export class DeriveError extends Error {
  override readonly name = "DeriveError"
}

/** All static figures of the dashboard (R1–R6). */
export const deriveFigures = (inp: Inputs): Figures => {
  const n = inp.project.theorems
  const algByName = new Map(inp.algorithms.map((a, i) => [a.name, { a, i }]))
  const base = inp.algorithms[0]!
  const algorithms = inp.algorithms.map((a, i): AlgorithmFigures => ({
    name: a.name,
    perTheorem: input(`algorithms[${i}].perTheoremMs`, a.perTheoremMs, "ms"),
    total: der(a.perTheoremMs * n, "ms", `algorithms[${i}].perTheoremMs × project.theorems`, [`inputs.algorithms[${i}].perTheoremMs`, "inputs.project.theorems"]),
    speedup: der(ratio(base.perTheoremMs, a.perTheoremMs), "×", `algorithms[0].perTheoremMs / algorithms[${i}].perTheoremMs`, ["inputs.algorithms[0].perTheoremMs", `inputs.algorithms[${i}].perTheoremMs`])
  }))

  const phases = inp.phases.map((p, i): PhaseFigures => {
    const alg = algByName.get(p.variant)
    if (alg === undefined) throw new DeriveError(`phases[${i}].variant ${p.variant} has no algorithm of that name`)
    const traversalS = (alg.a.perTheoremMs * n) / 1000
    const totalS = p.importS + p.enumFilterS + traversalS
    const dep = (k: string) => `inputs.phases[${i}].${k}`
    const total = der(totalS, "s", `phases[${i}].importS + phases[${i}].enumFilterS + traversal`, [dep("importS"), dep("enumFilterS"), `algorithms[${alg.i}].total`])
    return {
      variant: p.variant,
      import: input(`phases[${i}].importS`, p.importS, "s"),
      enumFilter: input(`phases[${i}].enumFilterS`, p.enumFilterS, "s"),
      traversal: der(traversalS, "s", `algorithms[${alg.i}].perTheoremMs × project.theorems / 1000`, [`algorithms[${alg.i}].total`]),
      total,
      importPct: der(pct(p.importS, totalS), "%", `importS / total × 100`, [dep("importS"), `phases[${i}].total`]),
      enumFilterPct: der(pct(p.enumFilterS, totalS), "%", `enumFilterS / total × 100`, [dep("enumFilterS"), `phases[${i}].total`]),
      traversalPct: der(pct(traversalS, totalS), "%", `traversal / total × 100`, [`phases[${i}].traversal`, `phases[${i}].total`])
    }
  })
  const current = phases[phases.length - 1]!
  const cold = phases.find((p) => p.variant === inp.auditCache.coldVariant)
  if (cold === undefined) throw new DeriveError(`auditCache.coldVariant ${inp.auditCache.coldVariant} is not a phase variant`)

  const sc = inp.scaling
  const scaling = {
    theorems: input("scaling.theorems", sc.theorems, "theorems"),
    oneCore: input("scaling.oneCoreS", sc.oneCoreS, "s"),
    baseCores: der(1, "cores", "single-core baseline of scaling.oneCoreS", ["inputs.scaling.oneCoreS"]),
    limit: der(sc.serialS, "s", "scaling.serialS (Amdahl limit: cores → ∞)", ["inputs.scaling.serialS"]),
    rows: sc.points.map((p, i) => ({
      cores: input(`scaling.points[${i}].cores`, p.cores, "cores"),
      total: input(`scaling.points[${i}].totalS`, p.totalS, "s"),
      speedup: der(ratio(sc.oneCoreS, p.totalS), "×", `scaling.oneCoreS / scaling.points[${i}].totalS`, ["inputs.scaling.oneCoreS", `inputs.scaling.points[${i}].totalS`]),
      amdahl: der(amdahl(sc.oneCoreS, sc.serialS, p.cores), "s", `serialS + (oneCoreS − serialS) / cores`, ["inputs.scaling.serialS", "inputs.scaling.oneCoreS", `inputs.scaling.points[${i}].cores`])
    }))
  }

  const c = inp.cache
  const storedMB = sum(c.blobs.map((b) => b.sizeMB))
  const cache = {
    inputs: input("cache.inputs", c.inputs, "files"),
    deps: input("cache.deps", c.deps, "packages"),
    zstdLevel: input("cache.zstdLevel", c.zstdLevel, "level"),
    blobs: c.blobs.map((b, i) => ({ digest: b.digest, size: input(`cache.blobs[${i}].sizeMB`, b.sizeMB, "MB"), shared: input(`cache.blobs[${i}].shared`, b.shared, "repos") })),
    blobCount: der(c.blobs.length, "blobs", "count of cache.blobs", ["inputs.cache.blobs"]),
    stored: der(storedMB, "MB", "Σ cache.blobs[i].sizeMB", c.blobs.map((_, i) => `inputs.cache.blobs[${i}].sizeMB`)),
    raw: input("cache.rawMB", c.rawMB, "MB"),
    dedup: der(ratio(c.rawMB, storedMB), "×", "cache.rawMB / stored", ["inputs.cache.rawMB", "cache.stored"]),
    saved: der(c.rawMB - storedMB, "MB", "cache.rawMB − stored", ["inputs.cache.rawMB", "cache.stored"]),
    savedPct: der(pct(c.rawMB - storedMB, c.rawMB), "%", "saved / cache.rawMB × 100", ["cache.saved", "inputs.cache.rawMB"]),
    hitRate: der(c.hitRate * 100, "%", "cache.hitRate × 100", ["inputs.cache.hitRate"]),
    chunks: input("cache.chunks", c.chunks, "chunks"),
    buildMs: input("cache.manifest.buildMs", c.manifest.buildMs, "ms")
  }

  // Cost model -------------------------------------------------------------
  const pr = inp.prices
  const runs = inp.workload.runsPerMonth
  const minutes = inp.workload.ghaMinutesPerRun
  const drivers = inp.drivers.map((d, i): DriverFigures => ({
    driver: d,
    qty: input(`drivers[${i}].qty`, d.qty, d.unit as Unit),
    price: der(d.price, "USD", `drivers[${i}].price (per ${d.priceUnit})`, [`inputs.drivers[${i}].price`]),
    cost: der(d.qty * d.price, "USD/month", `drivers[${i}].qty × drivers[${i}].price`, [`inputs.drivers[${i}].qty`, `inputs.drivers[${i}].price`])
  }))
  const groupMonthly = (g: Driver["group"]) => sum(inp.drivers.filter((d) => d.group === g).map((d) => d.qty * d.price))
  const groupDeps = (g: Driver["group"]) => inp.drivers.flatMap((d, i) => (d.group === g ? [`drivers[${i}].cost`] : []))
  const driversTotalV = sum(drivers.map((d) => d.cost.value))

  const ghaRunner = pr.ghaStandardPerMin * minutes
  const ghaLargerRunner = pr.ghaLargerPerMin * minutes
  const entryGB = storedMB / 1000
  const rows: CostRow[] = [
    {
      item: "Runner",
      gha: der(ghaRunner, "USD/run", "prices.ghaStandardPerMin × workload.ghaMinutesPerRun", ["inputs.prices.ghaStandardPerMin", "inputs.workload.ghaMinutesPerRun"]),
      cobuilds: input("prices.cobuildsRunnerPerRun", pr.cobuildsRunnerPerRun, "USD/run")
    },
    {
      item: "Cache storage",
      gha: input("prices.ghaCacheStoragePerRun", pr.ghaCacheStoragePerRun, "USD/run"),
      cobuilds: der(groupMonthly("storage") / runs, "USD/run", "Σ storage drivers / workload.runsPerMonth", [...groupDeps("storage"), "inputs.workload.runsPerMonth"])
    },
    {
      item: "Cache transfer",
      gha: input("prices.ghaCacheTransferPerRun", pr.ghaCacheTransferPerRun, "USD/run"),
      cobuilds: der(pr.r2EgressPerGB * entryGB, "USD/run", "prices.r2EgressPerGB × cache entry size (GB)", ["inputs.prices.r2EgressPerGB", "cache.stored"])
    },
    {
      item: "R2 operations",
      gha: null,
      cobuilds: der(groupMonthly("operations") / runs, "USD/run", "Σ operation drivers / workload.runsPerMonth", [...groupDeps("operations"), "inputs.workload.runsPerMonth"])
    },
    {
      item: "Coordination",
      gha: null,
      cobuilds: der(groupMonthly("coordination") / runs, "USD/run", "Σ coordination drivers (Workers, DO) / workload.runsPerMonth", [...groupDeps("coordination"), "inputs.workload.runsPerMonth"])
    }
  ]
  const ghaPerRunV = sum(rows.map((r) => r.gha?.value ?? 0))
  const cobPerRunV = sum(rows.map((r) => r.cobuilds?.value ?? 0))
  const ghaLargerPerRunV = ghaLargerRunner + pr.ghaCacheStoragePerRun + pr.ghaCacheTransferPerRun
  const ghaPerRun = der(ghaPerRunV, "USD/run", "Σ GHA per-run items", rows.flatMap((r, i) => (r.gha ? [`cost.perRun[${i}].gha`] : [])))
  const cobuildsPerRun = der(cobPerRunV, "USD/run", "Σ Cobuilds per-run items", rows.flatMap((r, i) => (r.cobuilds ? [`cost.perRun[${i}].cobuilds`] : [])))
  const ghaMonthlyV = ghaPerRunV * runs
  const cobMonthlyV = cobPerRunV * runs
  const cost = {
    runsPerMonth: input("workload.runsPerMonth", runs, "runs/month"),
    minutesPerRun: input("workload.ghaMinutesPerRun", minutes, "min/run"),
    perRun: rows,
    ghaPerRun,
    ghaLargerPerRun: der(ghaLargerPerRunV, "USD/run", "prices.ghaLargerPerMin × minutes + GHA cache storage + transfer", ["inputs.prices.ghaLargerPerMin", "inputs.workload.ghaMinutesPerRun", "inputs.prices.ghaCacheStoragePerRun", "inputs.prices.ghaCacheTransferPerRun"]),
    cobuildsPerRun,
    savingsPerRun: der(ghaPerRunV - cobPerRunV, "USD/run", "ghaPerRun − cobuildsPerRun", ["cost.ghaPerRun", "cost.cobuildsPerRun"]),
    reductionPct: der(pct(ghaPerRunV - cobPerRunV, ghaPerRunV), "%", "savingsPerRun / ghaPerRun × 100", ["cost.savingsPerRun", "cost.ghaPerRun"]),
    drivers,
    driversTotal: der(driversTotalV, "USD/month", "Σ drivers[i].cost", drivers.map((_, i) => `drivers[${i}].cost`)),
    cobuildsRunnerMonthly: der(pr.cobuildsRunnerPerRun * runs, "USD/month", "prices.cobuildsRunnerPerRun × workload.runsPerMonth", ["inputs.prices.cobuildsRunnerPerRun", "inputs.workload.runsPerMonth"]),
    cobuildsTransferMonthly: der(pr.r2EgressPerGB * entryGB * runs, "USD/month", "Cobuilds cache transfer per run × workload.runsPerMonth", ["cost.perRun[2].cobuilds", "inputs.workload.runsPerMonth"]),
    ghaMonthly: der(ghaMonthlyV, "USD/month", "ghaPerRun × workload.runsPerMonth", ["cost.ghaPerRun", "inputs.workload.runsPerMonth"]),
    ghaLargerMonthly: der(ghaLargerPerRunV * runs, "USD/month", "ghaLargerPerRun × workload.runsPerMonth", ["cost.ghaLargerPerRun", "inputs.workload.runsPerMonth"]),
    cobuildsMonthly: der(cobMonthlyV, "USD/month", "cobuildsPerRun × workload.runsPerMonth", ["cost.cobuildsPerRun", "inputs.workload.runsPerMonth"]),
    savingsMonthly: der(ghaMonthlyV - cobMonthlyV, "USD/month", "ghaMonthly − cobuildsMonthly", ["cost.ghaMonthly", "cost.cobuildsMonthly"]),
    savingsPct: der(pct(ghaMonthlyV - cobMonthlyV, ghaMonthlyV), "%", "savingsMonthly / ghaMonthly × 100", ["cost.savingsMonthly", "cost.ghaMonthly"]),
    annual: der((ghaMonthlyV - cobMonthlyV) * 12, "USD/year", "savingsMonthly × 12", ["cost.savingsMonthly"]),
    roi: der(ratio(ghaMonthlyV, cobMonthlyV), "×", "ghaMonthly / cobuildsMonthly (∞ if Cobuilds costs nothing)", ["cost.ghaMonthly", "cost.cobuildsMonthly"]),
    assumptions: [
      { label: "GHA standard runner", value: input("prices.ghaStandardPerMin", pr.ghaStandardPerMin, "USD"), per: "/min" },
      { label: "GHA larger runner", value: input("prices.ghaLargerPerMin", pr.ghaLargerPerMin, "USD"), per: "/min" },
      { label: "GHA minutes per run", value: input("workload.ghaMinutesPerRun", minutes, "min/run"), per: "" },
      { label: "Runs per month", value: input("workload.runsPerMonth", runs, "runs/month"), per: "" },
      { label: "R2 egress", value: input("prices.r2EgressPerGB", pr.r2EgressPerGB, "USD"), per: "/GB" }
    ]
  }

  return {
    project: {
      theorems: input("project.theorems", n, "theorems"),
      constants: input("project.mathlibConstants", inp.project.mathlibConstants, "constants"),
      latency: input("project.latencyMs", inp.project.latencyMs, "ms")
    },
    algorithms,
    phases,
    resources: {
      variant: current.variant,
      wall: der(current.total.value, "s", `phases[last].total (${current.variant})`, [`phases[${phases.length - 1}].total`]),
      cpu: der(current.total.value * inp.resources.cores, "s", "wall × resources.cores", [`phases[${phases.length - 1}].total`, "inputs.resources.cores"]),
      cores: input("resources.cores", inp.resources.cores, "cores"),
      peakMem: input("resources.peakMemMB", inp.resources.peakMemMB, "MB"),
      allocated: input("resources.allocatedGB", inp.resources.allocatedGB, "GB")
    },
    auditCache: {
      coldVariant: cold.variant,
      cold: der(cold.total.value, "s", `phases[${cold.variant}].total`, [`phases.${cold.variant}.total`]),
      warm: input("auditCache.warmS", inp.auditCache.warmS, "s"),
      warmHitRate: der(inp.auditCache.warmHitRate * 100, "%", "auditCache.warmHitRate × 100", ["inputs.auditCache.warmHitRate"])
    },
    graph: {
      sccCount: input("graph.sccCount", inp.graph.sccCount, "SCCs"),
      maxScc: input("graph.maxScc", inp.graph.maxScc, "constants"),
      maxDepth: input("graph.maxDepth", inp.graph.maxDepth, "levels"),
      vertices: input("project.mathlibConstants", inp.project.mathlibConstants, "constants"),
      cacheFile: input("graph.cacheFileMB", inp.graph.cacheFileMB, "MB")
    },
    scaling,
    cache,
    axioms: {
      forbiddenFound: der(inp.axioms.filter((a) => a.found && !a.allowed).length, "axioms", "count of axioms found but not allowed", ["inputs.axioms"]),
      checked: der(inp.axioms.length, "axioms", "count of inputs.axioms", ["inputs.axioms"])
    },
    cost
  }
}

// ---------------------------------------------------------------------------
// Formatting (every displayed number goes through `format`)

const grouped = (x: number, d: number): string => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })

const SUFFIX: Partial<Record<Unit, string>> = {
  probability: "",
  "USD/run": "/run",
  "USD/month": "/month",
  "USD/year": "/year",
  "%": "%",
  "×": "×",
  s: " s",
  ms: " ms",
  MB: " MB",
  GB: " GB",
  "GB-month": " GB-month",
  "M ops": "M ops",
  "M req": "M req",
  "M hrs": "M hrs",
  "runs/month": " runs/month",
  "min/run": " min/run",
  cores: " cores"
}

/** Default number of decimals for a unit. */
const DECIMALS: Partial<Record<Unit, number>> = { probability: 3, USD: 2, "USD/run": 3, "USD/month": 2, "USD/year": 0, "%": 1, "×": 1, s: 1, ms: 2, MB: 1, GB: 1 }

export interface FormatOpts {
  /** Decimal places (default depends on the unit). */
  readonly digits?: number
  /** Omit the unit suffix (for table cells whose header names the unit). */
  readonly bare?: boolean
}

/** Clock label of script time `t` (seconds) for a run that starts at `startClockS` seconds after midnight. */
export const clockLabel = (startClockS: number, t: number): string => {
  const x = Math.floor(startClockS + t)
  const p = (k: number) => String(k).padStart(2, "0")
  return `${p(Math.floor(x / 3600) % 24)}:${p(Math.floor(x / 60) % 60)}:${p(x % 60)}`
}

/** Text of a derived figure, always with its unit unless `bare`. `Infinity` is "∞" (R5). */
export const format = (d: Derived, opts: FormatOpts = {}): string => {
  if (d.unit === "clock") return clockLabel(0, d.value)
  const digits = opts.digits ?? DECIMALS[d.unit] ?? 0
  const suffix = opts.bare === true ? "" : (SUFFIX[d.unit] ?? (d.unit.startsWith("USD") ? "" : ` ${d.unit}`))
  if (!Number.isFinite(d.value)) return `∞${suffix}`
  if (d.unit.startsWith("USD")) return `${d.value < 0 ? "-" : ""}$${grouped(Math.abs(d.value), digits)}${suffix}`
  if (d.unit === "ms" && opts.digits === undefined) {
    if (d.value >= 1000) return `${grouped(d.value / 1000, 1)}${opts.bare === true ? "" : " s"}`
    return `${grouped(d.value, d.value < 10 ? 2 : 1)}${suffix}`
  }
  if (d.unit === "×" && opts.digits === undefined && d.value >= 100) return `${grouped(d.value, 0)}${suffix}`
  if (d.unit === "MB" && d.value >= 1000 && opts.digits === undefined) return `${grouped(d.value / 1000, 2)}${opts.bare === true ? "" : " GB"}`
  if (d.unit === "cores" && d.value === 1 && opts.bare !== true) return `${grouped(d.value, digits)} core`
  return `${grouped(d.value, digits)}${suffix}`
}

/** A clock time as a derived figure (script time `t`, run start from the inputs). */
export const clockAt = (startClockS: number, t: number): Derived =>
  der(startClockS + Math.floor(t), "clock", "run.startClockS + t", ["inputs.run.startClockS", "script time t"])

// ---------------------------------------------------------------------------
// Seeded latency jitter (the only use of the seed)

/** mulberry32 step: a deterministic hash of (seed, k) to [0, 1). */
export const hash01 = (seed: number, k: number): number => {
  let a = (seed ^ Math.imul(k + 1, 0x9e3779b9)) >>> 0
  a = (a + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Latency shown in the status bar at script second `floor(t)`: base ± jitter, from the seed. */
export const latencyAt = (inp: Inputs, seed: number, t: number): Derived => {
  const k = Math.floor(Math.max(0, t))
  const j = inp.project.latencyJitterMs
  const v = Math.max(0, Math.round(inp.project.latencyMs + (2 * hash01(seed, k) - 1) * j))
  return der(v, "ms", "project.latencyMs ± project.latencyJitterMs (seeded per second)", ["inputs.project.latencyMs", "inputs.project.latencyJitterMs", "seed"])
}

// ---------------------------------------------------------------------------
// Figures that depend on script time (lock cards, agent cards, counters)

export interface LockTimes {
  readonly expiresAt: number | null
  readonly lastWrite: number | null
  readonly progress: number
}

/** Countdown to lease expiry, age of the last write, and progress, at script time `t`. */
export const lockFigures = (l: LockTimes, t: number) => ({
  expiresIn: l.expiresAt === null ? null : der(Math.max(0, Math.ceil(l.expiresAt - t)), "s", "lastWrite + run.leaseS − t", ["inputs.run.leaseS", "lock.lastWrite", "script time t"]),
  sinceWrite: l.lastWrite === null ? null : der(Math.max(0, Math.floor(t - l.lastWrite)), "s", "t − lock.lastWrite", ["lock.lastWrite", "script time t"]),
  progress: der(Math.round(l.progress * 100), "%", "operation progress × 100", ["script time t"])
})

/** Seconds left on an agent's fork token. */
export const tokenFigure = (left: number) => der(left, "s", "fork token minted + run.tokenTtlS − t (0 when revoked)", ["inputs.run.tokenTtlS", "script time t"])

/** A count shown in the UI (agents active, operations held, panels hidden, …). */
export const count = (n: number, unit: "agents" | "ops" | "panels" | "blobs", formula: string) => der(n, unit, formula, ["state"])

// ---------------------------------------------------------------------------
// The brief's stated figures against the derived ones (notes overlay, report)

export type Verdict = "agrees" | "differs" | "not derivable" | "different quantity"

export interface DataNote {
  readonly figure: string
  readonly stated: Derived | { readonly ref: string }
  readonly derived: Derived | null
  readonly verdict: Verdict
  /** What the demo shows and why (the decision taken). */
  readonly decision: string
}

/** Decimals a stated figure is quoted to (e.g. 92.5 → 1, 2400 → 0, 0.033 → 3). */
export const decimalsOf = (x: number): number => {
  if (!Number.isFinite(x)) return 0
  const t = String(x)
  const i = t.indexOf(".")
  return i < 0 ? 0 : t.length - i - 1
}

/** A stated figure agrees with a derived one if they are equal at the stated precision. */
export const agreesAtPrecision = (stated: number, value: number): boolean => {
  const d = decimalsOf(stated)
  const k = 10 ** d
  return Math.round(value * k) === Math.round(stated * k)
}

/** Algorithm names the brief's figures `sccBitTotalS` and `setBSpeedup` refer to. */
export const BRIEF_SCC_BIT = "SCC+bit"
export const BRIEF_SET_B = "Set B"

export const dataNotes = (inp: Inputs, fig: Figures): DataNote[] => {
  const b = inp.briefStated
  const st = (path: string, value: number, unit: Unit): Derived => input(`briefStated.${path}`, value, unit)
  const cmp = (figure: string, stated: Derived, derived: Derived, decision: string): DataNote => ({
    figure,
    stated,
    derived,
    verdict: agreesAtPrecision(stated.value, derived.value) ? "agrees" : "differs",
    decision
  })
  const c = fig.cost
  /*
   * The brief's algorithm figures name their algorithm ("SCC+bit total", "Set B
   * speedup"); they are compared with the algorithm of that name. If the inputs
   * have no algorithm of that name the figure is not derivable — never compared
   * with some other algorithm by position.
   */
  const byName = (name: string, figure: string, stated: Derived, pick: (a: AlgorithmFigures) => Derived, decision: string): DataNote => {
    const a = fig.algorithms.find((x) => x.name === name)
    return a === undefined
      ? { figure, stated, derived: null, verdict: "not derivable", decision: `no algorithm named ${name} in the inputs` }
      : cmp(figure, stated, pick(a), decision)
  }
  const notes: DataNote[] = [
    cmp("GHA standard, monthly", st("monthlyGhaStandard", b.monthlyGhaStandard, "USD/month"), c.ghaMonthly, "shown as runs/month × per-run cost (R4)"),
    cmp("GHA larger runner, monthly", st("monthlyGhaLarger", b.monthlyGhaLarger, "USD/month"), c.ghaLargerMonthly, "shown as runs/month × larger-runner per-run cost (R4)"),
    cmp("Cobuilds, monthly", st("monthlyCobuilds", b.monthlyCobuilds, "USD/month"), c.cobuildsMonthly, "shown as itemised drivers + runner × runs (R3, R4)"),
    cmp("monthly savings", st("monthlySavingsPct", b.monthlySavingsPct, "%"), c.savingsPct, "derived"),
    cmp("ROI", st("roi", b.roi, "×"), c.roi, "derived; ∞ if Cobuilds costs nothing (R5)"),
    cmp("GHA per run", st("perRunGha", b.perRunGha, "USD/run"), c.ghaPerRun, "sum of the GHA items"),
    cmp("Cobuilds per run", st("perRunCobuilds", b.perRunCobuilds, "USD/run"), c.cobuildsPerRun, "runner + drivers / runs: the brief's per-run items ignore the Workers and DO drivers"),
    cmp("narrative runs per month", st("narrativeRunsPerMonth", b.narrativeRunsPerMonth, "runs/month"), c.runsPerMonth, "runs/month is an input chosen so that the monthly and per-run costs agree; the narrative's figure is dropped"),
    cmp("narrative per-run reduction", st("narrativeReductionPct", b.narrativeReductionPct, "%"), c.reductionPct, "derived; the narrative's figure is dropped"),
    {
      figure: "break-even / payback",
      stated: st("breakEvenRuns", b.breakEvenRuns, "runs"),
      derived: null,
      verdict: "not derivable",
      decision: "deleted: no setup cost or engineering hours are given"
    },
    byName(BRIEF_SCC_BIT, "SCC+bit total", st("sccBitTotalS", b.sccBitTotalS, "ms"), (a) => a.total, "per-theorem time × theorems: the brief's figure is in ms, not s"),
    byName(BRIEF_SET_B, "Set B speedup", st("setBSpeedup", b.setBSpeedup, "×"), (a) => a.speedup, "derived (rounding)"),
    ...fig.phases.map((p, i) =>
      cmp(
        `${p.variant} total (phase table)`,
        st(`phaseTotalsS[${i}]`, b.phaseTotalsS[i] ?? Number.NaN, "s"),
        p.total,
        "import + enum/filter + traversal, with traversal = per-theorem time × theorems (one total for both tables)"
      )
    ),
    cmp("stored bytes", st("storedMB", b.storedMB, "MB"), fig.cache.stored, "sum of the blob sizes"),
    cmp("space saved", st("spaceSavedMB", b.spaceSavedMB, "MB"), fig.cache.saved, "raw - stored"),
    ((storage): DataNote =>
      storage === null
        ? { figure: "R2 storage: GB vs MB", stated: st("storedMB", b.storedMB, "MB"), derived: null, verdict: "not derivable", decision: "no storage driver in the inputs" }
        : {
            figure: "R2 storage: GB vs MB",
            stated: st("storedMB", b.storedMB, "MB"),
            derived: storage,
            verdict: "different quantity",
            decision: "two quantities, labelled: one cache entry (MB) vs all retained entries per month (GB-month)"
          })(fig.cost.drivers.find((d) => d.driver.group === "storage")?.qty ?? null),
    cmp("lease: last write to expiry", st("expiryLabelS", b.expiryLabelS, "s"), input("run.leaseS", inp.run.leaseS, "s"), "the expiry happens one lease after the holder's last write (write log), and the event names that write and the missed renewal"),
    {
      figure: "takeover If-Match ETag",
      stated: { ref: b.takeoverEtag },
      derived: null,
      verdict: "not derivable",
      decision: "ETags are per-key versions; the takeover names the last ETag of the key (the brief's ETag had no predecessor)"
    }
  ]
  return notes
}
