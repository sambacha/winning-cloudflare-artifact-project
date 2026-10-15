/**
 * Panel 6: the event stream (last events, newest at the bottom). A new line
 * is highlighted (bold) for `FRESH_S` seconds; there is no slide-in
 * animation (decision log in `docs/tui-demo-report.md`).
 */
import { Box, Text } from "../ink/index.ts"
import { FRESH_S, W } from "../layout.ts"
import type { Event, Kind } from "../scenario.ts"
import { C, TX, type TextLook } from "../theme.ts"
import { describeLockEvent, eventKindOf } from "../liveFeed.ts"
import { Cell, Num, Panel, Parts, ProvTag } from "./common.tsx"
import type { PanelProps } from "./props.ts"

const KIND_LOOK: Readonly<Record<Kind, TextLook>> = {
  LOCK: TX.lock,
  FORK: TX.brand,
  TOKEN: TX.brand,
  CACHE: TX.info,
  HB: TX.ok,
  LEAN: { color: C.green, bold: true },
  LEASE: TX.badB,
  REVIEW: TX.warnB,
  MERGE: TX.okB,
  REJECT: TX.badB,
  COST: TX.warnB
}

/** An event is an alarm if it reports an expiry or a missed renewal. */
export const isAlarm = (e: Event): boolean => e.kind === "LEASE" || e.parts.some((p) => typeof p === "string" && p.includes("MISSING"))

export const EventStream = (p: PanelProps & { readonly clock: (t: number) => Parameters<typeof Num>[0]["d"] }) => {
  const feed = p.state.feed
  // Live mode: events derived from consecutive R2 lock polls (`liveFeed.ts` `diffLocks`), not the script.
  const events: ReadonlyArray<Event> =
    feed === undefined ? p.state.events : feed.events.map((fe) => ({ t: fe.t, kind: eventKindOf(fe.event), parts: [{ ref: describeLockEvent(fe.event) }] }))
  const last = events.slice(-W.events)
  return (
    <Panel
      title={
        <Text>
          EVENT STREAM{" "}
          {feed === undefined ? <Text {...TX.meta}>R2 conditional writes, Durable Object, SSE</Text> : <Text {...TX.meta}>derived from R2 lock polls</Text>}
          {feed === undefined ? null : <ProvTag prov={feed.provenance.events} />}
        </Text>
      }
      keyLabel="e"
      color={C.cyan}
      focused={p.focused}
      width={p.width}
    >
      {last.length === 0 ? (
        <Text {...TX.label}>{feed === undefined ? "No events yet. Press SPACE to trigger a cobuild." : "No lock changes seen yet (polling the Worker)."}</Text>
      ) : (
        last.map((e) => {
          const fresh = p.state.t - e.t < FRESH_S
          const look = isAlarm(e) ? TX.bad : fresh ? TX.strong : TX.value
          return (
            <Box>
              <Num d={p.clock(e.t)} width={W.clock} {...TX.meta} />
              <Cell {...KIND_LOOK[e.kind]} width={W.kind}>
                {e.kind}
              </Cell>
              <Parts parts={e.parts} {...look} />
            </Box>
          )
        })
      )}
    </Panel>
  )
}
