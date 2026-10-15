# Golden stills (I5): each one is a --snapshot frame at a fixed script time
# (with --fixed-time for the clean run), so two runs of this tape give the
# same screens. Run from tui/: vhs tape/stills.tape
#
# The setup is hidden; everything after it is shown. VHS takes a Screenshot
# from the frames it captures, and it captures frames only while the tape is
# shown: a tape that stays hidden to the end records no frame at all, writes
# no PNG and fails with "no frames" / "recording failed".
Source "tape/common.tape"

# VHS always renders a video of the shown part; name it, so it does not land
# in the working directory as out.gif. The stills are the PNGs.
Output recordings/stills.gif

Hide
Type "source tape/setup.sh"
Enter
Wait+Screen@10s /SETUP COMPLETE/
Show

# ---- the dashboard: overview, panels, URIs, charts --------------------------
Type "clear; node src/main.ts --snapshot 23 --overview --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-overview.png

Type "clear; node src/main.ts --snapshot 23 --focus 5 --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-cost.png

Type "clear; node src/main.ts --snapshot 23 --focus 2 --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-locks.png

Type "clear; node src/main.ts --snapshot 23 --focus 1 --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-forks.png

Type "clear; node src/main.ts --snapshot 23 --focus 7 --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-uris.png

Type "clear; node src/main.ts --snapshot 23 --charts --chart 3 --zoom --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/00-dashboard-progress.png

# ---- the clean build-pipeline run --------------------------------------------
Type "clear; node src/main.ts --scenario clean --snapshot 4 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/01-start.png

Type "clear; node src/main.ts --scenario clean --snapshot 10 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/02-environment.png

Type "clear; node src/main.ts --scenario clean --snapshot 14 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/03-dependencies.png

Type "clear; node src/main.ts --scenario clean --snapshot 16.5 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/04-build.png

Type "clear; node src/main.ts --scenario clean --snapshot 24 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/04-bisect.png

Type "clear; node src/main.ts --scenario clean --snapshot 29 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/05-coordination.png

Type "clear; node src/main.ts --scenario clean --snapshot 33 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/06-events.png

Type "clear; node src/main.ts --scenario clean --snapshot 40 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/07-note.png

Type "clear; node src/main.ts --scenario clean --snapshot 43 --fixed-time 2026-10-14T12:00:00Z --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/08-complete.png

# ---- the dashboard at the end of the run (approved, merged) -----------------
Type "clear; node src/main.ts --snapshot 60 --approve 56 --overview --seed 1 --cols 140 --rows 38"
Enter
Wait
Screenshot recordings/stills/09-dashboard-final.png
