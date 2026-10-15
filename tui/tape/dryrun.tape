# Short dry run (storyboard step 6): header and one transition.
Source "tape/common.tape"

Output recordings/dryrun.gif

Hide
Type "source tape/setup.sh"
Enter
Wait+Screen@10s /SETUP COMPLETE/
Show

Type "node src/main.ts --scenario clean --autoplay --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 40"
Enter
Wait+Screen@10s /FAME-XGA READY/
Sleep 2s
Type "1"
Wait+Screen@5s /ENVIRONMENT STATUS/
Sleep 2s
Ctrl+Q
Sleep 1s
Wait+Screen@5s /\$\s*$/
