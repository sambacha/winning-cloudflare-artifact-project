/** Panel 2: R2 lease locks (one card per operation). */
import { lockFigures } from "../derive.ts"
import { Box, type InkNode, Text } from "../ink/index.ts"
import { URGENT_S, W } from "../layout.ts"
import type { Lock } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { lockKey } from "../uris.ts"
import { Bar, Cell, Glyph, Num, Panel, Ref, taggedTitle } from "./common.tsx"
import { blink, type PanelProps } from "./props.ts"

const stateLook = (l: Lock): TextLook =>
  l.state === "SUCCEEDED" ? TX.okB : l.state === "BUILDING" ? TX.warnB : l.state === "FAILED" || l.state === "EXPIRED" ? TX.badB : TX.label

const Row = (p: { readonly label: string; readonly children?: InkNode }) => (
  <Box>
    <Cell {...TX.label} width={W.label}>
      {p.label}
    </Cell>
    <Text>{p.children}</Text>
  </Box>
)

const LockCard = (p: { readonly l: Lock; readonly t: number; readonly width: number; readonly pulseOn: boolean }) => {
  const l = p.l
  const f = lockFigures(l, p.t)
  const finished = l.state === "SUCCEEDED" || l.state === "FAILED"
  const takeover = l.via.startsWith("If-Match (takeover)")
  const barW = Math.max(W.minBar, Math.min(W.bar, p.width - W.barReserve))
  const fresh = f.sinceWrite !== null && f.sinceWrite.value < 1
  return (
    <Box flexDirection="column" width={p.width} borderStyle="round" borderColor={l.state === "FREE" ? C.gray : C.magenta} borderDimColor={!takeover} paddingX={1}>
      <Ref {...TX.lock}>{l.op}</Ref>
      {l.live === true && l.state !== "SUCCEEDED" ? (
        <Text>
          <Text {...TX.label}>progress not reported by R2 </Text>
          <Text {...stateLook(l)}>{l.state}</Text>
        </Text>
      ) : (
        <Box>
          <Bar fraction={l.progress} width={barW} on={l.state === "SUCCEEDED" ? TX.ok : l.state === "FAILED" ? TX.bad : TX.warn} />
          <Text> </Text>
          <Num d={f.progress} digits={0} width={W.pct} {...TX.value} />
          <Text {...stateLook(l)}>{l.state}</Text>
        </Box>
      )}
      <Row label="holder:">
        <Ref {...TX.value}>{l.holder ?? "—"}</Ref>
        <Text {...TX.label}>{"   etag: "}</Text>
        {l.etag === null ? <Glyph name="dash" {...TX.label} /> : <Ref {...TX.lock}>{`"${l.etag}"`}</Ref>}
      </Row>
      <Row label="expiry:">
        {f.expiresIn === null ? (
          <Text {...TX.label}>{l.state === "SUCCEEDED" ? "released" : "—"}</Text>
        ) : (
          <Num d={f.expiresIn} digits={0} prefix="in " {...(f.expiresIn.value < URGENT_S ? TX.badB : TX.value)} />
        )}
        <Text>{"   "}</Text>
        {f.sinceWrite === null ? (
          <Text {...TX.label}>last write: —</Text>
        ) : finished ? (
          <Text>
            <Text {...TX.label}>{l.state === "FAILED" ? "failed " : "published "}</Text>
            <Num d={f.sinceWrite} digits={0} suffix=" ago" {...TX.value} />
          </Text>
        ) : (
          <Text>
            <Text {...TX.label}>last write </Text>
            <Num d={f.sinceWrite} digits={0} suffix=" ago " {...TX.value} />
            {l.renewalOverdue === true ? <Text {...TX.badB}>renewal overdue</Text> : <Glyph name="ok" {...(fresh && p.pulseOn ? TX.okB : TX.ok)} />}
          </Text>
        )}
      </Row>
      <Row label="key:">
        <Ref {...TX.value}>{l.key ?? lockKey(l.op)}</Ref>
      </Row>
      <Row label="via:">
        <Ref {...TX.lock}>{l.via}</Ref>
      </Row>
      {l.prev === null ? null : (
        <Row label="prev:">
          <Ref {...TX.bad}>{l.prev}</Ref>
        </Row>
      )}
      {l.result === null ? null : (
        <Row label="result:">
          <Ref {...TX.ok}>{l.result}</Ref>
        </Row>
      )}
    </Box>
  )
}

export const LocksPanel = (p: PanelProps) => (
  <Panel
    title={
      p.state.feed !== undefined ? (
        taggedTitle("R2: LEASE LOCKS", p.state, "locks")
      ) : p.state.live === true ? (
        <Text>
          R2: LEASE LOCKS <Text {...TX.okB}>[LIVE]</Text>
        </Text>
      ) : (
        "R2: LEASE LOCKS"
      )
    }
    keyLabel="2"
    color={C.magenta}
    focused={p.focused}
    width={p.width}
  >
    {p.state.locks.map((l) => (
      <LockCard l={l} t={p.state.t} width={p.width - W.lockInset} pulseOn={blink(p)} />
    ))}
  </Panel>
)
