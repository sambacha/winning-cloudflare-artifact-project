# The MP4 demo recorded by scripts/vhs-demo-mp4.sh. Run from tui/:
#   bash scripts/vhs-demo-mp4.sh        (checks, records, verifies)
#   vhs tape/demo-mp4.tape              (records only)
#
# The same three acts as tape/demo.tape:
#   1. Overview: the cobuild dashboard paused at t = 23 s, first as the
#      overview (every panel as a tile), then a few seconds on each of
#      Monthly CI Cost Comparison / Per-Run Cost Breakdown, R2: LEASE LOCKS,
#      ARTIFACTS: Agent Forks, CLOUDFLARE URIs and the charts with
#      BUILD & AUDIT PROGRESS zoomed.
#   2. Process: the clean build-pipeline run (its own --autoplay script),
#      ending on its charts panel.
#   3. Result: back to the dashboard overview, the whole run at 4x, paused on
#      the end state so every panel shows the difference from act 1.
# The SIMULATED ACTIONS strip is on screen in every scene.
#
# Why this tape cannot time out: it has no Wait command at all. Every state
# that must be on camera is pinned before the Sleep that shows it (the
# dashboard is paused at exact script times with its scrub keys: "}" = +5 s,
# "]" = +1 s; the clean run follows its own --autoplay script). The
# "# expect:" comments are checked by scripts/vhs-demo-preflight.ts, which
# replays this tape against the TUI's state machines (with and without
# recorder lag) before anything is recorded. VHS ignores them.
Source "tape/common.tape"

Output recordings/demo.mp4

Hide
Type "source tape/setup.sh"
Enter
Sleep 3s
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
Sleep 10s
# expect: FAME-XGA READY | cobuilds: TypeScript build pipeline | SIMULATED ACTIONS
Sleep 12s
# expect: BAYESIAN BISECT | SIMULATED ACTIONS
Sleep 24s
# expect: clean run complete | SIMULATED ACTIONS
Type "7"
Sleep 6s
# expect: BISECT CONFIDENCE | BISECT PROBES | CACHE EFFECT | COST PER RUN
Ctrl+Q
Sleep 2s

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
