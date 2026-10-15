#!/usr/bin/env bash
# Offline demo of the feature slice: node_modules cache + durable bisect.
#
#   bash scripts/demo.sh [state-dir]
#
# 1. Builds `dist/` (tsc).
# 2. Runs the bisect demo on the generated 50-commit demo monorepo: a
#    directory stands in for R2, local sandboxes stand in for the Sandbox SDK,
#    and a file journal stands in for Workflow step outputs. It prints one
#    JSON line per completed step and a final result line (culprit, posterior
#    confidence, observations, skipped commits).
# 3. Runs the same command again on the same state directory: the run is
#    already finished, so every step is replayed and no predicate re-runs.
# 4. Prints one frame of the terminal dashboard (`tui/`, illustrative data)
#    and one frame of its charts view.
#
# Nothing here touches Cloudflare: no network or account is needed.
# To see crash recovery, interrupt step 2 with Ctrl-C (or `kill -9`) and run
# `node dist/demo/bisectDemoBin.js --state <state-dir>` again: it resumes.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="${1:-$(mktemp -d "${TMPDIR:-/tmp}/bisect-demo-XXXXXX")}"

echo "== build"
node scripts/ensure-exec.mjs
node node_modules/typescript/bin/tsc -p tsconfig.build.json

echo "== bisect (state: $STATE)"
node dist/demo/bisectDemoBin.js --state "$STATE" --seed demo | tail -n 1

echo "== same command again: replayed from the journal, nothing re-runs"
node dist/demo/bisectDemoBin.js --state "$STATE" --seed demo | tail -n 1

echo "== dashboard frame (illustrative data)"
(cd ../tui && node src/main.ts --snapshot 52 --seed 1 --no-color)

echo "== charts frame of the same run (illustrative data; interactive: cd ../tui && npm run charts)"
(cd ../tui && node src/main.ts --snapshot 52 --seed 1 --no-color --charts --cols 140 --rows 44)
