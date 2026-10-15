/**
 * Panel contents as rows of text: the single source of what every panel
 * shows. The Ink components (`ink/*.tsx`) and the snapshot renderer
 * (`frame.ts`) both draw these rows, so a snapshot is exactly what the live
 * dashboard shows.
 *
 * Each builder gets the inner width and returns rows that are exactly that
 * wide (`fit`). Numbers come from `derive.ts`; widths from `constants.ts`.
 * No numeric literal other than 0 and 1 appears here.
 */
import { BAR_CELLS, COL, PERCENT, RANK_ROWS } from "./constants.js"
import {
  age,
  alphaBeta,
  bar,
  bytes,
  clock,
  costView,
  count,
  countdown,
  duration,
  entropyBits,
  entropyDelta,
  hitRate,
  probability,
  pulseOn
} from "./derive.js"
import type { DashboardInput, DashEvent, EventKind, UiState } from "./model.js"
import { fit } from "./width.js"

/** Colour role of a row. */
export type Tone = "normal" | "dim" | "title" | "good" | "bad" | "warn" | "accent"

/** One line of a panel. */
export interface Row {
  readonly text: string
  readonly tone: Tone
}

/** A panel's title and rows. */
export interface PanelContent {
  readonly title: string
  readonly rows: ReadonlyArray<Row>
  /** Keep the last rows (event stream) rather than the first when clipping. */
  readonly tail?: boolean
}

const row = (text: string, width: number, tone: Tone = "normal"): Row => ({ text: fit(text, width), tone })
const cols = (...cells: ReadonlyArray<readonly [string, number] | readonly [string, number, "right"]>): string =>
  cells.map(([t, w, align]) => fit(t, w, align ?? "left")).join(" ")
const short = (oid: string | null | undefined): string => (oid ?? "-").slice(0, COL.sha)
/** Width left for a flexible column after fixed ones and one-cell gaps. */
const rest = (width: number, ...fixed: ReadonlyArray<number>): number => Math.max(0, width - fixed.reduce((a, b) => a + b + COL.gap, 0))

/** 1 Artifacts: repositories, status, newest commit. */
export const artifactsPanel = (d: DashboardInput, width: number): PanelContent => {
  const head = row(cols(["repo", COL.repo], ["status", COL.status], ["head", COL.sha], ["last commit", rest(width, COL.repo, COL.status, COL.sha)]), width, "dim")
  const rows = d.repos.map((r) =>
    row(
      cols([r.name, COL.repo], [r.status, COL.status], [short(r.head), COL.sha], [r.headAt === null ? r.detail : age(r.headAt, d.now).text, rest(width, COL.repo, COL.status, COL.sha)]),
      width,
      r.status === "ok" ? "normal" : "bad"
    )
  )
  return { title: "1 Artifacts repos", rows: [head, ...(rows.length === 0 ? [row("no repositories configured", width, "dim")] : rows)] }
}

/** 2 node_modules cache: entries, hit/miss, size, restore time, seconds saved. */
export const nodeModulesPanel = (d: DashboardInput, width: number): PanelContent => {
  const v = d.nodeModules
  const title = "2 R2 node_modules cache"
  if (v === null) return { title, rows: [row("no data (GET /api/node-modules)", width, "dim")] }
  const keyRow = row("key: sha256(package-lock.json) / node ABI / platform-arch", width, "dim")
  const head = row(cols(["lockfile", COL.key], ["platform", COL.platform], ["node", COL.key], ["size", COL.num, "right"], ["hit", COL.key, "right"], ["miss", COL.key, "right"], ["restore", rest(width, COL.key, COL.platform, COL.key, COL.num, COL.key, COL.key)]), width, "dim")
  const entries = v.entries.map((e) =>
    row(
      cols(
        [e.lockfileSha256.slice(0, COL.key), COL.key],
        [`${e.platform}-${e.arch}`, COL.platform],
        [e.nodeVersion, COL.key],
        [bytes(e.tarballBytes).text, COL.num, "right"],
        [count(e.hits, "").text.trim(), COL.key, "right"],
        [count(e.misses, "").text.trim(), COL.key, "right"],
        [e.meanRestoreMs === null ? "-" : duration(e.meanRestoreMs).text, rest(width, COL.key, COL.platform, COL.key, COL.num, COL.key, COL.key)]
      ),
      width
    )
  )
  const t = v.totals
  const rate = hitRate(t.hits, t.misses)
  const summary = row(`Hit rate ${rate.text} | ${count(t.hits, "hits").text} ${count(t.misses, "misses").text} | stored ${bytes(t.storedBytes).text}`, width, rate.value > 0 ? "good" : "normal")
  const times = row(
    `Restore ${t.meanRestoreMs === null ? "-" : duration(t.meanRestoreMs).text} vs cold install ${t.meanColdInstallMs === null ? "-" : duration(t.meanColdInstallMs).text}`,
    width
  )
  const saved = row(`Saved this session: ${duration(t.savedMs).text} (${count(t.hits, "restores").text})`, width, "accent")
  return { title, rows: [keyRow, head, ...entries, summary, times, saved, ...(v.truncated ? [row("listing truncated", width, "warn")] : [])] }
}

/** 3 Leases: operation leases, countdown, heartbeat pulse. */
export const leasePanel = (d: DashboardInput, width: number): PanelContent => {
  const barCells = Math.min(BAR_CELLS, rest(width, COL.pulse, COL.owner, COL.status, COL.num, COL.op))
  const head = row(cols([" ", COL.pulse], ["owner", COL.owner], ["status", COL.status], ["expires", COL.num, "right"], ["operation", COL.op], ["lease", barCells]), width, "dim")
  const rows = d.leases.map((l) => {
    const left = countdown(l.expiresAt, d.now)
    const span = Math.max(1, l.expiresAt - l.heartbeatAt)
    const building = l.status === "building"
    const expired = building && (l.leaseExpired || left.value === 0)
    const pulse = building && !expired && pulseOn(l.heartbeatAt, d.now) ? "*" : building && !expired ? "o" : " "
    return row(
      cols(
        [pulse, COL.pulse],
        [l.owner, COL.owner],
        [expired ? "expired" : l.status, COL.status],
        [building ? left.text : "-", COL.num, "right"],
        [l.cacheKey, COL.op],
        [building ? bar(Math.max(0, l.expiresAt - d.now) / span, barCells) : "", barCells]
      ),
      width,
      expired ? "bad" : l.status === "failed" ? "bad" : l.status === "succeeded" ? "good" : "normal"
    )
  })
  return { title: "3 Operation leases", rows: [head, ...(rows.length === 0 ? [row("no leases", width, "dim")] : rows)] }
}

/** 4 Bisect: per-commit alpha/beta bars, confidence, next commit, entropy delta (all from the status route). */
export const bisectPanel = (d: DashboardInput, ui: UiState, width: number): PanelContent => {
  const title = "4 Bayesian bisect"
  const b = d.bisect
  if (b === null) return { title, rows: [row("no session (POST /api/bisect, or a CI failure, starts one)", width, "dim")] }
  const st = b.body.status
  const conf = probability(st.confidence)
  const delta = entropyDelta(st.entropy, b.previousEntropy)
  const barCells = Math.min(BAR_CELLS, rest(width, COL.label, COL.num))
  const rows: Array<Row> = [
    row(`session ${b.body.id.slice(0, COL.key)} | ${b.body.repo} | ${count(b.body.candidates, "commits").text} | ${count(st.observations, "runs").text} | ${count(st.skipped.length, "skipped").text}`, width, "dim"),
    row(cols(["confidence", COL.label], [conf.text, COL.num, "right"], [bar(st.confidence, barCells), barCells]), width, st.done ? "good" : "normal"),
    row(cols(["entropy", COL.label], [entropyBits(st.entropy).text, COL.num, "right"], [delta === null ? "" : `delta ${delta.text}`, barCells]), width),
    row(cols(["next", COL.label], [st.next === null ? "-" : short(st.next.oid), COL.num, "right"], [st.next?.message ?? (st.done ? `done: ${st.stopReason ?? "-"}` : ""), barCells]), width, "accent"),
    row(cols(["culprit", COL.label], [short(st.culprit.oid), COL.num, "right"], [st.culprit.message ?? "", barCells]), width, st.done ? "good" : "normal")
  ]
  const tallyBar = Math.min(BAR_CELLS, rest(width, COL.sha, COL.key, COL.key, COL.num))
  rows.push(row(cols(["commit", COL.sha], ["alpha", COL.key], ["beta", COL.key], ["fail mean", COL.num, "right"], ["Beta mean fail rate", tallyBar]), width, "dim"))
  for (const t of b.body.tally) {
    const ab = alphaBeta(t.fails, t.passes)
    const skipped = t.skips > 0 && t.fails + t.passes === 0
    rows.push(
      row(
        cols([short(t.oid), COL.sha], [ab.alpha.text, COL.key], [ab.beta.text, COL.key], [skipped ? "skip" : ab.failMean.text, COL.num, "right"], [skipped ? "(timed out: skipped)" : bar(ab.failMean.value / PERCENT, tallyBar), tallyBar]),
        width,
        skipped ? "warn" : t.fails > 0 ? "bad" : "good"
      )
    )
  }
  rows.push(row("most likely culprits (posterior)", width, "dim"))
  for (const r of st.ranking.slice(0, RANK_ROWS)) {
    rows.push(row(cols([short(r.commit.oid), COL.sha], [probability(r.probability).text, COL.num, "right"], [bar(r.probability, tallyBar), tallyBar]), width))
  }
  const res = b.result
  if (res !== null) {
    const rv = res.review
    rows.push(row(`result: ${short(res.culprit.oid)} at ${probability(res.confidence).text} | review: ${rv === null ? "pending ([a] approve / [r] reject)" : `${rv.decision} by ${rv.principal}`}`, width, rv === null ? "warn" : rv.decision === "approved" ? "good" : "bad"))
    if (ui.notes) {
      const text = rv?.note?.text ?? "(no note yet: the note is written on approval)"
      for (const line of text.split("\n")) rows.push(row(`  ${line}`, width, "dim"))
    }
  }
  return { title, rows }
}

/** 5 Cost: R2 operations vs GitHub Actions minutes, from the inputs. */
export const costPanel = (d: DashboardInput, width: number): PanelContent => {
  const c = costView(d.cost)
  const barCells = Math.min(BAR_CELLS, rest(width, COL.label, COL.wideNum))
  return {
    title: "5 Cost: R2 vs GitHub Actions",
    rows: [
      row(cols(["R2 ops", COL.label], [c.r2Ops.text, COL.wideNum, "right"], [`${count(d.cost.r2ClassA, "class A").text}, ${count(d.cost.r2ClassB, "class B").text}`, barCells]), width),
      row(cols(["R2 storage", COL.label], [c.r2Storage.text, COL.wideNum, "right"], [`${bytes(d.cost.r2StoredBytes).text} for one month`, barCells]), width),
      row(cols(["R2 total", COL.label], [c.r2Total.text, COL.wideNum, "right"], ["", barCells]), width, "good"),
      row(cols(["GH Actions", COL.label], [c.gha.text, COL.wideNum, "right"], [`${c.ghaMinutes.text} of cold installs + tests`, barCells]), width, "warn"),
      row(cols(["savings", COL.label], [c.savings.text, COL.wideNum, "right"], [bar(c.savings.value / PERCENT, barCells), barCells]), width, "accent"),
      row("prices: list prices in constants.ts (not re-checked)", width, "dim")
    ]
  }
}

const KIND_TONE: Readonly<Record<EventKind, Tone>> = { push: "accent", lease: "normal", cache: "good", bisect: "title", review: "warn", error: "bad", info: "dim" }

/** 6 Event stream: append-only, timestamped, colour-coded (newest last). */
export const eventPanel = (events: ReadonlyArray<DashEvent>, width: number): PanelContent => ({
  title: "Event stream",
  tail: true,
  rows: events.map((e) => row(cols([clock(e.at).text, COL.clock], [e.kind, COL.kind], [e.text, rest(width, COL.clock, COL.kind)]), width, KIND_TONE[e.kind]))
})

/** The five selectable panels, by key. */
export const panelFor = (key: 1 | 2 | 3 | 4 | 5, d: DashboardInput, ui: UiState, width: number): PanelContent =>
  key === 1 ? artifactsPanel(d, width) : key === 2 ? nodeModulesPanel(d, width) : key === 3 ? leasePanel(d, width) : key === 4 ? bisectPanel(d, ui, width) : costPanel(d, width)

/** Footer controls. */
export const FOOTER = "[SPACE] trigger  [1-5] panels  [a]pprove  [r]eject  [w]atch  [n]otes  [q]uit"

/** Header line. */
export const header = (d: DashboardInput, ui: UiState, width: number): Row =>
  row(`${d.title} | ${clock(d.now).text} UTC | panel ${ui.focus} | watch ${ui.watch ? "on" : "off"}${ui.status.length > 0 ? ` | ${ui.status}` : ""}`, width, "title")

/** Footer line. */
export const footer = (width: number): Row => row(FOOTER, width, "dim")
