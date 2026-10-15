/**
 * Frames and `--snapshot <sec> --seed <n>` determinism.
 *
 * - The three supported sizes give the expected layout and exact sizes.
 * - The same arguments give byte-identical output, in process and across
 *   two separate processes running the real CLI.
 * - The scenario frame at the end shows the demo's outcome (culprit commit
 *   34, at least one skip, confidence >= 0.95) taken from the real session
 *   code, not hard-coded text.
 * - PhaseBar fill is clamped to [0, 30].
 */
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { BAR_CELLS, SUPPORTED_SIZES } from "../../src/tui/constants.js"
import { bar, barFill } from "../../src/tui/derive.js"
import { layoutFor, renderFrame } from "../../src/tui/frame.js"
import { initialUi } from "../../src/tui/model.js"
import { FOOTER } from "../../src/tui/rows.js"
import { scenarioInput } from "../../src/tui/scenario.js"
import { parseSnapshotArgs, snapshotText } from "../../src/tui/snapshot.js"
import { displayWidth } from "../../src/tui/width.js"

const cli = (args: ReadonlyArray<string>): string =>
  execFileSync(process.execPath, ["node_modules/vite-node/vite-node.mjs", "src/tui/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })

describe("frames", () => {
  it("layout class per size: small 80x24, medium 120x40, large 200x60", () => {
    expect(layoutFor(80, 24, 4).size).toBe("small")
    expect(layoutFor(120, 40, 4).size).toBe("medium")
    expect(layoutFor(200, 60, 4).size).toBe("large")
    expect(layoutFor(120, 40, 4).slots.length).toBe(6)
    expect(layoutFor(200, 60, 4).slots.length).toBe(6)
  })

  it("every frame is exactly cols x rows with the footer controls last", () => {
    for (const { cols, rows } of SUPPORTED_SIZES) {
      for (let sec = 0; sec <= 150; sec += 5) {
        const lines = renderFrame(scenarioInput("1", sec), initialUi, cols, rows)
        expect(lines.length).toBe(rows)
        for (const l of lines) expect(displayWidth(l)).toBe(cols)
        expect(lines[rows - 1]!.trimEnd()).toBe(FOOTER)
      }
    }
  })

  it("frames contain no emoji, no box-drawing or other ambiguous-width glyphs: only printable ASCII here", () => {
    for (const { cols, rows } of SUPPORTED_SIZES) {
      const text = renderFrame(scenarioInput("7", 100), { ...initialUi, notes: true }, cols, rows).join("\n")
      expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true)
    }
  })

  it("the end of the scenario shows the culprit (commit 34), a skip, and confidence >= 0.95, from the session code", () => {
    const d = scenarioInput("1", 200)
    const st = d.bisect!.body.status
    expect(st.done).toBe(true)
    const idx = d.bisect!.body.tally.length > 0 ? st.culprit.message : undefined
    expect(idx ?? "").toMatch(/34/)
    expect(st.skipped.length).toBeGreaterThanOrEqual(1)
    expect(st.confidence).toBeGreaterThanOrEqual(0.95)
    expect(st.observations + st.skipped.length).toBeLessThan(10)
  })
})

describe("--snapshot determinism", () => {
  it("same arguments give byte-identical frames in process", () => {
    for (const { cols, rows } of SUPPORTED_SIZES) {
      const a = snapshotText({ sec: 75, seed: "1", cols, rows })
      const b = snapshotText({ sec: 75, seed: "1", cols, rows })
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    }
  })

  it("different seeds change the bisect run but keep the frame valid", () => {
    const frames = ["1", "2", "3"].map((seed) => snapshotText({ sec: 60, seed, cols: 200, rows: 60 }))
    expect(new Set(frames).size).toBeGreaterThan(1)
  })

  it("two separate CLI processes print byte-identical frames", () => {
    for (const { cols, rows } of SUPPORTED_SIZES) {
      const args = ["--snapshot", "75", "--seed", "1", "--cols", String(cols), "--rows", String(rows)]
      const a = cli(args)
      const b = cli(args)
      expect(a).toBe(b)
      expect(a).toBe(snapshotText({ sec: 75, seed: "1", cols, rows }))
    }
  }, 120_000)

  it("argument parsing: defaults, panel, notes; malformed values are rejected", () => {
    expect(parseSnapshotArgs(["--seed", "1"], { cols: 80, rows: 24 })).toBeNull()
    expect(parseSnapshotArgs(["--snapshot", "5"], { cols: 80, rows: 24 })).toEqual({ sec: 5, seed: "1", cols: 80, rows: 24 })
    expect(parseSnapshotArgs(["--snapshot", "5", "--panel", "2", "--notes"], { cols: 80, rows: 24 })).toMatchObject({ focus: 2, notes: true })
    expect(() => parseSnapshotArgs(["--snapshot", "-1"], { cols: 80, rows: 24 })).toThrow(RangeError)
    expect(() => parseSnapshotArgs(["--snapshot", "1", "--panel", "9"], { cols: 80, rows: 24 })).toThrow(RangeError)
  })
})

describe("PhaseBar", () => {
  it("fill is clamped to [0, 30] and the bar is exactly its width", () => {
    for (const f of [-5, -0.1, 0, 0.5, 1, 1.7, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const n = barFill(f)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(BAR_CELLS)
      expect(bar(f).length).toBe(BAR_CELLS)
      expect(bar(f, 12).length).toBe(12)
    }
    expect(barFill(2)).toBe(BAR_CELLS)
    expect(barFill(-2)).toBe(0)
  })
})
