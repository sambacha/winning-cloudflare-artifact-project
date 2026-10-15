/**
 * The Ink components draw exactly the snapshot renderer's frame: the tree
 * of `<Dashboard>` laid out as text equals `renderFrame` line for line, at
 * every supported size and for every focused panel, over the scenario's
 * timeline. Also: each panel component is a standalone, props-only
 * component, and every `<Box>` / `<Text>` is a real element.
 */
import { describe, expect, it } from "vitest"
import { SUPPORTED_SIZES } from "../../src/tui/constants.js"
import { renderFrame } from "../../src/tui/frame.js"
import { Dashboard } from "../../src/tui/ink/Dashboard.js"
import { ArtifactsPanel } from "../../src/tui/ink/panels/ArtifactsPanel.js"
import { BisectPanel } from "../../src/tui/ink/panels/BisectPanel.js"
import { CostPanel } from "../../src/tui/ink/panels/CostPanel.js"
import { EventStream } from "../../src/tui/ink/panels/EventStream.js"
import { LeasePanel } from "../../src/tui/ink/panels/LeasePanel.js"
import { NodeModulesPanel } from "../../src/tui/ink/panels/NodeModulesPanel.js"
import { initialUi, type PanelKey } from "../../src/tui/model.js"
import { scenarioInput } from "../../src/tui/scenario.js"
import { assertWidths } from "../../src/tui/width.js"
import { countTypes, linesOf } from "./inkTree.js"

const FOCUS: ReadonlyArray<PanelKey> = [1, 2, 3, 4, 5]

describe("Ink dashboard", () => {
  it("lays out to exactly the snapshot frame at 80x24, 120x40 and 200x60", () => {
    for (const { cols, rows } of SUPPORTED_SIZES) {
      for (const sec of [0, 15, 45, 75, 120]) {
        for (const focus of FOCUS) {
          const input = scenarioInput("1", sec)
          const ui = { ...initialUi, focus, notes: sec === 120 }
          const lines = linesOf(<Dashboard input={input} ui={ui} cols={cols} rows={rows} />)
          expect(lines).toEqual(renderFrame(input, ui, cols, rows))
          expect(lines.length).toBe(rows)
          assertWidths(lines, cols)
        }
      }
    }
  })

  it("each panel is standalone: same props, same lines; exactly the requested size", () => {
    const input = scenarioInput("2", 90)
    const props = { input, ui: initialUi, width: 60, height: 12, focused: false }
    for (const P of [ArtifactsPanel, NodeModulesPanel, LeasePanel, BisectPanel, CostPanel, EventStream]) {
      const a = linesOf(<P {...props} />)
      const b = linesOf(<P {...props} />)
      expect(a).toEqual(b)
      expect(a.length).toBe(props.height)
      assertWidths(a, props.width)
      const c = countTypes(<P {...props} />)
      expect(c.box).toBe(1)
      expect(c.text).toBe(props.height)
    }
  })
})
