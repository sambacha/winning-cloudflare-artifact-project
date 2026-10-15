#!/usr/bin/env bash
# record-demos.sh: record every demo of this repository, one video per segment,
# and optionally join them into one film.
#
#   bash scripts/record-demos.sh                      record all segments (VHS when installed)
#   bash scripts/record-demos.sh --rehearse           run every segment in this terminal, no recording,
#                                                     and check each one behaves as expected
#   bash scripts/record-demos.sh --check-only         prerequisites only
#   bash scripts/record-demos.sh --only cobuild-takeover,bisect
#   bash scripts/record-demos.sh --recorder asciinema # or: vhs | script | auto (default)
#   bash scripts/record-demos.sh --store r2           demo A against real R2 (R2_* must be set)
#   bash scripts/record-demos.sh --concat             also join the videos into recordings/full-demo.mp4 (ffmpeg)
#   bash scripts/record-demos.sh --with-failure       also record the TUI's crash/takeover scenario
#   bash scripts/record-demos.sh --tapes-only         only write the VHS tapes (recordings/<segment>.tape) to inspect or edit
#
# Segments, in film order (see docs/project-status-and-demo-guide.md §3.5):
#   proof             the Lean axiom audit: "1798 theorems ... 0 violations" (lake build, replayed)
#   cobuild-clean     demo A: three legs share a 7-operation plan; status; rerun = all cache hits
#   cobuild-takeover  demo A: Ctrl-C on one leg mid-build; another leg takes its work over
#   cobuild-failure   demo A: one package fails; the failure is shared, not rebuilt three times
#   bisect            demo B: Bayesian bisection with a flaky test, then a crash-safe replay
#   tui               demo C: the scripted dashboard (delegates to tui/scripts/record-demo.sh)
#
# Recorders:
#   vhs        mp4 + gif + txt transcript per segment (needs vhs, ttyd, ffmpeg; uses the system's default monospace font)
#   asciinema  .cast per segment (+ gif when `agg` is installed); the tui segment needs VHS and is skipped
#   script     plain terminal log per segment (always available; no video)
#
# Outputs go to recordings/ (git-ignored). Each segment's transcript is checked
# for the line that proves it did what it shows; a segment that did not is
# reported as FAIL (its video is kept so you can see why).
#
# Captions shown in the recordings follow the honesty rules of the guide: demo A
# says "local directory store with R2 write rules" unless --store r2 is used,
# and the TUI is labelled as scripted, illustrative data.
#
# Exit status: 0 if every selected segment passed, 1 if one failed, 2 if a
# prerequisite is missing.
set -uo pipefail

ALL="proof cobuild-clean cobuild-takeover cobuild-failure bisect tui"
ONLY=""
RECORDER=auto
STORE=fs
REHEARSE=0
CHECK_ONLY=0
CONCAT=0
WITH_FAILURE=0
TAPES_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2//,/ }"; shift 2 ;;
    --recorder) RECORDER="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --rehearse) REHEARSE=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --concat) CONCAT=1; shift ;;
    --with-failure) WITH_FAILURE=1; shift ;;
    --tapes-only) TAPES_ONLY=1; RECORDER=vhs; shift ;;
    -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
SEGMENTS="${ONLY:-$ALL}"
for s in $SEGMENTS; do case " $ALL " in *" $s "*) ;; *) echo "unknown segment: $s (one of: $ALL)" >&2; exit 2 ;; esac; done
case "$STORE" in fs | r2) ;; *) echo "--store must be fs or r2" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/recordings"
OS="$(uname -s)"
FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
note() { printf '  ....  %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }
has() { command -v "$1" >/dev/null 2>&1; }
selected() { case " $SEGMENTS " in *" $1 "*) return 0 ;; esac; return 1; }

# ---------------------------------------------------------------------------
section "1. Prerequisites (nothing is installed by this script)"
MISSING=0
if has node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  pass "node $(node --version)"
else
  fail "node >= 22.18 is required"; MISSING=1
fi
has git && pass "git" || { fail "git missing"; MISSING=1; }
if [ -d "$ROOT/ts/node_modules" ]; then pass "ts/node_modules present"; else
  fail "ts/node_modules missing: run (cd ts && npm ci)"; MISSING=1
fi
if selected proof; then
  if has lake; then pass "lake $(lake --version 2>/dev/null | head -n 1 | cut -c1-60)"; else
    fail "lake missing (needed for the proof segment): curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"; MISSING=1
  fi
fi
if [ "$STORE" = r2 ]; then
  if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_BUCKET:-}" ] && { [ -n "${R2_ACCOUNT_ID:-}" ] || [ -n "${R2_ENDPOINT:-}" ]; }; then
    pass "R2 credentials set (bucket $R2_BUCKET)"
  else
    fail "--store r2 needs R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"; MISSING=1
  fi
fi

if [ $REHEARSE -eq 0 ] && [ $TAPES_ONLY -eq 0 ]; then
  if [ "$RECORDER" = auto ]; then
    if has vhs && has ttyd && has ffmpeg; then RECORDER=vhs
    elif has asciinema; then RECORDER=asciinema
    else RECORDER=script; fi
  fi
  case "$RECORDER" in
    vhs)
      for t in vhs ttyd ffmpeg; do has $t && pass "$t" || { fail "$t missing"; MISSING=1; }; done
      if ! has vhs || ! has ttyd || ! has ffmpeg; then
        if [ "$OS" = Darwin ]; then note "install: brew install charmbracelet/tap/vhs ttyd ffmpeg"
        else note "install: vhs (https://github.com/charmbracelet/vhs#installation), ttyd release binary into ~/.local/bin, sudo apt install ffmpeg"; fi
      fi
      ;;
    asciinema) has asciinema && pass "asciinema $(asciinema --version 2>&1 | head -n 1)" || { fail "asciinema missing (pip install asciinema / brew install asciinema)"; MISSING=1; }
      has agg && pass "agg (gif conversion)" || note "agg not installed: .cast files only (https://github.com/asciinema/agg)" ;;
    script) has script && pass "script(1): terminal logs only, no video" || { fail "script(1) missing"; MISSING=1; } ;;
    *) fail "unknown recorder: $RECORDER"; MISSING=1 ;;
  esac
  note "recorder: $RECORDER"
fi
# The system's default monospace typeface: nothing to install.
FONT="monospace"
if [ $CONCAT -eq 1 ] && ! has ffmpeg; then fail "--concat needs ffmpeg"; MISSING=1; fi

if [ $CHECK_ONLY -eq 1 ]; then section "Done (check only)"; exit $([ $MISSING -eq 0 ] && echo 0 || echo 2); fi
[ $MISSING -eq 0 ] || { printf '\nInstall the missing prerequisites, then run this script again.\n'; exit 2; }

# ---------------------------------------------------------------------------
section "2. Preparation (not recorded)"
mkdir -p "$OUT"
grep -qxF '/recordings/' "$ROOT/.gitignore" 2>/dev/null || echo '/recordings/' >>"$ROOT/.gitignore"
export GIT_TERMINAL_PROMPT=0
if [ "$OS" = Darwin ]; then export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES; fi
(cd "$ROOT/ts" && node scripts/ensure-exec.mjs >/dev/null 2>&1; node node_modules/typescript/bin/tsc -p tsconfig.build.json >"$OUT/prepare-build.log" 2>&1) &&
  pass "ts/dist built" || { fail "npm run build failed (recordings/prepare-build.log)"; exit 1; }
if selected proof && [ $TAPES_ONLY -eq 0 ]; then
  note "lake build (first time: long; afterwards the audit log is replayed in seconds)"
  if (cd "$ROOT" && lake build >"$OUT/prepare-lake.log" 2>&1); then pass "lake build"; else fail "lake build failed (recordings/prepare-lake.log)"; SEGMENTS="${SEGMENTS/proof/}"; fi
fi
if pgrep -f "vitest|lake build" >/dev/null 2>&1; then note "a vitest run or Lean build is still running: timing-sensitive output may look slow on camera"; fi

STORE_ARG=""
STORE_CAPTION="local directory store with R2 write rules (not Cloudflare)"
if [ "$STORE" = r2 ]; then STORE_ARG=" --store r2"; STORE_CAPTION="real Cloudflare R2 bucket ${R2_BUCKET:-}"; fi
BISECT_STATE="${TMPDIR:-/tmp}/bisect-demo-recording"

# Per segment: caption, the command typed on camera (run from the repo root),
# a transcript pattern that proves the segment did what it shows, and a wait budget.
seg_caption() {
  case "$1" in
    proof) echo "# Lean 4: machine-checked proofs about the cobuild protocol on a model of R2" ;;
    cobuild-clean) echo "# Demo A: three CI legs cooperate on one build ($STORE_CAPTION)" ;;
    cobuild-takeover) echo "# Demo A: Ctrl-C on one leg; its lock is released and another leg takes over" ;;
    cobuild-failure) echo "# Demo A: a failing package fails once; the other legs reuse the failure" ;;
    bisect) echo "# Demo B: Bayesian bisection with a flaky test; then the same run replayed after a crash" ;;
  esac
}
seg_command() {
  case "$1" in
    proof) echo "lake build RequestProject.Cobuilds.Tests.Audit 2>&1 | grep -E 'axiom audit|Build completed'" ;;
    cobuild-clean) echo "bash scripts/demo-cobuild.sh --scenario clean$STORE_ARG" ;;
    cobuild-takeover) echo "bash scripts/demo-cobuild.sh --scenario takeover$STORE_ARG" ;;
    cobuild-failure) echo "bash scripts/demo-cobuild.sh --scenario failure$STORE_ARG" ;;
    bisect) echo "rm -rf $BISECT_STATE; node ts/dist/demo/bisectDemoBin.js --state $BISECT_STATE --seed demo | cut -c1-130; node ts/dist/demo/bisectDemoBin.js --state $BISECT_STATE --seed demo | tail -n 1" ;;
  esac
}
seg_expect() {
  case "$1" in
    proof) echo "axiom audit: [0-9]+ theorems .* 0 violations" ;;
    cobuild-clean) echo "every operation was built by exactly one leg" ;;
    cobuild-takeover) printf '%s\n' "Ctrl-C on extra1" "restored from the cache: a b c d e f" ;;
    cobuild-failure) echo "failure was shared" ;;
    bisect) printf '%s\n' "\"culprit\"" "\"ran\":0,\"replayed\":[1-9]" ;;
  esac
}
seg_budget() { case "$1" in proof) echo 600 ;; bisect) echo 300 ;; *) echo 180 ;; esac; }

check_transcript() {
  # $1 segment, $2 transcript file; every pattern of seg_expect must occur
  local pat ok=1 clean
  [ -f "$2" ] || { fail "$1: no transcript ($(basename "$2"))"; return; }
  clean="$(sed "s/$(printf '\033')\[[0-9;?]*[A-Za-z]//g" "$2" | tr -d '\r')"
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    if ! printf '%s\n' "$clean" | grep -qE -- "$pat"; then fail "$1: expected /$pat/ in $(basename "$2")"; ok=0; fi
  done <<<"$(seg_expect "$1")"
  [ $ok -eq 1 ] && pass "$1: transcript shows $(seg_expect "$1" | sed 's|.*|/&/|' | tr '\n' ' ')"
}

vhs_tape() {
  # $1 segment -> writes $OUT/$1.tape
  local seg="$1" budget; budget="$(seg_budget "$seg")"
  {
    echo "Output \"$OUT/$seg.mp4\""
    echo "Output \"$OUT/$seg.gif\""
    echo "Output \"$OUT/$seg.txt\""
    echo 'Set Shell "bash"'
    [ -n "$FONT" ] && echo "Set FontFamily \"$FONT\""
    echo "Set FontSize 15"
    echo "Set Width 1440"
    echo "Set Height 900"
    echo "Set Padding 20"
    echo "Set Framerate 30"
    echo "Set TypingSpeed 25ms"
    echo "Set WaitTimeout ${budget}s"
    echo 'Set WaitPattern /\$ $/'
    echo "Hide"
    printf 'Type `cd %q && export PS1="$ " PROMPT_COMMAND= && clear`\n' "$ROOT"
    echo "Enter"
    echo "Sleep 500ms"
    echo "Show"
    printf 'Type `%s`\n' "$(seg_caption "$seg")"
    echo "Enter"
    echo "Sleep 1s"
    printf 'Type `%s`\n' "$(seg_command "$seg")"
    echo "Sleep 500ms"
    echo "Enter"
    echo "Wait@${budget}s"
    echo "Sleep 4s"
  } >"$OUT/$seg.tape"
}

record_segment() {
  local seg="$1" cmd caption
  cmd="$(seg_command "$seg")"
  caption="$(seg_caption "$seg")"
  if [ $REHEARSE -eq 1 ]; then
    printf '\n%s\n$ %s\n' "$caption" "$cmd"
    (cd "$ROOT" && bash -c "$cmd") 2>&1 | tee "$OUT/$seg.rehearsal.txt"
    check_transcript "$seg" "$OUT/$seg.rehearsal.txt"
    return
  fi
  case "$RECORDER" in
    vhs)
      vhs_tape "$seg"
      if vhs validate "$OUT/$seg.tape" >"$OUT/$seg.vhs.log" 2>&1 && (cd "$ROOT" && vhs "$OUT/$seg.tape" >>"$OUT/$seg.vhs.log" 2>&1); then
        note "recordings/$seg.mp4, $seg.gif"
        check_transcript "$seg" "$OUT/$seg.txt"
      else
        fail "$seg: vhs failed (recordings/$seg.vhs.log)"
      fi
      ;;
    asciinema)
      if (cd "$ROOT" && asciinema rec --overwrite -q -c "bash -c $(printf '%q' "clear; echo $(printf '%q' "$caption"); echo $(printf '%q' "\$ $cmd"); $cmd; sleep 3")" "$OUT/$seg.cast" >/dev/null 2>&1); then
        note "recordings/$seg.cast"
        has agg && agg "$OUT/$seg.cast" "$OUT/$seg.gif" >/dev/null 2>&1 && note "recordings/$seg.gif"
        check_transcript "$seg" "$OUT/$seg.cast"
      else
        fail "$seg: asciinema failed"
      fi
      ;;
    script)
      local inner="echo $(printf '%q' "$caption"); echo $(printf '%q' "\$ $cmd"); $cmd"
      if script --version 2>/dev/null | grep -q util-linux; then
        (cd "$ROOT" && script -q -e -c "bash -c $(printf '%q' "$inner")" "$OUT/$seg.log" >/dev/null 2>&1)
      else
        (cd "$ROOT" && script -q "$OUT/$seg.log" bash -c "$inner" >/dev/null 2>&1)
      fi
      note "recordings/$seg.log (replay: cat recordings/$seg.log)"
      check_transcript "$seg" "$OUT/$seg.log"
      ;;
  esac
}

if [ $TAPES_ONLY -eq 1 ]; then
  section "3. VHS tapes (not recorded)"
  for seg in $SEGMENTS; do
    [ "$seg" = tui ] && { note "tui: tapes are in tui/tape/"; continue; }
    vhs_tape "$seg" && pass "recordings/$seg.tape"
  done
  note "record one with: (cd $ROOT && vhs recordings/<segment>.tape)"
  exit $FAILED
fi

# ---------------------------------------------------------------------------
section "3. Segments ($([ $REHEARSE -eq 1 ] && echo "rehearsal, not recorded" || echo "recorder: $RECORDER"))"
for seg in $SEGMENTS; do
  printf '\n-- %s\n' "$seg"
  if [ "$seg" = tui ]; then
    if [ $REHEARSE -eq 1 ]; then
      (cd "$ROOT/tui" && node src/main.ts --scenario clean --autoplay --no-color --fixed-time 2026-10-14T12:00:00Z >"$OUT/tui.rehearsal.txt" 2>&1) &&
        grep -q "ILLUSTRATIVE DATA" "$OUT/tui.rehearsal.txt" && pass "tui: headless autoplay ran (labelled ILLUSTRATIVE DATA)" || fail "tui: headless autoplay failed (recordings/tui.rehearsal.txt)"
    elif [ "$RECORDER" != vhs ]; then
      skip "tui: its tapes need VHS (recorder is $RECORDER)"
    else
      flags=(--skip-tests)
      [ $WITH_FAILURE -eq 1 ] && flags+=(--with-failure)
      if bash "$ROOT/tui/scripts/record-demo.sh" "${flags[@]}" >"$OUT/tui.log" 2>&1; then
        cp "$ROOT/tui/recordings/demo.mp4" "$OUT/tui.mp4" 2>/dev/null
        cp "$ROOT/tui/recordings/demo.gif" "$OUT/tui.gif" 2>/dev/null
        [ $WITH_FAILURE -eq 1 ] && cp "$ROOT/tui/recordings/demo-failure.mp4" "$OUT/tui-failure.mp4" 2>/dev/null
        pass "tui: recorded, two takes identical (recordings/tui.mp4; stills in tui/recordings/stills/)"
        note "caption it: scripted walkthrough, illustrative data"
      else
        fail "tui: tui/scripts/record-demo.sh failed (recordings/tui.log)"
      fi
    fi
    continue
  fi
  record_segment "$seg"
done

# ---------------------------------------------------------------------------
if [ $CONCAT -eq 1 ] && [ $REHEARSE -eq 0 ]; then
  section "4. Join the segments (ffmpeg)"
  list="$OUT/concat.txt"
  : >"$list"
  for seg in $SEGMENTS; do [ -f "$OUT/$seg.mp4" ] && printf "file '%s'\n" "$OUT/$seg.mp4" >>"$list"; done
  if [ -s "$list" ] && ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -vf "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2,fps=30" \
    -c:v libx264 -pix_fmt yuv420p "$OUT/full-demo.mp4"; then
    pass "recordings/full-demo.mp4 ($(grep -c . "$list") segments)"
  else
    fail "ffmpeg could not join the segments (no mp4 files, or an encoding error)"
  fi
fi

section "Done"
if [ $FAILED -eq 0 ]; then echo "All selected segments passed. Output: recordings/"; else echo "Some segments failed (see above)."; fi
echo "Captions: do not say it runs on Cloudflare unless --store r2 was used; the Lean proofs are about a model of R2; the TypeScript is tested, not formally verified."
exit $FAILED
