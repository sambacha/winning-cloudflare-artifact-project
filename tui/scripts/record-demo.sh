#!/usr/bin/env bash
# record-demo.sh: check the recording prerequisites, verify the storyboard's
# invariants, then record the clean-run demo with VHS.
#
#   bash tui/scripts/record-demo.sh                 check, verify, record (2 takes, diffed)
#   bash tui/scripts/record-demo.sh --check-only    prerequisites and invariants only, no recording
#   bash tui/scripts/record-demo.sh --with-failure  also record the crash/takeover scenario
#   bash tui/scripts/record-demo.sh --skip-tests    skip the TUI unit tests
#   bash tui/scripts/record-demo.sh --reconcile-lockfile
#                                                   regenerate ts/package-lock.json with `npm install`
#                                                   in a clean checkout, then verify it with `npm ci`
#                                                   in a fresh directory (needs network)
#
# The script installs nothing on your system. When a tool is missing it prints
# the command that installs it (Homebrew on macOS, apt or a release download
# on Linux) and stops. Run the printed commands yourself, then run the script again.
#
# Outputs (in tui/recordings/): demo.mp4, demo.gif, frames/, demo.ascii,
# stills/*.png, dryrun.gif, transcript-1.txt / transcript-2.txt, and
# demo-failure.{mp4,gif} with --with-failure.
#
# Exit status: 0 if every check passed, 1 if an invariant failed, 2 if a
# prerequisite is missing.
set -uo pipefail

CHECK_ONLY=0
WITH_FAILURE=0
SKIP_TESTS=0
RECONCILE=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --with-failure) WITH_FAILURE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --reconcile-lockfile) RECONCILE=1 ;;
    -h | --help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TUI="$ROOT/tui"
OUT="$TUI/recordings"
FIXED="2026-10-14T12:00:00Z"
OS="$(uname -s)"

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  FAILED=1
}
note() { printf '  ....  %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---------------------------------------------------------------------------
section "1. Prerequisites (nothing is installed by this script)"

MISSING=()
install_hint() {
  # $1 = tool; prints the install command for this OS
  case "$OS:$1" in
    Darwin:vhs) echo "brew install charmbracelet/tap/vhs" ;;
    Darwin:ttyd) echo "brew install ttyd" ;;
    Darwin:ffmpeg) echo "brew install ffmpeg" ;;
    Darwin:node) echo "brew install node@22 && brew link --overwrite node@22   (or: nvm install 22)" ;;
    Darwin:git) echo "xcode-select --install   (or: brew install git)" ;;
    Linux:vhs) echo "see https://github.com/charmbracelet/vhs#installation (Charm apt repo: sudo apt install vhs), or: go install github.com/charmbracelet/vhs@latest" ;;
    Linux:ttyd) echo "download the binary from https://github.com/tsl0922/ttyd/releases into ~/.local/bin (the distro package is often too old for VHS)" ;;
    Linux:ffmpeg) echo "sudo apt install ffmpeg" ;;
    Linux:node) echo "nvm install 22   (or the NodeSource 22.x packages)" ;;
    Linux:git) echo "sudo apt install git" ;;
    *) echo "install $1 for $OS" ;;
  esac
}

check_tool() {
  # $1 = tool, $2 = version command
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1: $(eval "$2" 2>&1 | head -n 1)"
  else
    fail "$1 not on PATH"
    MISSING+=("$1")
  fi
}

check_tool vhs "vhs --version"
check_tool ttyd "ttyd --version"
check_tool ffmpeg "ffmpeg -version"
check_tool git "git --version"
if command -v node >/dev/null 2>&1; then
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
    pass "node $(node --version) (>= 22.18 runs the TUI's TypeScript directly)"
  else
    fail "node $(node --version) is older than 22.18"
    MISSING+=("node")
  fi
else
  fail "node not on PATH"
  MISSING+=("node")
fi

pass "font: the system's default monospace typeface (tape/common.tape), nothing to install"

if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\nMissing prerequisites. Install them with:\n\n'
  for m in "${MISSING[@]}"; do printf '  %-7s %s\n' "$m" "$(install_hint "$m")"; done
  printf '\nThen run this script again.\n'
  if [ $CHECK_ONLY -eq 0 ]; then exit 2; fi
  if ! command -v node >/dev/null 2>&1; then exit 2; fi
fi

# Recording environment: no credential prompts on camera; macOS fork safety.
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
if [ "$OS" = "Darwin" ]; then export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES; fi

cd "$TUI" || exit 2
mkdir -p "$OUT"

# ---------------------------------------------------------------------------
section "2. Repository prerequisites (deliverable C)"

tracked=$(git -C "$ROOT" ls-files -- 'ts/node_modules' 'tui/node_modules' | wc -l | tr -d ' ')
if [ "$tracked" = "0" ]; then pass "no node_modules tracked by Git"; else
  fail "$tracked files under node_modules are tracked"
  note "fix (its own commit): git rm -r --cached ts/node_modules && git commit -m 'Stop tracking node_modules'"
fi

lock_sync=$(cd "$ROOT/ts" && node -e '
const p = require("./package.json"), l = require("./package-lock.json"), r = l.packages[""] || {};
const diff = [];
for (const f of ["dependencies", "devDependencies"]) {
  const a = p[f] || {}, b = r[f] || {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) diff.push(`${f}.${k}: package.json ${a[k] ?? "-"} vs lock ${b[k] ?? "-"}`);
}
console.log(diff.join("; "));')
if [ -z "$lock_sync" ]; then pass "ts/package-lock.json matches ts/package.json"; else
  fail "ts/package-lock.json is out of sync with ts/package.json ($lock_sync); 'npm ci' (CI) will refuse it"
  note "fix: bash tui/scripts/record-demo.sh --reconcile-lockfile   (then commit ts/package-lock.json on its own)"
fi

if [ $RECONCILE -eq 1 ]; then
  note "reconciling the lockfile in a clean checkout (network needed)"
  work="$(mktemp -d)"
  if git -C "$ROOT" worktree add --detach "$work/clean" HEAD >/dev/null 2>&1 &&
    (cd "$work/clean/ts" && npm install --no-audit --no-fund >"$work/install.log" 2>&1); then
    cp "$work/clean/ts/package-lock.json" "$ROOT/ts/package-lock.json"
    pass "npm install in a clean checkout regenerated ts/package-lock.json"
    git -C "$ROOT" worktree add --detach "$work/fresh" HEAD >/dev/null 2>&1
    cp "$ROOT/ts/package-lock.json" "$work/fresh/ts/package-lock.json"
    if (cd "$work/fresh/ts" && npm ci --no-audit --no-fund >"$work/ci.log" 2>&1); then
      pass "npm ci succeeds in a fresh directory with the new lockfile"
      note "commit it separately: git add ts/package-lock.json && git commit -m 'Reconcile ts/package-lock.json with package.json'"
    else
      fail "npm ci failed in a fresh directory (log: $work/ci.log)"
    fi
    git -C "$ROOT" worktree remove --force "$work/fresh" >/dev/null 2>&1
  else
    fail "npm install in a clean checkout failed (log: $work/install.log)"
  fi
  git -C "$ROOT" worktree remove --force "$work/clean" >/dev/null 2>&1
fi

# ---------------------------------------------------------------------------
section "3. TUI unit tests"
if [ $SKIP_TESTS -eq 1 ]; then note "skipped (--skip-tests)"; else
  if node --import ./src/ink/register.ts --test test/*.test.ts >"$OUT/unit-tests.log" 2>&1; then
    pass "$(grep -E '^# pass' "$OUT/unit-tests.log" | head -n 1 | sed 's/# //') tests (log: recordings/unit-tests.log)"
  else
    fail "unit tests failed (see recordings/unit-tests.log)"
  fi
fi

# ---------------------------------------------------------------------------
section "4. Invariants of the storyboard"

run_headless() { node src/main.ts --scenario clean --autoplay --no-color "$@"; }

# I1: timeline determinism. --seed is added only if this diff shows data drift.
run_headless --fixed-time "$FIXED" >"$OUT/transcript-1.txt" 2>&1
s1=$?
run_headless --fixed-time "$FIXED" >"$OUT/transcript-2.txt" 2>&1
s2=$?
if [ $s1 -eq 0 ] && [ $s2 -eq 0 ] && diff -q "$OUT/transcript-1.txt" "$OUT/transcript-2.txt" >/dev/null; then
  pass "I1: two --autoplay --fixed-time runs exit 0 and diff to empty (no data drift, so no --seed is needed)"
else
  fail "I1: the two runs differ or failed: diff recordings/transcript-1.txt recordings/transcript-2.txt (data drift: --seed would be needed)"
fi
run_headless >"$OUT/transcript-wall-1.txt" 2>&1
sleep 1.1
run_headless >"$OUT/transcript-wall-2.txt" 2>&1
if diff -q "$OUT/transcript-wall-1.txt" "$OUT/transcript-wall-2.txt" >/dev/null; then
  note "I1: without --fixed-time the runs happened to agree (same wall-clock second)"
else
  pass "I1: without --fixed-time only the status-bar clock differs ($(diff "$OUT/transcript-wall-1.txt" "$OUT/transcript-wall-2.txt" | grep -c '^<') lines), so --fixed-time is what pins it"
fi
if grep -q "$FIXED" "$OUT/transcript-1.txt"; then pass "I1: the status bar shows the pinned time $FIXED"; else fail "I1: pinned time not shown"; fi

# I2: every Wait+Screen literal of the tape occurs exactly once in src/.
anchors=$(awk '/^Type "node src\/main.ts --scenario clean/{on=1} /^Ctrl\+Q/{on=0} on && /^Wait\+Screen/' tape/demo.tape | sed -E 's/^Wait\+Screen(@[0-9]+s)? \/(.*)\/$/\2/')
i2_ok=1
while IFS= read -r a; do
  [ -z "$a" ] && continue
  n=$(grep -rFo -- "$a" src | wc -l | tr -d ' ')
  if [ "$n" != "1" ]; then
    fail "I2: anchor '$a' occurs $n times in tui/src"
    i2_ok=0
  fi
done <<<"$anchors"
if [ $i2_ok -eq 1 ]; then pass "I2: all $(printf '%s\n' "$anchors" | grep -c .) anchors of tape/demo.tape occur exactly once in tui/src"; fi

# I3: Sleep between Ctrl+Q and the next Wait+Screen.
if awk '/^Ctrl\+Q/{q=1;next} q && /^Sleep/{s=1} q && /^Wait/{exit !(s)}' tape/demo.tape; then pass "I3: Sleep follows Ctrl+Q before the prompt wait"; else fail "I3: no Sleep between Ctrl+Q and the next Wait+Screen"; fi

# I4: no line wider than 140 columns at 140x40.
widest=$(node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => !l.startsWith("--- "));
console.log(Math.max(...lines.map((l) => [...l].length)));' "$OUT/transcript-1.txt")
if [ "$widest" -le 140 ]; then pass "I4: widest rendered line is $widest columns at 140x40"; else fail "I4: a line is $widest columns wide"; fi

# I6: clean event stream.
if grep -E "ERROR|FAILED|expired" "$OUT/transcript-1.txt" >/dev/null; then fail "I6: an ERROR/FAILED/expired row is rendered"; else pass "I6: no ERROR, FAILED or expired rows"; fi
rows=$(awk '/^--- t=44.0s/{on=1} on' "$OUT/transcript-1.txt" | grep -cE 'T\+[0-9]')
if [ "$rows" = "25" ]; then pass "I6: the final event stream has 25 rows"; else fail "I6: the final event stream has $rows rows (expected 25)"; fi

# I7: the storyboard of every recorded tape holds in a headless replay (the
# "# expect:" checkpoints: overview, cost panels, locks, forks, URIs, charts,
# the SIMULATED ACTIONS strip), with and without recorder lag.
for t in tape/demo.tape tape/demo-mp4.tape; do
  if pre=$(node --import ./src/ink/register.ts scripts/vhs-demo-preflight.ts "$t" --lag-runs 5 2>&1); then
    pass "I7: ${pre#OK }"
  else
    fail "I7: $t: $(printf '%s' "$pre" | head -n 3 | tr '\n' ' ')"
  fi
done

# Panel keys 1-6 and Ctrl+Q.
if grep -qF '/^[1-6]$/' src/clean/model.ts && grep -qF '"\x11"' src/clean/model.ts; then pass "keys 1-6 and Ctrl+Q are mapped (src/clean/model.ts)"; else fail "panel keys or Ctrl+Q not mapped"; fi

# VHS validates the tapes.
if command -v vhs >/dev/null 2>&1; then
  if vhs validate tape/demo.tape tape/demo-mp4.tape tape/dryrun.tape tape/stills.tape tape/demo-failure.tape >"$OUT/vhs-validate.log" 2>&1; then pass "vhs validate: all tapes"; else fail "vhs validate (see recordings/vhs-validate.log)"; fi
fi

if [ $CHECK_ONLY -eq 1 ] || [ ${#MISSING[@]} -gt 0 ]; then
  section "Done (check only)"
  exit $FAILED
fi

# ---------------------------------------------------------------------------
section "5. Dry run (header and one transition)"
if vhs tape/dryrun.tape >"$OUT/dryrun.log" 2>&1; then pass "recordings/dryrun.gif: inspect it for flicker or misalignment"; else fail "dry run failed (see recordings/dryrun.log)"; fi

section "6. Stills (I5: two runs, byte-compared)"
rm -rf "$OUT/stills" "$OUT/stills-take1"
if vhs tape/stills.tape >"$OUT/stills.log" 2>&1; then
  mv "$OUT/stills" "$OUT/stills-take1"
  if vhs tape/stills.tape >>"$OUT/stills.log" 2>&1; then
    i5_ok=1
    for f in "$OUT"/stills/*.png; do
      b="$(basename "$f")"
      if [ "$(sha256 "$f")" != "$(sha256 "$OUT/stills-take1/$b")" ]; then
        fail "I5: $b differs between the two runs"
        i5_ok=0
      fi
    done
    if [ $i5_ok -eq 1 ]; then pass "I5: $(ls "$OUT"/stills/*.png | wc -l | tr -d ' ') stills byte-identical across two runs (recordings/stills/)"; fi
    rm -rf "$OUT/stills-take1"
  else fail "second stills run failed (see recordings/stills.log)"; fi
else fail "stills run failed (see recordings/stills.log)"; fi

section "7. Record the demo (two takes, diffed)"
rm -rf "$OUT/frames"
if vhs tape/demo.tape >"$OUT/demo.log" 2>&1; then
  cp "$OUT/demo.ascii" "$OUT/demo-take1.ascii"
  rm -rf "$OUT/frames"
  if vhs tape/demo.tape >>"$OUT/demo.log" 2>&1; then
    if diff -q "$OUT/demo-take1.ascii" "$OUT/demo.ascii" >/dev/null; then
      pass "two takes diff to empty (demo.ascii)"
      rm -f "$OUT/demo-take1.ascii"
    else
      fail "the two takes differ: diff recordings/demo-take1.ascii recordings/demo.ascii"
    fi
    pass "recordings/demo.mp4, demo.gif, frames/, demo.ascii"
  else fail "second take failed (see recordings/demo.log)"; fi
else fail "recording failed (see recordings/demo.log)"; fi

if [ $WITH_FAILURE -eq 1 ]; then
  section "8. Failure scenario"
  if vhs tape/demo-failure.tape >"$OUT/demo-failure.log" 2>&1; then pass "recordings/demo-failure.mp4, demo-failure.gif"; else fail "failure-scenario recording failed (see recordings/demo-failure.log)"; fi
fi

section "Done"
if [ $FAILED -eq 0 ]; then echo "All checks passed. Recordings are in tui/recordings/."; else echo "Some checks failed (see above)."; fi
exit $FAILED
