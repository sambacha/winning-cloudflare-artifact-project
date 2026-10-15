# The demo recording, in three acts (run from tui/: vhs tape/demo.tape):
#
#   1. Overview: the cobuild dashboard, paused mid-run (t = 23 s). First the
#      overview with every panel as a tile, then each panel on its own for a
#      few seconds: Monthly CI Cost Comparison and Per-Run Cost Breakdown,
#      R2: LEASE LOCKS, ARTIFACTS: Agent Forks, the Cloudflare URIs, then the
#      charts with BUILD & AUDIT PROGRESS zoomed.
#   2. Process: the 45-second clean build-pipeline run, step by step.
#   3. Result: the dashboard again, in the overview, playing the whole run at
#      4x (crash, takeover, approval, merge) and pausing on the end state, so
#      every panel shows the difference from act 1; then the charts once more.
#
# The SIMULATED ACTIONS strip (R2 uploads/downloads, Artifacts task progress)
# is on screen in every scene of acts 1 and 3, and under every panel of act 2.
#
# Timing: acts 1 and 3 have no Wait command. The dashboard is paused at exact
# script times with its scrub keys ("}" = +5 s, "]" = +1 s, both pause), so a
# slow recorder cannot miss a state. In act 2 every Wait+Screen pattern is a
# literal that occurs exactly once in tui/src (I2), and test/clean.test.ts
# replays that act against the clean run's state machine. The "# expect:"
# comments are checked by scripts/vhs-demo-preflight.ts, which replays the
# whole tape (with and without recorder lag) before anything is recorded.
Source "tape/common.tape"

Output recordings/demo.mp4
Output recordings/demo.gif
Output recordings/frames/
Output recordings/demo.ascii

Hide
Type "source tape/setup.sh"
Enter
Wait+Screen@10s /SETUP COMPLETE/
Show

# ---- act 1: overview of the dashboard ---------------------------------------
Type "node src/main.ts --overview --seed 1 --cols 140 --rows 40"
Enter
Sleep 2s
Type "}}}}]]]"
Sleep 6s
# expect: Monthly CI Cost Comparison | Per-Run Cost Breakdown | BUILD & AUDIT PROGRESS | R2: LEASE LOCKS | ARTIFACTS: Agent Forks | CLOUDFLARE URIs | SIMULATED ACTIONS | 12:04:54
Type "5"
Sleep 4s
# expect: Monthly CI Cost Comparison | Per-Run Cost Breakdown | SIMULATED ACTIONS | upload
Type "2"
Sleep 4s
# expect: R2: LEASE LOCKS | op:mathlib-import | SIMULATED ACTIONS
Type "1"
Sleep 4s
# expect: ARTIFACTS: Agent Forks | agent-alpha | SIMULATED ACTIONS
Type "u"
Sleep 4s
# expect: CLOUDFLARE URIs: R2 + Artifacts | r2.cloudflarestorage.com | artifacts.cloudflare.net/git/default/fame-xga.git | SIMULATED ACTIONS
Type "c"
Sleep 4s
# expect: LEASE TIMELINE | BUILD & AUDIT PROGRESS | MONTHLY COST | SIMULATED ACTIONS
Type "3"
Type "z"
Sleep 4s
# expect: BUILD & AUDIT PROGRESS  (zoomed) | SIMULATED ACTIONS
Type "z"
Type "o"
Sleep 3s
# expect: Monthly CI Cost Comparison | R2: LEASE LOCKS | ARTIFACTS: Agent Forks | SIMULATED ACTIONS
Ctrl+Q
Sleep 2s

# ---- act 2: the process (clean build-pipeline run) ---------------------------
Type "node src/main.ts --scenario clean --autoplay --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 40"
Enter
Wait+Screen@10s /FAME-XGA READY/
Sleep 3s

Type "1"
Wait+Screen@5s /ENVIRONMENT STATUS/
Sleep 2s

Type "2"
Wait+Screen@5s /DEPENDENCIES: NODE_MODULES CACHE/
Wait+Screen@5s /STATE: RESTORING/
Wait+Screen@5s /STATE: HIT/
Sleep 2s

Type "3"
Wait+Screen@5s /INCREMENTAL BUILD/
Wait+Screen@5s /BUILD: REBUILDING/
Sleep 2s

Type "4"
Wait+Screen@5s /BAYESIAN BISECT/
Wait+Screen@30s /BISECT: CONVERGED/
Sleep 3s

Type "5"
Wait+Screen@5s /COORDINATION: LEASE/
Wait+Screen@5s /HEARTBEAT: ALL AGENTS FRESH/
Sleep 2s

Type "6"
Wait+Screen@5s /EVENT STREAM: CLEAN RUN/
Wait+Screen@5s /awaiting approval/
Sleep 2s

Type "4"
Wait+Screen@5s /APPROVAL GATE: press a/
Type "a"
Wait+Screen@5s /REVIEW APPROVED/
Type "n"
Wait+Screen@5s /GIT NOTE WRITTEN/
Sleep 2s

Type "6"
Wait+Screen@5s /clean run complete/
# expect: clean run complete | SIMULATED ACTIONS | refs/notes/bisect
Sleep 2s

Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/

# ---- act 3: back to the dashboard: the whole run, then the end state ---------
Type "node src/main.ts --overview --autoplay --speed 4 --seed 1 --cols 140 --rows 40"
Enter
Sleep 8s
# expect: SIMULATED ACTIONS | R2: LEASE LOCKS
Sleep 12s
Type "}"
Sleep 6s
# expect: Monthly CI Cost Comparison | Per-Run Cost Breakdown | BUILD & AUDIT PROGRESS | R2: LEASE LOCKS | ARTIFACTS: Agent Forks | CLOUDFLARE URIs | SIMULATED ACTIONS | merged | MERGE | MERGED
Type "c"
Sleep 4s
# expect: LEASE TIMELINE | BUILD & AUDIT PROGRESS | CUMULATIVE CI COST | SIMULATED ACTIONS
Type "o"
Sleep 4s
# expect: Monthly CI Cost Comparison | ARTIFACTS: Agent Forks | merged | SIMULATED ACTIONS
Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/
