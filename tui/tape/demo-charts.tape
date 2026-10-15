# The charts view: the failure run played with the charts open (lease
# timeline, cumulative cost, progress, activity, monthly cost, audit
# algorithms), one chart zoomed, the time cursor scrubbed back over the
# crash, then the clean run's charts panel. Run from tui/:  vhs tape/demo-charts.tape
# Every Wait+Screen pattern is a title the charts draw (src/charts/layout.ts).
Source "tape/common.tape"

Output recordings/demo-charts.mp4
Output recordings/demo-charts.gif

Hide
Type "source tape/setup.sh"
Enter
Wait+Screen@10s /SETUP COMPLETE/
Show

Type "node src/main.ts --autoplay --charts --seed 1 --cols 140 --rows 40"
Enter
Wait+Screen@10s /LEASE TIMELINE/
Wait+Screen@10s /CUMULATIVE CI COST/
Sleep 30s
Type "1"
Sleep 1s
Type "z"
Wait+Screen@5s /zoomed/
Sleep 4s
Type "{"
Sleep 1s
Type "{"
Sleep 1s
Type "{"
Sleep 2s
Type "]"
Sleep 1s
Type "]"
Sleep 2s
Type "z"
Sleep 1s
Type "2"
Type "z"
Sleep 3s
Type "z"
Type "p"
Sleep 8s
Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/

Type "node src/main.ts --scenario clean --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 40"
Enter
Sleep 2s
Type "4"
Sleep 6s
Type "c"
Wait+Screen@5s /BISECT PROBES/
Sleep 5s
Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/
