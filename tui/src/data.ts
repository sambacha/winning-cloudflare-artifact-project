/**
 * Typed, validated access to `tui/inputs.json`, the only file of the demo
 * that holds raw numbers. Nothing here computes a figure: `derive.ts` does.
 * `parseInputs` checks the shape and the domain of every field (finite,
 * non-negative numbers; fractions in [0, 1]; integers where a count is
 * meant) so that the derivations can rely on them, and so that the tests can
 * feed arbitrary valid inputs through the same code path.
 */
import { readFileSync } from "node:fs"

export interface Algorithm {
  readonly name: string
  readonly perTheoremMs: number
}
export interface PhaseInput {
  readonly variant: string
  readonly importS: number
  readonly enumFilterS: number
}
export interface ScalingPoint {
  readonly cores: number
  readonly totalS: number
}
export interface Axiom {
  readonly name: string
  readonly found: boolean
  readonly allowed: boolean
}
export interface Blob {
  readonly digest: string
  readonly sizeMB: number
  readonly shared: number
}
export interface Driver {
  readonly id: string
  readonly name: string
  readonly qty: number
  readonly unit: string
  readonly price: number
  readonly priceUnit: string
  readonly group: "storage" | "operations" | "coordination"
}
export interface ForkInput {
  readonly fork: string
  readonly branch: string
  /** Script time of the fork, or `on: "takeover"` for a fork made when the agent takes over an operation. */
  readonly at?: number
  readonly on?: "takeover"
  readonly commit: string
  readonly added: number
  readonly removed: number
  readonly files: number
}
export interface AgentInput {
  readonly id: string
  readonly forks: ReadonlyArray<ForkInput>
  readonly set: string
}
export interface OpInput {
  readonly op: string
  readonly holder: string
  readonly acquireAt: number
  readonly workStart?: number
  readonly workEnd?: number
  readonly waitsFor?: string
  readonly doneAt?: number
  readonly crashAt?: number
  readonly takeoverBy?: string
  readonly takeoverWorkS?: number
  readonly result: string
}
export interface RunInput {
  readonly startClockS: number
  readonly leaseS: number
  readonly renewS: number
  readonly tokenTtlS: number
  readonly minWriteGapS: number
  readonly spawnS: number
  readonly agents: ReadonlyArray<AgentInput>
  readonly ops: ReadonlyArray<OpInput>
  readonly reviewAfterTakeoverS: number
  readonly autoTriggerIdleS: number
  readonly autoApproveDelayS: number
}

export interface Inputs {
  readonly project: {
    readonly name: string
    readonly lean: string
    readonly tagline: string
    readonly mathlib: string
    readonly mathlibConstants: number
    readonly theorems: number
    readonly latencyMs: number
    readonly latencyJitterMs: number
  }
  readonly algorithms: ReadonlyArray<Algorithm>
  readonly phases: ReadonlyArray<PhaseInput>
  readonly resources: { readonly peakMemMB: number; readonly allocatedGB: number; readonly cores: number }
  readonly scaling: { readonly theorems: number; readonly oneCoreS: number; readonly serialS: number; readonly points: ReadonlyArray<ScalingPoint> }
  readonly auditCache: { readonly coldVariant: string; readonly warmS: number; readonly warmHitRate: number; readonly persistent: string }
  readonly graph: { readonly sccCount: number; readonly maxScc: number; readonly maxDepth: number; readonly edgesD5: string; readonly cacheFileMB: number }
  readonly axioms: ReadonlyArray<Axiom>
  readonly cache: {
    readonly hashPrefix: string
    readonly lookupKey: string
    readonly scope: string
    readonly inputs: number
    readonly deps: number
    readonly salt: string
    readonly zstdLevel: number
    readonly blobs: ReadonlyArray<Blob>
    readonly manifest: { readonly buildMs: number; readonly tool: string; readonly mathlib: string }
    readonly hitRate: number
    readonly rawMB: number
    readonly chunks: number
  }
  readonly workload: { readonly runsPerMonth: number; readonly ghaMinutesPerRun: number }
  readonly prices: {
    readonly ghaStandardPerMin: number
    readonly ghaLargerPerMin: number
    readonly ghaCacheStoragePerRun: number
    readonly ghaCacheTransferPerRun: number
    readonly cobuildsRunnerPerRun: number
    readonly r2EgressPerGB: number
  }
  readonly drivers: ReadonlyArray<Driver>
  readonly run: RunInput
  readonly briefStated: BriefStated
}

export interface BriefStated {
  readonly monthlyGhaStandard: number
  readonly monthlyGhaLarger: number
  readonly monthlyCobuilds: number
  readonly monthlySavingsPct: number
  readonly roi: number
  readonly perRunGha: number
  readonly perRunCobuilds: number
  readonly perRunCobuildsItems: { readonly cacheStorage: number; readonly cacheTransfer: number; readonly coordination: number }
  readonly narrativeRunsPerMonth: number
  readonly narrativeReductionPct: number
  readonly breakEvenRuns: number
  readonly sccBitTotalS: number
  readonly setBSpeedup: number
  readonly phaseTotalsS: ReadonlyArray<number>
  readonly phaseShares: ReadonlyArray<{ readonly import: number; readonly enumFilter: number; readonly traversal: number }>
  readonly storedMB: number
  readonly zstdRatio: number
  readonly spaceSavedMB: number
  readonly spaceSavedPct: number
  readonly alphaHeartbeatAt: number
  readonly expiryLabelS: number
  readonly takeoverEtag: string
  readonly verifyS: number
}

export class InputError extends Error {
  override readonly name = "InputError"
}

type Obj = Record<string, unknown>

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x)

const obj = (x: unknown, path: string): Obj => {
  if (!isObj(x)) throw new InputError(`${path} must be an object`)
  return x
}
const arr = (x: unknown, path: string, minLength = 0): ReadonlyArray<unknown> => {
  if (!Array.isArray(x) || x.length < minLength) throw new InputError(`${path} must be an array of at least ${minLength} element(s)`)
  return x
}
const str = (o: Obj, k: string, path: string): string => {
  if (typeof o[k] !== "string") throw new InputError(`${path}.${k} must be a string`)
  return o[k] as string
}
const bool = (o: Obj, k: string, path: string): boolean => {
  if (typeof o[k] !== "boolean") throw new InputError(`${path}.${k} must be a boolean`)
  return o[k] as boolean
}
/** A finite number ≥ 0 (optionally > 0, ≤ 1, or an integer). */
const num = (o: Obj, k: string, path: string, opt: { positive?: boolean; fraction?: boolean; integer?: boolean } = {}): number => {
  const v = o[k]
  const ok =
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= 0 &&
    (opt.positive !== true || v > 0) &&
    (opt.fraction !== true || v <= 1) &&
    (opt.integer !== true || Number.isInteger(v))
  if (!ok) throw new InputError(`${path}.${k} must be a finite number ≥ 0${opt.positive ? ", > 0" : ""}${opt.fraction ? ", ≤ 1" : ""}${opt.integer ? ", integer" : ""}`)
  return v as number
}
const optNum = (o: Obj, k: string, path: string): number | undefined => (o[k] === undefined ? undefined : num(o, k, path))
const optStr = (o: Obj, k: string, path: string): string | undefined => (o[k] === undefined ? undefined : str(o, k, path))

const GROUPS = ["storage", "operations", "coordination"] as const

/** Validate a parsed `inputs.json`. Throws `InputError` naming the first bad field. */
export const parseInputs = (raw: unknown): Inputs => {
  const r = obj(raw, "inputs")
  const p = obj(r["project"], "project")
  const res = obj(r["resources"], "resources")
  const sc = obj(r["scaling"], "scaling")
  const ac = obj(r["auditCache"], "auditCache")
  const g = obj(r["graph"], "graph")
  const c = obj(r["cache"], "cache")
  const man = obj(c["manifest"], "cache.manifest")
  const w = obj(r["workload"], "workload")
  const pr = obj(r["prices"], "prices")
  const run = obj(r["run"], "run")
  const bs = obj(r["briefStated"], "briefStated")
  const items = obj(bs["perRunCobuildsItems"], "briefStated.perRunCobuildsItems")
  const inputs: Inputs = {
    project: {
      name: str(p, "name", "project"),
      lean: str(p, "lean", "project"),
      tagline: str(p, "tagline", "project"),
      mathlib: str(p, "mathlib", "project"),
      mathlibConstants: num(p, "mathlibConstants", "project", { integer: true }),
      theorems: num(p, "theorems", "project", { integer: true }),
      latencyMs: num(p, "latencyMs", "project"),
      latencyJitterMs: num(p, "latencyJitterMs", "project")
    },
    algorithms: arr(r["algorithms"], "algorithms", 1).map((a, i) => {
      const o = obj(a, `algorithms[${i}]`)
      return { name: str(o, "name", `algorithms[${i}]`), perTheoremMs: num(o, "perTheoremMs", `algorithms[${i}]`, { positive: true }) }
    }),
    phases: arr(r["phases"], "phases", 1).map((a, i) => {
      const o = obj(a, `phases[${i}]`)
      return { variant: str(o, "variant", `phases[${i}]`), importS: num(o, "importS", `phases[${i}]`), enumFilterS: num(o, "enumFilterS", `phases[${i}]`) }
    }),
    resources: { peakMemMB: num(res, "peakMemMB", "resources"), allocatedGB: num(res, "allocatedGB", "resources"), cores: num(res, "cores", "resources", { positive: true, integer: true }) },
    scaling: {
      theorems: num(sc, "theorems", "scaling", { integer: true }),
      oneCoreS: num(sc, "oneCoreS", "scaling", { positive: true }),
      serialS: num(sc, "serialS", "scaling"),
      points: arr(sc["points"], "scaling.points").map((a, i) => {
        const o = obj(a, `scaling.points[${i}]`)
        return { cores: num(o, "cores", `scaling.points[${i}]`, { positive: true, integer: true }), totalS: num(o, "totalS", `scaling.points[${i}]`, { positive: true }) }
      })
    },
    auditCache: { coldVariant: str(ac, "coldVariant", "auditCache"), warmS: num(ac, "warmS", "auditCache"), warmHitRate: num(ac, "warmHitRate", "auditCache", { fraction: true }), persistent: str(ac, "persistent", "auditCache") },
    graph: {
      sccCount: num(g, "sccCount", "graph", { integer: true }),
      maxScc: num(g, "maxScc", "graph", { integer: true }),
      maxDepth: num(g, "maxDepth", "graph", { integer: true }),
      edgesD5: str(g, "edgesD5", "graph"),
      cacheFileMB: num(g, "cacheFileMB", "graph")
    },
    axioms: arr(r["axioms"], "axioms").map((a, i) => {
      const o = obj(a, `axioms[${i}]`)
      return { name: str(o, "name", `axioms[${i}]`), found: bool(o, "found", `axioms[${i}]`), allowed: bool(o, "allowed", `axioms[${i}]`) }
    }),
    cache: {
      hashPrefix: str(c, "hashPrefix", "cache"),
      lookupKey: str(c, "lookupKey", "cache"),
      scope: str(c, "scope", "cache"),
      inputs: num(c, "inputs", "cache", { integer: true }),
      deps: num(c, "deps", "cache", { integer: true }),
      salt: str(c, "salt", "cache"),
      zstdLevel: num(c, "zstdLevel", "cache", { integer: true }),
      blobs: arr(c["blobs"], "cache.blobs", 1).map((a, i) => {
        const o = obj(a, `cache.blobs[${i}]`)
        return { digest: str(o, "digest", `cache.blobs[${i}]`), sizeMB: num(o, "sizeMB", `cache.blobs[${i}]`), shared: num(o, "shared", `cache.blobs[${i}]`, { positive: true, integer: true }) }
      }),
      manifest: { buildMs: num(man, "buildMs", "cache.manifest"), tool: str(man, "tool", "cache.manifest"), mathlib: str(man, "mathlib", "cache.manifest") },
      hitRate: num(c, "hitRate", "cache", { fraction: true }),
      rawMB: num(c, "rawMB", "cache"),
      chunks: num(c, "chunks", "cache", { integer: true })
    },
    workload: { runsPerMonth: num(w, "runsPerMonth", "workload", { positive: true }), ghaMinutesPerRun: num(w, "ghaMinutesPerRun", "workload") },
    prices: {
      ghaStandardPerMin: num(pr, "ghaStandardPerMin", "prices"),
      ghaLargerPerMin: num(pr, "ghaLargerPerMin", "prices"),
      ghaCacheStoragePerRun: num(pr, "ghaCacheStoragePerRun", "prices"),
      ghaCacheTransferPerRun: num(pr, "ghaCacheTransferPerRun", "prices"),
      cobuildsRunnerPerRun: num(pr, "cobuildsRunnerPerRun", "prices"),
      r2EgressPerGB: num(pr, "r2EgressPerGB", "prices")
    },
    drivers: arr(r["drivers"], "drivers").map((a, i) => {
      const o = obj(a, `drivers[${i}]`)
      const group = str(o, "group", `drivers[${i}]`)
      if (!(GROUPS as ReadonlyArray<string>).includes(group)) throw new InputError(`drivers[${i}].group must be one of ${GROUPS.join(", ")}`)
      return {
        id: str(o, "id", `drivers[${i}]`),
        name: str(o, "name", `drivers[${i}]`),
        qty: num(o, "qty", `drivers[${i}]`),
        unit: str(o, "unit", `drivers[${i}]`),
        price: num(o, "price", `drivers[${i}]`),
        priceUnit: str(o, "priceUnit", `drivers[${i}]`),
        group: group as Driver["group"]
      }
    }),
    run: parseRun(run),
    briefStated: {
      monthlyGhaStandard: num(bs, "monthlyGhaStandard", "briefStated"),
      monthlyGhaLarger: num(bs, "monthlyGhaLarger", "briefStated"),
      monthlyCobuilds: num(bs, "monthlyCobuilds", "briefStated"),
      monthlySavingsPct: num(bs, "monthlySavingsPct", "briefStated"),
      roi: num(bs, "roi", "briefStated"),
      perRunGha: num(bs, "perRunGha", "briefStated"),
      perRunCobuilds: num(bs, "perRunCobuilds", "briefStated"),
      perRunCobuildsItems: {
        cacheStorage: num(items, "cacheStorage", "briefStated.perRunCobuildsItems"),
        cacheTransfer: num(items, "cacheTransfer", "briefStated.perRunCobuildsItems"),
        coordination: num(items, "coordination", "briefStated.perRunCobuildsItems")
      },
      narrativeRunsPerMonth: num(bs, "narrativeRunsPerMonth", "briefStated"),
      narrativeReductionPct: num(bs, "narrativeReductionPct", "briefStated"),
      breakEvenRuns: num(bs, "breakEvenRuns", "briefStated"),
      sccBitTotalS: num(bs, "sccBitTotalS", "briefStated"),
      setBSpeedup: num(bs, "setBSpeedup", "briefStated"),
      phaseTotalsS: arr(bs["phaseTotalsS"], "briefStated.phaseTotalsS").map((x, i) => num({ x }, "x", `briefStated.phaseTotalsS[${i}]`)),
      phaseShares: arr(bs["phaseShares"], "briefStated.phaseShares").map((a, i) => {
        const o = obj(a, `briefStated.phaseShares[${i}]`)
        const at = `briefStated.phaseShares[${i}]`
        return { import: num(o, "import", at), enumFilter: num(o, "enumFilter", at), traversal: num(o, "traversal", at) }
      }),
      storedMB: num(bs, "storedMB", "briefStated"),
      zstdRatio: num(bs, "zstdRatio", "briefStated"),
      spaceSavedMB: num(bs, "spaceSavedMB", "briefStated"),
      spaceSavedPct: num(bs, "spaceSavedPct", "briefStated"),
      alphaHeartbeatAt: num(bs, "alphaHeartbeatAt", "briefStated"),
      expiryLabelS: num(bs, "expiryLabelS", "briefStated"),
      takeoverEtag: str(bs, "takeoverEtag", "briefStated"),
      verifyS: num(bs, "verifyS", "briefStated")
    }
  }
  if (inputs.scaling.serialS > inputs.scaling.oneCoreS) throw new InputError("scaling.serialS must not exceed scaling.oneCoreS")
  return inputs
}

/** The run script, with its cross-field rules (holders exist, times ordered, renewals inside the lease). */
export const parseRun = (run: Obj): RunInput => {
  const agents = arr(run["agents"], "run.agents", 1).map((a, i): AgentInput => {
    const o = obj(a, `run.agents[${i}]`)
    return {
      id: str(o, "id", `run.agents[${i}]`),
      set: str(o, "set", `run.agents[${i}]`),
      forks: arr(o["forks"], `run.agents[${i}].forks`, 1).map((f, j): ForkInput => {
        const q = obj(f, `run.agents[${i}].forks[${j}]`)
        const path = `run.agents[${i}].forks[${j}]`
        const on = optStr(q, "on", path)
        if (on !== undefined && on !== "takeover") throw new InputError(`${path}.on must be "takeover"`)
        const at = optNum(q, "at", path)
        if ((at === undefined) === (on === undefined)) throw new InputError(`${path} needs exactly one of "at" and "on"`)
        return {
          fork: str(q, "fork", path),
          branch: str(q, "branch", path),
          ...(at === undefined ? {} : { at }),
          ...(on === undefined ? {} : { on: "takeover" as const }),
          commit: str(q, "commit", path),
          added: num(q, "added", path, { integer: true }),
          removed: num(q, "removed", path, { integer: true }),
          files: num(q, "files", path, { integer: true })
        }
      })
    }
  })
  const ids = new Set(agents.map((a) => a.id))
  const ops = arr(run["ops"], "run.ops", 1).map((a, i): OpInput => {
    const o = obj(a, `run.ops[${i}]`)
    const path = `run.ops[${i}]`
    const op: OpInput = {
      op: str(o, "op", path),
      holder: str(o, "holder", path),
      acquireAt: num(o, "acquireAt", path),
      ...(o["workStart"] === undefined ? {} : { workStart: num(o, "workStart", path) }),
      ...(o["workEnd"] === undefined ? {} : { workEnd: num(o, "workEnd", path) }),
      ...(o["waitsFor"] === undefined ? {} : { waitsFor: str(o, "waitsFor", path) }),
      ...(o["doneAt"] === undefined ? {} : { doneAt: num(o, "doneAt", path) }),
      ...(o["crashAt"] === undefined ? {} : { crashAt: num(o, "crashAt", path) }),
      ...(o["takeoverBy"] === undefined ? {} : { takeoverBy: str(o, "takeoverBy", path) }),
      ...(o["takeoverWorkS"] === undefined ? {} : { takeoverWorkS: num(o, "takeoverWorkS", path, { positive: true }) }),
      result: str(o, "result", path)
    }
    if (!ids.has(op.holder)) throw new InputError(`${path}.holder ${op.holder} is not an agent`)
    if ((op.doneAt === undefined) === (op.crashAt === undefined)) throw new InputError(`${path} needs exactly one of doneAt and crashAt`)
    const end = op.doneAt ?? op.crashAt!
    if (end <= op.acquireAt) throw new InputError(`${path} must end after it is acquired`)
    if (op.crashAt !== undefined && (op.takeoverBy === undefined || !ids.has(op.takeoverBy) || op.takeoverWorkS === undefined)) {
      throw new InputError(`${path}: a crashed operation needs takeoverBy (an agent) and takeoverWorkS`)
    }
    return op
  })
  const r: RunInput = {
    startClockS: num(run, "startClockS", "run"),
    leaseS: num(run, "leaseS", "run", { positive: true }),
    renewS: num(run, "renewS", "run", { positive: true }),
    tokenTtlS: num(run, "tokenTtlS", "run", { positive: true }),
    minWriteGapS: num(run, "minWriteGapS", "run"),
    spawnS: num(run, "spawnS", "run"),
    agents,
    ops,
    reviewAfterTakeoverS: num(run, "reviewAfterTakeoverS", "run"),
    autoTriggerIdleS: num(run, "autoTriggerIdleS", "run"),
    autoApproveDelayS: num(run, "autoApproveDelayS", "run")
  }
  if (r.renewS >= r.leaseS) throw new InputError("run.renewS must be shorter than run.leaseS (otherwise a live holder loses its lease)")
  if (r.renewS < r.minWriteGapS) throw new InputError("run.renewS must respect run.minWriteGapS (R2: one write per key per second)")
  if (ops.filter((o) => o.crashAt !== undefined).length > 1) throw new InputError("run.ops: at most one crashed operation is scripted")
  if (ids.size !== agents.length) throw new InputError("run.agents: agent ids must be unique")
  const names = new Set(ops.map((o) => o.op))
  if (names.size !== ops.length) throw new InputError("run.ops: operation names must be unique (one lock key each)")
  ops.forEach((o, i) => {
    const path = `run.ops[${i}]`
    const end = o.doneAt ?? o.crashAt!
    if (o.waitsFor !== undefined && (!names.has(o.waitsFor) || o.waitsFor === o.op)) throw new InputError(`${path}.waitsFor must name another operation`)
    for (const k of ["workStart", "workEnd"] as const) {
      const v = o[k]
      if (v !== undefined && (v < o.acquireAt || v > end)) throw new InputError(`${path}.${k} must lie between acquireAt and the end of the operation`)
    }
    if (o.workStart !== undefined && o.workEnd !== undefined && o.workEnd < o.workStart) throw new InputError(`${path}.workEnd must not precede workStart`)
    // R2 accepts one write per key per second: the publish must come at least minWriteGapS after the acquire.
    if (o.doneAt !== undefined && o.doneAt - o.acquireAt < r.minWriteGapS) throw new InputError(`${path}: doneAt must be at least run.minWriteGapS after acquireAt`)
    if (o.takeoverWorkS !== undefined && o.takeoverWorkS < r.minWriteGapS) throw new InputError(`${path}.takeoverWorkS must be at least run.minWriteGapS`)
    if (o.takeoverBy !== undefined && o.takeoverBy === o.holder) throw new InputError(`${path}.takeoverBy must differ from the crashed holder`)
  })
  return r
}

/** The demo's inputs, read once from `tui/inputs.json`. */
export const INPUTS: Inputs = parseInputs(JSON.parse(readFileSync(new URL("../inputs.json", import.meta.url), "utf8")))
