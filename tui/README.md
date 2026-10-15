# FAME-XGA Cobuilds TUI (demo)

A full-screen terminal dashboard for demos and recordings. It shows the three
views from the design brief side by side:

1. **Cobuilds coordination**: agent forks and R2 lease locks.
2. **Lean 4 CI metrics**: axiom audit, phases, scaling and the CI gate.
3. **Cost savings against GitHub Actions**.

It also lists every Cloudflare R2 and Artifacts URI the run touches (panel
`[7]`, key `u`) and keeps a permanent **SIMULATED ACTIONS** strip at the
bottom of every view: the R2 uploads/downloads, conditional writes and lease
operations, and the Artifacts fork/push/PR/merge steps with per-task progress.

**It is a demonstration only.** It does not talk to R2, Workers, Durable
Objects, Artifacts, GitHub or Lean, and it imports nothing from `ts/` or
`RequestProject/` (a test checks this). Every number is an illustrative figure
from the design brief (`src/data.ts`). The status bar says
`ILLUSTRATIVE DATA` on every frame.

## Run

Requires Node ≥ 22.18, which runs TypeScript directly. There are no
dependencies and nothing to install.

```
cd tui
node src/main.ts                 # interactive (needs a terminal, 140×40 or larger recommended, minimum 100×24)
node src/main.ts --autoplay      # plays the recording script by itself (triggers after 2 s, approves the PR at 56 s)
node src/main.ts --autoplay --speed 2
node src/main.ts --snapshot 52 --no-color [--cols 140 --rows 60 --scroll 40 --approve 56 --overlay notes|git|help]
node src/main.ts --overview      # every panel as a tile on one screen (cost, locks, forks, URIs, charts)
node src/main.ts --charts        # interactive, opening on the charts view (graphs of the run)
node src/main.ts --charts --autoplay   # the scripted run with the charts drawing themselves
node src/main.ts --snapshot 45 --charts [--chart 1-6 --zoom] --no-color   # one charts frame
node src/main.ts --notes         # the brief's figures, stated vs recomputed
npm test                         # 108 tests (fresh seed each run; TUI_SEED=<n> replays)
node ../ts/node_modules/typescript/bin/tsc -p tsconfig.json   # type check (uses the TypeScript already in ts/)
```

`NO_COLOR=1` or `--no-color` turns colours off. Colours are 24-bit (the
brief's palette).

## Keys

| Key | Action |
|---|---|
| `SPACE` | trigger a cobuild (restarts the scripted run) |
| `1`–`5` | focus and jump to a panel: 1 forks, 2 locks, 3 cache, 4 Lean metrics, 5 cost |
| `u`, `7` | focus and jump to the Cloudflare URIs panel (R2 bucket, objects, lock keys, Artifacts remotes) |
| `o` | overview: every panel as a tile on one screen; `o` or `Esc` closes it |
| `e` | jump to the event stream |
| `a` / `r` | approve / reject agent-gamma's PR (only while the review gate is open) |
| `c` | charts view (see below); `c` or `Esc` closes it |
| `[` `]` / `{` `}` | scrub the script time by 1 s / 5 s (pauses; `p` or `SPACE` resumes) |
| `w` | git view of the forks |
| `n` | data notes: every figure of the brief, stated vs recomputed |
| `h`, `?` | help |
| `j` `k` `↑` `↓` `PgUp` `PgDn` `g` `G` | scroll |
| `+` / `-` / `p` | faster / slower / pause |
| `q`, `Ctrl-C` | quit |

## Layout

The header (logo when the terminal has at least 50 rows, otherwise a one-line
title), the status bar and the controls stay pinned. The panels scroll
between them:

```
COORDINATION   [1] Artifacts: agent forks        [2] R2: lease locks
R2 BUILD CACHE [3] Merkle key, blobs, manifest, cache stats
LEAN 4 CI      [4] Axiom audit performance       Build pipeline
COST SAVINGS   [5] Monthly comparison            Per-run breakdown
CLOUDFLARE URIs[7] R2 bucket, cache objects, lock keys, Artifacts remotes (trunk and one per fork)
EVENT STREAM       last 15 events
---------------------------------------------------------------------------
SIMULATED ACTIONS  (pinned, in every view) the latest R2 / Artifacts actions,
                   and on the right each Artifacts task's progress and the
                   R2 upload/download bars
```

The overview (`o`, `--overview`) puts the panels in a 3×3 grid: Monthly CI
Cost Comparison, Per-Run Cost Breakdown, BUILD & AUDIT PROGRESS (chart) /
R2: LEASE LOCKS, ARTIFACTS: Agent Forks, CLOUDFLARE URIs / event stream,
R2 build cache, Lean CI metrics. The SIMULATED ACTIONS strip stays below it.
The URIs are illustrative (bucket `cobuilds-demo`, account `<ACCOUNT_ID>`,
`src/uris.ts`); nothing is contacted.

Sample frames (plain text) are in `examples/`.

## Charts view (`c`)

An interactive dashboard of graphs drawn from the same scripted run. Every
point is a state of `stateAt(t)` (`src/charts/series.ts`), so the charts
and the panels never disagree, and a chart only shows the run up to the
current script time. Scales are fixed for the whole run, so nothing rescales
while it plays.

```
[1] LEASE TIMELINE          who holds each lock over time (Gantt); crash ✗, stale lease ░, takeover
[2] CUMULATIVE CI COST      Cobuilds cost so far vs the GitHub Actions equivalent (Braille line chart)
[3] BUILD & AUDIT PROGRESS  mean lock progress and share of the axiom audit done, in percent
[4] ACTIVITY                events per 2 s (bar chart) and conditional R2 writes (sparkline)
[5] MONTHLY COST            GitHub Actions (standard, larger) vs Cobuilds per month (bar chart)
[6] AXIOM AUDIT ALGORITHMS  audit time per algorithm on a log scale, with the speedup
```

| Key (charts view) | Action |
|---|---|
| `1`–`6`, `←` `→`, `Tab`, `l` | select a chart (the body scrolls to it) |
| `z`, `Enter` | zoom the selected chart to the whole body (and back) |
| `[` `]`, `{` `}` | move the time cursor ±1 s / ±5 s (pauses the run) |
| `p` | resume / pause |
| `a` / `r` | approve / reject while the review gate is open |
| `c`, `Esc` | close the charts |

The dotted vertical line (`┊`) is the time cursor; the legend of each chart
shows the values at the cursor. Tiles sit two per row from 116 inner columns
and stack below that; at 80×24 the body scrolls. `--ascii` replaces the
Braille and block glyphs by same-width ASCII.

The clean scenario has a charts panel too: key `7` or `c` (or start with
`--scenario clean --charts`). It shows the bisect confidence and remaining
entropy per observation, the probe of each observation on the commit axis
(✓ pass, ✗ fail, ● culprit guess), the cache effect (dependency restore vs
cold install, build-cache hits vs misses) and the cost per run. The bisect
charts fill in while the Bisect panel (key `4`) replays the observations,
and read the probes from the status bodies' tallies, so they work the same
in `--live` mode.

`tape/demo-charts.tape` records both (`vhs tape/demo-charts.tape`, once the
recording tools are installed). All figures are illustrative, as everywhere
in this demo.

## The scripted run

`src/scenario.ts` is a pure function from script time to dashboard state.
The run follows the brief's event stream (12:04:31 = 0 s):

- alpha takes `op:mathlib-import`, beta `op:build-core`, gamma `op:lint-lean`;
- alpha imports Mathlib (7–25 s), takes `op:axiom-audit` at 20 s, audits
  1,600 theorems (21–24 s) and publishes the manifest at 25 s;
- alpha's heartbeat is missing at 30 s (simulated crash), and its lease
  expires at 50 s;
- gamma takes over with `If-Match` on alpha's ETag, gets a cache hit, and
  opens a PR at 52 s;
- the PR waits for `a` or `r`.

Events added to the brief's stream so that every panel has a cause:
gamma's fork, alpha's `op:axiom-audit` acquisition, beta's heartbeats and
completion, lint completion, the review gate, and the reject path.

## Files

| File | Contents |
|---|---|
| `src/data.ts` | the brief's figures (inputs only; nothing derived is typed in) |
| `src/costModel.ts` | derived figures (savings, ROI, per-run totals, speedups, Amdahl) and `dataNotes()` |
| `src/scenario.ts` | the scripted run as a pure function of time |
| `src/view.ts`, `widgets.ts`, `logo.ts`, `ansi.ts`, `theme.ts` | rendering: styled segments, exact widths, boxes |
| `src/app.ts` | key/tick reducer (pure) |
| `src/charts/plot.ts` | chart primitives: Braille line charts, eighth-block bars and sparklines (pure) |
| `src/charts/series.ts`, `run.ts`, `clean.ts` | the series and chart models of the two scenarios |
| `src/charts/layout.ts` | tile declarations and sizes of the charts view |
| `src/panels/ChartKit.tsx`, `ChartsView.tsx`, `CleanCharts.tsx` | chart components (axes, legends, tiles) |
| `src/main.ts` | terminal I/O, CLI |
| `test/*.test.ts` | property tests with counts, broken-variant checks, replay, independence |

## Clean build-pipeline scenario (`--scenario clean`)

A second scripted run: cold start, node_modules cache RESTORING then HIT,
incremental build (10 hits / 2 misses), bisect converging on `#34` at 0.962,
three active leases, review approval, git note, clean quit. The original
crash/takeover run is still the default (`--scenario failure`).

```bash
node src/main.ts --scenario clean --autoplay --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 40
```

| Option | Meaning |
|---|---|
| `--scenario clean\|failure` | which scripted run to show |
| `--fixed-time <iso8601>` | pins the status-bar clock (no wall-clock reads in the render path) |
| `--autoplay` | drives the fixed key script; with non-TTY stdout it prints a plain transcript ending in `--- transcript end ---` |
| `--session <id>` | live mode: bisect panel reads `GET /api/bisect/:id` instead of the fixture |

Keys: `1`-`6` select Environment, Dependencies, Build, Bisect, Coordination,
Event stream (`e` is an alias for `6`); `a` approve, `n` write note; `q` or
`Ctrl+Q` quit. No `--seed` exists: two `--fixed-time` runs diff to empty,
and build durations come from a constant table (`src/clean/fixture.ts`).

Recording: `bash scripts/record-demo.sh --check-only` checks the tools and the
invariants (I1-I4, I6, anchor uniqueness, key map, and I7: the headless
preflight of `tape/demo.tape` and `tape/demo-mp4.tape`) without recording;
`bash scripts/record-demo.sh` also records `recordings/demo.{mp4,gif,ascii}`,
frames and stills (two takes, diffed). Add `--with-failure` to also record the
failure scenario. The script never installs anything; it prints the install
commands for missing tools (macOS first, Linux hints) and exits with status 2.
Tapes are in `tape/` (`demo.tape`, `dryrun.tape`, `stills.tape`,
`demo-failure.tape`, shared `common.tape` and `setup.sh`).

`tape/demo.tape` is in three acts:

1. **Overview.** The dashboard paused at 23 s: the overview of every panel,
   then a few seconds each on the cost panels (Monthly CI Cost Comparison,
   Per-Run Cost Breakdown), R2: LEASE LOCKS, ARTIFACTS: Agent Forks, the
   Cloudflare URIs and the charts with BUILD & AUDIT PROGRESS zoomed.
2. **Process.** The clean build-pipeline run, step by step.
3. **Result.** The dashboard overview again, playing the whole run at 4x and
   pausing on the end state (crash, takeover, approval, merge), so every
   panel shows the difference from act 1; then the charts once more.

The SIMULATED ACTIONS strip is on screen in every scene.

`tape/stills.tape` captures the dashboard stills (overview, cost, locks,
forks, URIs, progress chart, final overview) and the clean-run stills. Its
setup is hidden, but the screenshots are taken in the shown part: VHS only
captures frames while the tape is shown, so a tape that stays hidden writes
no PNG and fails with "no frames".

The unit tests resolve fixture paths with `fileURLToPath`, so they also pass
from a checkout whose path contains spaces (`new URL(...).pathname` kept
`%20` and made three tests fail).

### MP4 demo (`scripts/vhs-demo-mp4.sh`)

`bash tui/scripts/vhs-demo-mp4.sh` records `recordings/demo.mp4` from
`tape/demo-mp4.tape`, which runs about 2 minutes 15 seconds and follows the
same three acts as `tape/demo.tape` (overview of the paused dashboard and a
few seconds on each panel; the clean run, ending on its charts panel; the
dashboard overview again at the end state).

The tape has no `Wait` commands, so VHS can't stop on a `Wait+Screen` timeout:

- The dashboard is paused at exact script times with the scrub keys.
- The clean run plays its own `--autoplay` script.

Before recording, `scripts/vhs-demo-preflight.ts` replays the tape's
`# expect:` checkpoints against the TUI, with and without simulated recorder
lag. Pass `--strict` to stop if a checkpoint fails.

On a busy machine, VHS drops frames and the MP4 comes out shorter than the
session. The script reports this but doesn't fail; it re-times the video with
ffmpeg so it plays at real speed (`--no-retime` keeps VHS's version). If VHS
fails, the script runs it once more at 20 frames/s.

One still per checkpoint is written to `recordings/demo-checkpoints/`;
`index.txt` lists what each still should show. The tapes use the system's
default monospace font, so no font has to be installed.
