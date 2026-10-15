#!/usr/bin/env bash
# vhs-demo-mp4.sh: record tui/recordings/demo.mp4 with VHS from tape/demo-mp4.tape:
#   act 1, overview: the cobuild dashboard paused mid-run, as the overview of
#          every panel, then a few seconds on the cost panels, R2 lease locks,
#          Artifacts agent forks, Cloudflare URIs and BUILD & AUDIT PROGRESS;
#   act 2, process: the clean build-pipeline run, ending on its charts panel;
#   act 3, result: the dashboard overview again, played to the end state.
#
#   bash tui/scripts/vhs-demo-mp4.sh                  check, record, verify, save
#   bash tui/scripts/vhs-demo-mp4.sh --strict         stop if the headless preflight fails
#   bash tui/scripts/vhs-demo-mp4.sh --no-retime      keep VHS's timing even if it dropped frames
#   bash tui/scripts/vhs-demo-mp4.sh --tape FILE      record another tape (run from tui/)
#
# The recording does not depend on screen timing:
#   - the tape has no Wait command, so VHS cannot stop on a Wait+Screen timeout;
#     every state that must be on camera is pinned (the dashboard is paused at
#     exact script times with its scrub keys, the clean run follows its own
#     --autoplay script), and scripts/vhs-demo-preflight.ts checks the tape's
#     "# expect:" checkpoints against the TUI's state machines, with and without
#     recorder lag, before recording;
#   - if VHS fails, it is run again at a lower frame rate; a partial MP4 is kept;
#   - VHS writes frames at a fixed rate, so on a loaded machine it drops frames
#     and the MP4 comes out shorter than the session (36 s instead of 50 s, say).
#     That is reported, never fatal, and the video is re-timed with ffmpeg to the
#     tape's length so it plays at real speed (--no-retime keeps VHS's version);
#   - a still of every checkpoint is extracted from the final MP4
#     (recordings/demo-checkpoints/) so you can see the overview, the panels and
#     the charts without scrubbing through the video.
#
# Exit status: 0 when recordings/demo.mp4 was written, 1 when no video could be
# recorded at all, 2 when a prerequisite is missing. The script installs nothing.
set -uo pipefail

STRICT=0
RETIME=1
TAPE_REL="tape/demo-mp4.tape"
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --no-retime) RETIME=0 ;;
    --tape)
      shift
      TAPE_REL="${1:?--tape needs a file}"
      ;;
    -h | --help)
      sed -n '2,31p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TUI="$ROOT/tui"
OUT="$TUI/recordings"
OS="$(uname -s)"
cd "$TUI" || exit 2

ok() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
note() { printf '  \033[33mNOTE\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
section() { printf '== %s\n' "$1"; }
rel() { printf '%s' "${1#"$ROOT"/}"; }

# ---------------------------------------------------------------------------
section "1. Prerequisites"
MISSING=0
hint() {
  case "$OS:$1" in
    Darwin:vhs) echo "brew install charmbracelet/tap/vhs" ;;
    Darwin:ttyd) echo "brew install ttyd" ;;
    Darwin:ffmpeg) echo "brew install ffmpeg" ;;
    Darwin:node) echo "brew install node@22 (or: nvm install 22)" ;;
    Linux:vhs) echo "see https://github.com/charmbracelet/vhs#installation" ;;
    Linux:ttyd) echo "download a release binary from https://github.com/tsl0922/ttyd/releases" ;;
    Linux:ffmpeg) echo "sudo apt install ffmpeg" ;;
    Linux:node) echo "nvm install 22" ;;
    *) echo "install $1" ;;
  esac
}
need() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 found"
  else
    fail "$1 not on PATH: $(hint "$1")"
    MISSING=1
  fi
}
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  ok "node $(node --version)"
else
  fail "node >= 22.18 is needed to run the TUI: $(hint node)"
  MISSING=1
fi
need ttyd
need ffmpeg
need ffprobe
if command -v vhs >/dev/null 2>&1; then ok "vhs $(vhs --version 2>&1 | head -n 1 | sed 's/^vhs //')"; else
  fail "vhs not on PATH: $(hint vhs)"
  MISSING=1
fi
[ $MISSING -eq 0 ] || exit 2

ok "font: the system's default monospace typeface (tape/common.tape), nothing to install"

# ---------------------------------------------------------------------------
section "2. Preflight: headless replay of $TAPE_REL"
[ -f "$TAPE_REL" ] || {
  fail "$TAPE_REL not found"
  exit 2
}
PRE="node --import ./src/ink/register.ts scripts/vhs-demo-preflight.ts $TAPE_REL"
if pre_out=$($PRE 2>&1); then
  ok "${pre_out#OK }"
else
  printf '%s\n' "$pre_out" | sed 's/^/        /' | head -n 20
  if [ $STRICT -eq 1 ]; then
    fail "the tape would not show what it should (--strict: not recording)"
    exit 1
  fi
  warn "some checkpoints failed in the headless replay; recording anyway (use --strict to stop here)"
fi
EXPECTED=$($PRE --duration 2>/dev/null || echo 0)
TIMELINE=$($PRE --timeline 2>/dev/null || true)

# ---------------------------------------------------------------------------
section "3. Recording tape"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$OUT/.vhs-demo-$STAMP"
mkdir -p "$WORK"
# record.tape = the tape with its Output lines pointed at the work directory.
# The path is written relative to tui/ (where VHS runs) and in double quotes:
# VHS's tape parser reads an unquoted argument that starts with "/" as a
# /regex/ (the Wait syntax), so an absolute path such as
#   Output /Users/me/cf_3/tui/recordings/.vhs-demo-.../demo.mp4
# fails with "Expected file path after output" / "Invalid command: Users".
# Quoting also keeps paths with spaces in one piece.
WORK_REL="recordings/.vhs-demo-$STAMP"
# $1 = frame rate override (empty: keep the tape's).
make_tape() {
  grep -v '^Output ' "$TAPE_REL" | awk -v out="Output \"$WORK_REL/demo.mp4\"" -v fr="$1" '
    { print }
    /^Source / && !done {
      print out
      if (fr != "") print "Set Framerate " fr
      done = 1
    }' >"$WORK/record.tape"
}
make_tape ""
if grep -q '^Wait' "$WORK/record.tape"; then
  warn "$(rel "$WORK/record.tape") contains Wait commands: a Wait+Screen timeout would stop VHS"
fi
# A tape VHS cannot parse fails the same way on every attempt: check it first.
if vhs validate "$WORK/record.tape" >"$WORK/validate.log" 2>&1; then
  ok "$(rel "$WORK/record.tape") -> $(rel "$WORK/demo.mp4") (vhs validate: OK)"
else
  fail "VHS cannot parse $(rel "$WORK/record.tape") (log: $(rel "$WORK/validate.log")):"
  tail -n 10 "$WORK/validate.log" | sed 's/^/        /'
  exit 1
fi

# ---------------------------------------------------------------------------
section "4. Recording with VHS (about ${EXPECTED%.*} s of demo, plus encoding)"
mp4_ok() { [ -s "$WORK/demo.mp4" ] && ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/demo.mp4" >/dev/null 2>&1; }
if vhs "$WORK/record.tape" >"$WORK/vhs.log" 2>&1 && mp4_ok; then
  ok "VHS finished"
else
  warn "VHS failed or wrote no playable MP4 (log: $(rel "$WORK/vhs.log")):"
  tail -n 5 "$WORK/vhs.log" | sed 's/^/        /'
  [ -s "$WORK/demo.mp4" ] && mv "$WORK/demo.mp4" "$WORK/demo.attempt1.mp4"
  note "recording again at 20 frames/s (less load on the recorder)"
  make_tape 20
  if vhs "$WORK/record.tape" >"$WORK/vhs-retry.log" 2>&1 && mp4_ok; then
    ok "VHS finished (second attempt)"
  elif mp4_ok; then
    warn "VHS reported an error on the second attempt but wrote a playable MP4; keeping it (log: $(rel "$WORK/vhs-retry.log"))"
  elif [ -s "$WORK/demo.attempt1.mp4" ]; then
    mv "$WORK/demo.attempt1.mp4" "$WORK/demo.mp4"
    warn "keeping the partial MP4 of the first attempt"
  else
    fail "VHS did not produce a video in two attempts (logs: $(rel "$WORK/vhs.log"), $(rel "$WORK/vhs-retry.log"))"
    tail -n 10 "$WORK/vhs-retry.log" | sed 's/^/        /'
    exit 1
  fi
fi
if grep -qiE 'timeout|error' "$WORK"/vhs*.log 2>/dev/null; then
  note "the VHS log mentions an error or timeout: $(grep -hiE 'timeout|error' "$WORK"/vhs*.log | head -n 1)"
fi

# ---------------------------------------------------------------------------
section "5. Checking and saving the MP4"
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | head -n 1; }
ACTUAL=$(duration "$WORK/demo.mp4")
ACTUAL=${ACTUAL:-0}
FINAL="$WORK/demo.mp4"
SCALE=1
if awk -v a="$ACTUAL" -v e="$EXPECTED" 'BEGIN { exit !(e > 0 && a < 0.9 * e) }'; then
  note "the MP4 is $ACTUAL s long, the tape lasts $EXPECTED s: VHS dropped frames because the machine was busy (the content is complete, the video just plays fast)"
  FACTOR=$(awk -v a="$ACTUAL" -v e="$EXPECTED" 'BEGIN { printf "%.4f", e / a }')
  if [ $RETIME -eq 1 ] && awk -v a="$ACTUAL" 'BEGIN { exit !(a > 1) }'; then
    if ffmpeg -nostdin -loglevel error -y -i "$WORK/demo.mp4" -filter:v "setpts=$FACTOR*PTS" -r 30 \
      -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$WORK/demo.retimed.mp4" 2>"$WORK/retime.log" &&
      [ -s "$WORK/demo.retimed.mp4" ]; then
      FINAL="$WORK/demo.retimed.mp4"
      ok "re-timed by x$FACTOR to $(duration "$FINAL") s so it plays at real speed (VHS's version: $(rel "$WORK/demo.mp4"))"
    else
      warn "re-timing failed ($(rel "$WORK/retime.log")); keeping VHS's timing"
      SCALE=$(awk -v a="$ACTUAL" -v e="$EXPECTED" 'BEGIN { printf "%.4f", a / e }')
    fi
  else
    SCALE=$(awk -v a="$ACTUAL" -v e="$EXPECTED" 'BEGIN { printf "%.4f", a / e }')
  fi
else
  ok "the MP4 is $ACTUAL s long (tape: $EXPECTED s)"
fi

mkdir -p "$OUT"
cp "$FINAL" "$OUT/demo.mp4"
ok "saved $(rel "$OUT/demo.mp4") ($(duration "$OUT/demo.mp4") s)"

# A still of every checkpoint, to look at without playing the video.
STILLS="$OUT/demo-checkpoints"
rm -rf "$STILLS"
mkdir -p "$STILLS"
n=0
got=0
LEN=$(duration "$OUT/demo.mp4")
while IFS=$'\t' read -r t line what; do
  [ -n "${t:-}" ] || continue
  n=$((n + 1))
  at=$(awk -v t="$t" -v s="$SCALE" -v l="${LEN:-0}" 'BEGIN { x = t * s; if (l > 0 && x > l - 0.2) x = l - 0.2; if (x < 0) x = 0; printf "%.2f", x }')
  png=$(printf '%s/%02d-line%s.png' "$STILLS" "$n" "$line")
  if ffmpeg -nostdin -loglevel error -y -ss "$at" -i "$OUT/demo.mp4" -frames:v 1 "$png" 2>/dev/null && [ -s "$png" ]; then
    got=$((got + 1))
    printf '%s\t%s s\t%s\n' "$(basename "$png")" "$at" "$what" >>"$STILLS/index.txt"
  fi
done <<<"$TIMELINE"
if [ $got -gt 0 ]; then
  ok "$got of $n checkpoint stills in $(rel "$STILLS")/ (index.txt lists what each one must show)"
else
  warn "no checkpoint stills could be extracted"
fi
exit 0
