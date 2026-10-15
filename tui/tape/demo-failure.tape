# The failure scenario (the default script of the TUI): an agent crashes,
# its lease expires, another agent takes over with If-Match, and the PR is
# approved automatically. Recorded in addition to the clean run.
Source "tape/common.tape"

Output recordings/demo-failure.mp4
Output recordings/demo-failure.gif

Hide
Type "source tape/setup.sh"
Enter
Wait+Screen@10s /SETUP COMPLETE/
Show

Type "node src/main.ts --autoplay --seed 1 --cols 140 --rows 40"
Enter
Wait+Screen@10s /Agent-Native CI/
Sleep 2s
Type "6"
Wait+Screen@40s /simulated crash/
Wait+Screen@40s /cache HIT on/
Wait+Screen@40s /fast-forward/
Sleep 3s

Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/
