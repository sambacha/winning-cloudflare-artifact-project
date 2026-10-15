/**
 * Panel 7 (key `u`): every Cloudflare R2 and Artifacts URI the run touches:
 * the bucket endpoint, the lease-lock keys, the cache manifest and blobs,
 * the trunk repo, the fork route and one remote per Artifacts fork. Fork
 * remotes appear when their fork is created. In live mode the lock keys and
 * the run's repo come from the Worker.
 */
import type { Inputs } from "../data.ts"
import { GLYPHS } from "../glyphs.ts"
import { Box, type InkNode, Text } from "../ink/index.ts"
import { OVERVIEW, URI_RANK, W } from "../layout.ts"
import type { State } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { artifactsRemote, CLOUDFLARE, forkRepo, forkRoute, lockKey, r2Endpoint, r2Uri } from "../uris.ts"
import { Cell, Panel, Ref } from "./common.tsx"
import type { PanelProps } from "./props.ts"

export interface UriRow {
  readonly group: "R2" | "ARTIFACTS"
  readonly label: string
  readonly uri: string
  /** A shorter form for narrow tiles (the end of the URI, which names the object or repo). */
  readonly short: string
  readonly note: string
  readonly look: TextLook
  /** Lower is shown first in the compact tile. */
  readonly rank: number
}

const lockLook = (state: string): TextLook => (state === "SUCCEEDED" ? TX.ok : state === "BUILDING" ? TX.warn : state === "EXPIRED" || state === "FAILED" ? TX.bad : TX.label)

/** The URI rows for a state, R2 first, then Artifacts. */
export const uriRows = (st: State, inputs: Inputs): ReadonlyArray<UriRow> => {
  const c = inputs.cache
  const blobs = `v1/blobs/${c.hashPrefix}`
  const live = st.feed?.artifacts ?? null
  const repoShort = (repo: string) => `${GLYPHS.ellipsis.char}/${CLOUDFLARE.namespace}/${repo}.git`
  const rows: UriRow[] = [
    { group: "R2", label: "bucket", uri: r2Endpoint(), short: r2Uri(""), note: "S3 API", look: TX.value, rank: URI_RANK.primary },
    ...st.locks.map((l): UriRow => {
      const key = l.key ?? lockKey(l.op)
      return { group: "R2", label: "lock", uri: r2Uri(key), short: r2Uri(key), note: l.etag === null ? l.state : `${l.state} ${l.etag}`, look: lockLook(l.state), rank: URI_RANK.lock }
    }),
    {
      group: "R2",
      label: "manifest",
      uri: r2Uri(c.lookupKey),
      short: r2Uri(`${c.lookupKey.slice(0, c.lookupKey.indexOf(c.hashPrefix) + c.hashPrefix.length)}${GLYPHS.ellipsis.char}`),
      note: st.published ? "published" : "not yet published",
      look: st.published ? TX.ok : TX.label,
      rank: URI_RANK.manifest
    },
    {
      group: "R2",
      label: "blobs",
      uri: r2Uri(`${blobs}<digest>`),
      short: r2Uri(`${blobs}${GLYPHS.ellipsis.char}`),
      note: st.verifiedByTaker ? "uploaded, verified" : st.published ? "uploaded" : "create-only",
      look: st.published ? TX.ok : TX.label,
      rank: URI_RANK.other
    },
    {
      group: "ARTIFACTS",
      label: "trunk",
      uri: artifactsRemote(CLOUDFLARE.repo),
      short: repoShort(CLOUDFLARE.repo),
      note: st.forks.some((f) => f.merged) ? "merged" : "default branch",
      look: TX.value,
      rank: URI_RANK.primary
    },
    { group: "ARTIFACTS", label: "fork API", uri: `POST ${forkRoute()}`, short: `POST ${forkRoute()}`, note: "REST", look: TX.label, rank: URI_RANK.other },
    ...st.forks.map(
      (f): UriRow => ({
        group: "ARTIFACTS",
        label: f.fork,
        uri: artifactsRemote(forkRepo(f.fork)),
        short: repoShort(forkRepo(f.fork)),
        note: `${f.agent} ${f.branch}${f.merged ? " MERGED" : ""}`,
        look: f.merged ? TX.okB : TX.lock,
        rank: f.merged ? URI_RANK.primary : URI_RANK.fork
      })
    ),
    ...(live === null ? [] : [{ group: "ARTIFACTS" as const, label: "live repo", uri: live.remote, short: live.remote, note: live.repo, look: TX.okB, rank: URI_RANK.primary }])
  ]
  return rows
}

const UriLine = (p: { readonly r: UriRow; readonly labelWidth: number; readonly showNote: boolean }) => (
  <Box>
    <Ref {...TX.label} width={p.labelWidth}>
      {p.r.label}
    </Ref>
    <Ref {...p.r.look}>{p.r.uri}</Ref>
    {p.showNote ? <Text>{"  "}</Text> : null}
    {p.showNote ? <Ref {...TX.meta}>{p.r.note}</Ref> : null}
  </Box>
)

export const UrisPanel = (p: PanelProps) => {
  const rows = uriRows(p.state, p.inputs)
  const group = (g: UriRow["group"]) => rows.filter((r) => r.group === g)
  return (
    <Panel title="CLOUDFLARE URIs: R2 + Artifacts" keyLabel="u" color={C.blue} focused={p.focused} width={p.width}>
      <Text {...TX.meta}>Placeholder account id; every object and repo the run reads or writes.</Text>
      <Cell {...TX.info} bold>
        R2 (bucket, lease locks, cache)
      </Cell>
      {group("R2").map((r) => (
        <UriLine r={r} labelWidth={W.label} showNote />
      ))}
      <Cell {...TX.brand} bold>
        Artifacts (Git remotes; one repo per fork)
      </Cell>
      {group("ARTIFACTS").map((r) => (
        <UriLine r={r} labelWidth={W.label} showNote />
      ))}
      {p.state.forks.length === 0 ? <Text {...TX.label}>Fork remotes appear when the agents fork trunk (press SPACE).</Text> : null}
    </Panel>
  )
}

/** The compact URI lines of the overview tile: at most `rows`, most important first. */
export const compactUriLines = (st: State, inputs: Inputs, rows: number): InkNode[] =>
  [...uriRows(st, inputs)]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, rows))
    .map((r) => (
      <Box>
        <Cell {...(r.group === "R2" ? TX.info : TX.brand)} width={OVERVIEW.tag}>
          {r.group === "R2" ? "R2" : "ART"}
        </Cell>
        <Ref {...r.look}>{r.short}</Ref>
      </Box>
    ))
