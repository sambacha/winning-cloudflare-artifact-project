/**
 * Panel 3: the R2 build cache. This is the brief's `CachePanel.tsx`, fixed:
 * - the `<Box>` is closed by `</Box>` (the brief closed it with `</Blob>`);
 * - the manifest is formatted by `ManifestSummary` (the brief called
 *   `.replace` on an object literal);
 * - the digest prefix comes from `inputs.cache.hashPrefix` (the brief
 *   sliced a hard-coded 7 characters);
 * - every figure is a derived value with its unit, and the per-entry size
 *   (MB) is labelled apart from the monthly storage of all retained entries
 *   (GB-month), the two quantities the brief mixed up.
 */
import type { Figures } from "../derive.ts"
import { Box, Text } from "../ink/index.ts"
import { W } from "../layout.ts"
import { C, TX } from "../theme.ts"
import { formatBytes, type LiveCache } from "../liveFeed.ts"
import { Glyph, Num, Panel, Ref, taggedTitle } from "./common.tsx"
import type { PanelProps } from "./props.ts"

/** The visible part of a digest: the hash after `prefix`, cut to `n` characters. */
export const shortDigest = (digest: string, prefix: string, n: number): string =>
  digest.startsWith(prefix) ? digest.slice(prefix.length, prefix.length + n) : digest.slice(0, n)

/** The manifest as `blobs, build time, tool, mathlib` (the brief's `{…}.replace(...)` did not run). */
export const ManifestSummary = (p: { readonly fig: Figures; readonly tool: string; readonly mathlib: string }) => (
  <Text {...TX.meta}>
    {"{blobs: "}
    <Num d={p.fig.cache.blobCount} bare />
    {", build: "}
    <Num d={p.fig.cache.buildMs} />
    {", tool: "}
    <Ref>{p.tool}</Ref>
    {", mathlib: "}
    <Ref>{p.mathlib}</Ref>
    {"}"}
  </Text>
)

/** Live summary of the scope's objects in R2 (`GET /api/cache`). */
export const LiveCacheSummary = (p: { readonly c: LiveCache }) => (
  <Box flexDirection="column">
    <Text>
      <Text {...TX.label}>{"Live R2, scope "}</Text>
      <Ref {...TX.value}>{p.c.scope}</Ref>
      <Text {...TX.label}>{": blobs "}</Text>
      <Ref {...TX.okB}>{String(p.c.blobCount)}</Ref>
      <Text {...TX.label}>{" ("}</Text>
      <Ref {...TX.info}>{formatBytes(p.c.blobBytes)}</Ref>
      <Text {...TX.label}>{") │ manifests "}</Text>
      <Ref {...TX.okB}>{String(p.c.manifestCount)}</Ref>
      <Text {...TX.label}>{" ("}</Text>
      <Ref {...TX.info}>{formatBytes(p.c.manifestBytes)}</Ref>
      <Text {...TX.label}>{")"}</Text>
      {p.c.truncated ? <Text {...TX.warn}>{" │ listing truncated"}</Text> : null}
    </Text>
    <Text {...TX.meta}>The example entry below is illustrative.</Text>
    <Text> </Text>
  </Box>
)

export const CachePanel = (p: PanelProps) => {
  const c = p.inputs.cache
  const f = p.fig.cache
  const prefix = c.hashPrefix
  const at = c.lookupKey.indexOf(prefix)
  const scheme = at < 0 ? "" : c.lookupKey.slice(0, at)
  const hash = at < 0 ? c.lookupKey : c.lookupKey.slice(at + prefix.length)
  const storage = p.fig.cost.drivers.find((d) => d.driver.group === "storage")
  const published = p.state.published
  return (
    <Panel title={taggedTitle("R2 BUILD CACHE", p.state, "cache")} keyLabel="3" color={C.blue} focused={p.focused} width={p.width}>
      {p.state.feed?.cache != null ? <LiveCacheSummary c={p.state.feed.cache} /> : null}
      <Text {...TX.label}>Merkle lookup key:</Text>
      <Text>
        <Ref {...TX.brand}>{scheme}</Ref>
        <Ref {...TX.lock}>{prefix}</Ref>
        <Ref {...TX.ok}>{hash}</Ref>
      </Text>
      <Text {...TX.label}>
        {"Scope: "}
        <Ref>{c.scope}</Ref>
        {" │ Inputs: "}
        <Num d={f.inputs} />
        {" │ Deps: "}
        <Num d={f.deps} />
        {" │ Salt: "}
        <Ref>{c.salt}</Ref>
      </Text>
      <Text> </Text>
      <Text color={C.gray} bold>
        Blobs (create-only, content-addressed):
      </Text>
      {f.blobs.map((b, i) => (
        <Box>
          <Text {...TX.label}>{i === f.blobs.length - 1 ? "└─ " : "├─ "}</Text>
          {published ? <Glyph name="ok" {...TX.ok} /> : <Glyph name="middot" {...TX.label} />}
          <Text> </Text>
          <Ref {...TX.lock}>{prefix}</Ref>
          <Ref {...TX.ok} width={W.digest + W.ellipsis}>{`${shortDigest(b.digest, prefix, W.digest)}…`}</Ref>
          <Num d={b.size} width={W.wideCell} align="right" {...TX.value} />
          <Text {...TX.meta}>{"  zstd:"}</Text>
          <Num d={f.zstdLevel} bare {...TX.meta} />
          <Text>{"  "}</Text>
          {!published ? (
            <Text {...TX.label}>not yet published</Text>
          ) : (
            <Text>
              {b.shared.value > 1 ? <Num d={b.shared} prefix="shared by " {...TX.brand} /> : <Text {...TX.label}>unique</Text>}
              <Text>{"  "}</Text>
              <Glyph name="ok" {...(p.state.verifiedByTaker ? TX.okB : TX.ok)} />
              <Text {...(p.state.verifiedByTaker ? TX.okB : TX.ok)}> verified</Text>
            </Text>
          )}
        </Box>
      ))}
      <Text> </Text>
      <Text color={C.gray} bold>
        Manifest (commit point):
      </Text>
      <Box>
        <Text {...TX.label}>{"└─ "}</Text>
        {published ? <Glyph name="ok" {...TX.ok} /> : <Glyph name="middot" {...TX.label} />}
        <Text> </Text>
        <Ref {...TX.value}>{scheme}</Ref>
        <Ref {...TX.lock}>{prefix}</Ref>
        <Ref {...TX.ok}>{`${hash.slice(0, W.manifestHash)}… `}</Ref>
        <ManifestSummary fig={p.fig} tool={c.manifest.tool} mathlib={c.manifest.mathlib} />
      </Box>
      <Text> </Text>
      <Text>
        <Text {...TX.label}>Hit rate: </Text>
        <Num d={f.hitRate} {...TX.okB} />
        <Text {...TX.label}> │ Dedup: </Text>
        <Num d={f.dedup} {...TX.ok} />
        <Text {...TX.label}> │ This entry: </Text>
        <Num d={f.stored} {...TX.info} />
        <Text {...TX.label}> │ Raw: </Text>
        <Num d={f.raw} {...TX.bad} />
        <Text {...TX.label}> │ Chunks: </Text>
        <Num d={f.chunks} bare {...TX.value} />
      </Text>
      <Text>
        <Text {...TX.label}>Space saved: </Text>
        <Num d={f.saved} {...TX.okB} />
        <Text {...TX.label}> (</Text>
        <Num d={f.savedPct} {...TX.label} />
        <Text {...TX.label}> of raw)</Text>
        {storage === undefined ? null : (
          <Text>
            <Text {...TX.label}> │ All retained entries (cost model): </Text>
            <Num d={storage.qty} {...TX.value} />
          </Text>
        )}
      </Text>
    </Panel>
  )
}
