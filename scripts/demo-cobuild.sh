#!/usr/bin/env bash
# demo-cobuild.sh: run the three-leg cooperative build (demo A) in ONE terminal,
# so it can be recorded by VHS / asciinema / a screen recorder, or just watched.
#
#   bash scripts/demo-cobuild.sh [--scenario clean|takeover|failure] [--store fs:<dir>|r2]
#                                [--ops N] [--op-seconds S] [--no-color] [--keep]
#
# What happens:
#   1. a "wide" plan is written: N independent packages (each sleeps S seconds,
#      then writes a file) plus one `app` operation that depends on all of them;
#   2. three legs (primary, extra1, extra2) start at the same time, each in its
#      own working directory, all pointing at the same store and context. Their
#      output is interleaved here with a coloured [leg] prefix;
#   3. scenario `takeover`: part-way through, extra1 is sent SIGINT (as if
#      Ctrl-C was pressed in its terminal). It releases its locks and another
#      leg takes the work over;
#      scenario `failure`: one package's command exits 1. The failing leg
#      publishes a failure marker; the other legs report it instead of
#      rebuilding, and nobody builds `app`;
#   4. `cobuild status` prints the lock records of the context;
#   5. (clean / takeover) the primary leg runs again in a fresh directory:
#      every operation is a cache hit.
#
# The default store is a local directory with R2's write rules (`fs:`), so no
# network or Cloudflare account is needed. With `--store r2` the R2_* variables
# must be set (see docs/project-status-and-demo-guide.md §2.4). Say
# "R2-compatible local store" in captions unless --store r2 was used.
#
# Exit status: 0 when the run behaved as the scenario expects, 1 otherwise.
set -uo pipefail

SCENARIO=clean
STORE=""
OPS=6
OP_SECONDS=4
COLOR=1
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --ops) OPS="$2"; shift 2 ;;
    --op-seconds) OP_SECONDS="$2"; shift 2 ;;
    --no-color) COLOR=0; shift ;;
    --keep) KEEP=1; shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$SCENARIO" in clean | takeover | failure) ;; *) echo "unknown scenario: $SCENARIO" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/ts/dist/cli/bin.js"
if [ ! -f "$CLI" ]; then
  echo "building ts/dist (npm run build) ..."
  (cd "$ROOT/ts" && npm run --silent build) || { echo "build failed" >&2; exit 1; }
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cobuild-demo-XXXXXX")"
[ -n "$STORE" ] || STORE="fs:$WORK/store"
export RUSH_COBUILD_ENABLED=1
export COBUILD_SCOPE="${COBUILD_SCOPE:-trusted}"
export RUSH_COBUILD_CONTEXT="${RUSH_COBUILD_CONTEXT:-demo-$SCENARIO-$(date +%s)}"

if [ $COLOR -eq 1 ]; then
  C_primary=$'\033[36m'; C_extra1=$'\033[35m'; C_extra2=$'\033[33m'; C_b=$'\033[1m'; C_0=$'\033[0m'
else
  C_primary=""; C_extra1=""; C_extra2=""; C_b=""; C_0=""
fi
say() { printf '\n%s== %s%s\n' "$C_b" "$1" "$C_0"; }

# --- 1. plan ---------------------------------------------------------------
PLAN="$WORK/wide-plan.json"
FAIL_OP=""
[ "$SCENARIO" = failure ] && FAIL_OP="pkg-c"
node - "$PLAN" "$OPS" "$OP_SECONDS" "$FAIL_OP" "$RUSH_COBUILD_CONTEXT" <<'EOF'
const [file, n, secs, failOp, salt] = process.argv.slice(2)
const names = Array.from({ length: Number(n) }, (_, i) => `pkg-${String.fromCharCode(97 + i)}`)
const ops = names.map((name) => {
  const id = name.slice(4)
  const body = name === failOp
    ? `sleep ${secs} && echo "error TS2322: Type 'string' is not assignable to type 'number'" >&2 && exit 1`
    : `sleep ${secs} && mkdir -p out/${id} && echo ${id} > out/${id}/x`
  return { name, command: body, outputs: [`out/${id}`] }
})
ops.push({ name: "app", deps: names, command: "mkdir -p out/app && cat out/*/x > out/app/all", outputs: ["out/app"] })
require("fs").writeFileSync(file, JSON.stringify({ flushSalt: salt, toolchain: "node22", operations: ops }, null, 2))
EOF

say "scenario: $SCENARIO   store: $STORE   context: $RUSH_COBUILD_CONTEXT"
echo "plan: $OPS independent packages (${OP_SECONDS}s each) + app (depends on all of them)"

# --- 2. three legs ----------------------------------------------------------
run_leg() {
  local job="$1" color="$2"
  mkdir -p "$WORK/leg-$job"
  cp "$PLAN" "$WORK/leg-$job/"
  (cd "$WORK/leg-$job" &&
    exec node "$CLI" run --plan wide-plan.json --scope "$COBUILD_SCOPE" --job "$job" --store "$STORE" \
      --events "$WORK/events-$job.jsonl" 2>&1 >"$WORK/summary-$job.json") |
    tee -a "$WORK/legs.log" |
    while IFS= read -r line; do printf '%s[%-7s]%s %s\n' "$color" "$job" "$C_0" "$line"; done &
}
say "three legs start together"
START=$(date +%s)
for job in primary extra1 extra2; do
  v="C_$job"
  run_leg "$job" "${!v}"
done

if [ "$SCENARIO" = takeover ]; then
  sleep $((OP_SECONDS / 2 + 1))
  victim=$(pgrep -f -- "--job extra1 --store" | head -n 1 || true)
  if [ -n "$victim" ]; then
    printf '\n%s>>> Ctrl-C on extra1 (SIGINT to pid %s): it releases its locks, another leg takes over%s\n\n' "$C_b" "$victim" "$C_0"
    kill -INT "$victim"
  else
    echo ">>> extra1 had already finished; no takeover to show (try a larger --op-seconds)"
  fi
fi
wait
ELAPSED=$(($(date +%s) - START))
say "all legs finished in ${ELAPSED}s (one machine building alone: about $((OPS * OP_SECONDS))s of package work)"

# --- 3. status ----------------------------------------------------------------
say "cobuild status --context $RUSH_COBUILD_CONTEXT"
node "$CLI" status --context "$RUSH_COBUILD_CONTEXT" --store "$STORE" >"$WORK/status.json" 2>"$WORK/status.err" || cat "$WORK/status.err"
node - "$WORK/status.json" "$PLAN" <<'EOF2'
const fs = require("fs")
let st
try { st = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) } catch { console.log("(no status output)"); process.exit(0) }
const locks = st.locks ?? []
console.log(`${"cache key".padEnd(22)} ${"owner".padEnd(8)} ${"status".padEnd(10)} lease`)
for (const l of locks) {
  const key = String(l.cacheKey ?? l.key).replace(/^blake3:/, "").slice(0, 12) + "…"
  console.log(`blake3:${key.padEnd(15)} ${String(l.owner).padEnd(8)} ${String(l.status).padEnd(10)} ${l.leaseExpired ? "expired" : "live"}`)
}
const by = {}
for (const l of locks) by[l.owner] = (by[l.owner] ?? 0) + 1
console.log(`${locks.length} lock records; records per owner: ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(", ")}`)
EOF2

# --- 4. rerun / outcome check ---------------------------------------------------
STATUS=0
builds_of() { grep -cE "\] BUILD +$1 " "$WORK/legs.log" || true; }
if [ "$SCENARIO" = clean ]; then
  dup=""
  for op in $(node -e 'for (const o of require(process.argv[1]).operations) console.log(o.name)' "$PLAN"); do
    n=$(builds_of "$op")
    [ "$n" = 1 ] || dup="$dup $op($n)"
  done
  if [ -z "$dup" ]; then echo "every operation was built by exactly one leg"; else echo "built more than once or never:$dup"; STATUS=1; fi
fi
if [ "$SCENARIO" != failure ]; then
  say "primary runs again in a fresh directory: everything should come from the cache"
  mkdir -p "$WORK/leg-rerun" && cp "$PLAN" "$WORK/leg-rerun/"
  (cd "$WORK/leg-rerun" && node "$CLI" run --plan wide-plan.json --scope "$COBUILD_SCOPE" --job primary --store "$STORE" 2>&1 >"$WORK/summary-rerun.json") |
    sed "s/^/${C_primary}[rerun  ]${C_0} /"
  if [ -f "$WORK/leg-rerun/out/app/all" ]; then
    echo "out/app/all restored from the cache: $(tr '\n' ' ' <"$WORK/leg-rerun/out/app/all")"
  else
    echo "out/app/all missing after the rerun"; STATUS=1
  fi
else
  for job in primary extra1 extra2; do
    if [ -f "$WORK/leg-$job/out/app/all" ]; then echo "leg $job built app despite the failure"; STATUS=1; fi
  done
  n=$(builds_of pkg-c)
  if [ "$n" = 1 ]; then echo "pkg-c failed once and the failure was shared (no rebuild by the other legs)"; else echo "pkg-c was built $n times"; STATUS=1; fi
  [ $STATUS -eq 0 ] && echo "no leg built app"
fi

if [ $KEEP -eq 1 ]; then echo "work directory kept: $WORK"; else rm -rf "$WORK"; fi
exit $STATUS
