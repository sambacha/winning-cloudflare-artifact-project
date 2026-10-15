/**
 * The clean scenario as a pure function: `cleanFrame(state, statuses, cols,
 * rows, clock)` returns exactly `rows` lines of exactly `cols` display
 * columns (W1), for any terminal of at least 80x24. Below that it shows a
 * "too small" message of the same exact size.
 *
 * Layout: top border, header, rule, body (the focused panel, or the start
 * screen), the SIMULATED ACTIONS strip (from `CLEAN_STRIP.minRows` rows up),
 * rule, footer, bottom border. Only the focused panel is drawn, so
 * a panel's text (and every recording anchor in it) is on screen only while
 * that panel is shown.
 */
import { type Line, center, fit, s } from "../ansi.ts"
import { renderToLines } from "../ink/index.ts"
import {
  BisectPanel,
  BuildPanel,
  CleanEventStream,
  CleanFooter,
  CleanHeader,
  CleanStart,
  CoordinationPanel,
  DependenciesPanel,
  EnvironmentPanel,
  visibleEvents
} from "../panels/CleanPanels.tsx"
import { CleanActionsStrip } from "../panels/CleanActions.tsx"
import { CleanChartsPanel } from "../panels/CleanCharts.tsx"
import { C, T } from "../theme.ts"
import type { BisectStatus } from "./bisectStatus.ts"
import type { ClockSource } from "./clock.ts"
import { CLEAN_MIN, cleanStripRows, FRAME_CHROME_ROWS, PANEL_CHROME_ROWS } from "./layout.ts"
import type { CleanState } from "./model.ts"

export const cleanBody = (st: CleanState, statuses: ReadonlyArray<BisectStatus>, iw: number, bodyRows: number): Line[] => {
  const p = { st, statuses, width: iw }
  switch (st.focus) {
    case 0:
      return renderToLines(<CleanStart t={st.t} width={iw} />, iw)
    case 1:
      return renderToLines(<EnvironmentPanel {...p} />, iw)
    case 2:
      return renderToLines(<DependenciesPanel {...p} />, iw)
    case 3:
      return renderToLines(<BuildPanel {...p} />, iw)
    case 4:
      return renderToLines(<BisectPanel {...p} />, iw)
    case 5:
      return renderToLines(<CoordinationPanel {...p} />, iw)
    case 6:
      return renderToLines(<CleanEventStream {...p} maxRows={bodyRows - PANEL_CHROME_ROWS} />, iw)
    case 7:
      return renderToLines(<CleanChartsPanel {...p} rows={bodyRows} />, iw)
  }
}

export const cleanFrame = (st: CleanState, statuses: ReadonlyArray<BisectStatus>, cols: number, rows: number, clock: ClockSource): ReadonlyArray<Line> => {
  if (cols < CLEAN_MIN.cols || rows < CLEAN_MIN.rows) {
    const msg: Line = [s(`Terminal ${cols}x${rows} is too small: need at least ${CLEAN_MIN.cols}x${CLEAN_MIN.rows}.`, T.warnB)]
    return Array.from({ length: Math.max(0, rows) }, (_, i): Line => fit(i === Math.floor(rows / 2) ? center(msg, cols) : [], cols))
  }
  const iw = cols - 2
  const stripRows = cleanStripRows(rows)
  const bodyRows = rows - FRAME_CHROME_ROWS - stripRows
  const frameStyle = { fg: C.cyan, dim: true }
  const wrap = (l: Line): Line => [s("║", frameStyle), ...fit(l, iw), s("║", frameStyle)]
  const rule: Line = [s("╠" + "═".repeat(iw) + "╣", frameStyle)]
  const head = renderToLines(<CleanHeader clock={clock} t={st.t} width={iw} />, iw)
  const body = cleanBody(st, statuses, iw, bodyRows)
  const foot = renderToLines(<CleanFooter focus={st.focus} width={iw} />, iw)
  const strip = stripRows === 0 ? [] : renderToLines(<CleanActionsStrip events={visibleEvents(st, statuses)} width={iw} rows={stripRows} />, iw)
  return [
    [s("╔" + "═".repeat(iw) + "╗", frameStyle)],
    wrap(head[0] ?? []),
    rule,
    ...Array.from({ length: bodyRows }, (_, i) => wrap(body[i] ?? [])),
    ...Array.from({ length: stripRows }, (_, i) => wrap(strip[i] ?? [])),
    rule,
    wrap(foot[0] ?? []),
    [s("╚" + "═".repeat(iw) + "╝", frameStyle)]
  ].map((l) => fit(l, cols))
}
