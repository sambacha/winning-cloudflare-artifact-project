#!/usr/bin/env bash
# fix-open-issues.sh: close the open issues listed in
# docs/project-status-and-demo-guide.md §6.3 / §6.5 and in the last summary.
# Run it on a machine WITH network access (and, for the Cloudflare steps, a
# Cloudflare account). Every step is idempotent: run the script again after
# fixing whatever made a step fail.
#
#   bash scripts/fix-open-issues.sh                 run every step whose inputs are available
#   bash scripts/fix-open-issues.sh --dry-run       print what would be done, change nothing
#   bash scripts/fix-open-issues.sh --only deps,types,checks
#   bash scripts/fix-open-issues.sh --skip deploy,verify
#   bash scripts/fix-open-issues.sh --commit        git-commit the repository changes at the end
#   bash scripts/fix-open-issues.sh --full-tests    also run the full ts/ suite (~8 min) and tui/ tests
#
# Steps (in order) and the open issue each one closes:
#   deps     @cloudflare/sandbox is imported by ts/src/workers/edge.ts but not in
#            ts/package.json; wrangler is not pinned.  -> adds both to package.json
#            and the lockfile (npm install), pins the Sandbox image tag in
#            ts/Dockerfile to the same SDK version, makes `cf-types` use the
#            locked wrangler. scripts/deploy.mjs stops installing the SDK by
#            itself once it is declared.
#   types    type checking still uses the hand-written stand-in
#            ts/src/workers/cloudflare-modules.d.ts.  -> `wrangler types`, removes
#            the stand-in, type-checks edge.ts against the real types. If that
#            fails the stand-in is restored and the errors are saved to
#            ts/.fix-logs/types.log (edge.ts then needs a manual fix).
#   config   wrangler.toml placeholders (bucket_name, Artifacts namespace).
#            -> set from R2_BUCKET and ARTIFACTS_NAMESPACE.
#   bucket   the bucket may not exist; ts/r2-lifecycle.json was never applied.
#            -> creates the bucket (wrangler) and applies + reads back the
#            lifecycle rules over R2's S3 API.
#   live     ts/test/r2.live.test.ts has never run (skipped without credentials).
#            -> npm run test:r2-live with the R2_* variables.
#   cobuild  the three-leg cobuild has never run on real R2.  -> runs
#            scripts/demo-cobuild.sh --store r2 (three real legs, then status).
#   queue    push-event delivery (cf.artifacts.repo.pushed -> queue) is assumed.
#            -> creates the queue and tries to create the event subscription;
#            prints the dashboard route if the wrangler command is not accepted.
#   deploy   the Worker was never deployed.  -> npm run deploy (needs Docker for
#            the Sandbox container image).
#   secrets  API_TOKEN (and optional BISECT_API_TOKEN) secrets.  -> wrangler secret
#            put, from COBUILDS_API_TOKEN / BISECT_API_TOKEN or a generated
#            token saved to ts/.fix-logs/api-token (git-ignored).
#   verify   -> GET /healthz must answer {"status":"ok"}; GET /api/locks with the
#            token must answer 200.
#   checks   -> lockfile check, `tsc --noEmit`, edge type check, deploy-script
#            test (and the full suites with --full-tests).
#
# Inputs (environment variables):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   wrangler, non-interactive (or `wrangler login` beforehand)
#   R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#                                                 S3-API access to the bucket (live tests, lifecycle, cobuild)
#   ARTIFACTS_NAMESPACE                           Cloudflare Artifacts namespace for wrangler.toml
#   CF_SANDBOX_VERSION                            Sandbox SDK version (default: latest from npm)
#   WORKER_URL                                    deployed Worker URL, if it is not parsed from the deploy output
#   COBUILDS_API_TOKEN, BISECT_API_TOKEN          Worker secrets (generated when unset)
# A step whose inputs are missing is reported as SKIP, not FAIL.
#
# Not fixable by a script (reported at the end): integration into Rush itself,
# a separate rebuild mode, and the two timing-sensitive bisect acceptance tests.
#
# A report is written to ts/.fix-logs/report.md. Exit status: 0 if no step
# failed, 1 otherwise.
set -uo pipefail

DRY=0
COMMIT=0
FULL_TESTS=0
ONLY=""
SKIP=""
ALL_STEPS="deps types config bucket live cobuild queue deploy secrets verify checks"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --commit) COMMIT=1; shift ;;
    --full-tests) FULL_TESTS=1; shift ;;
    --only) ONLY="${2//,/ }"; shift 2 ;;
    --skip) SKIP="${2//,/ }"; shift 2 ;;
    -h | --help) sed -n '2,70p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$ROOT/ts"
LOGS="$TS/.fix-logs"
mkdir -p "$LOGS"
grep -qxF '.fix-logs/' "$TS/.gitignore" 2>/dev/null || { [ $DRY -eq 1 ] || echo '.fix-logs/' >>"$TS/.gitignore"; }
REPORT="$LOGS/report.md"
WRANGLER_RANGE="^4.145.0"
QUEUE="artifacts-push-events"

RESULTS=()
FAILED=0
CHANGED_FILES=()
pass() {
  if [ $DRY -eq 1 ] && [ "$CUR" != preflight ]; then printf '  \033[36mPLAN\033[0m  %s\n' "$1"; RESULTS+=("PLAN|$CUR|$1"); return; fi
  printf '  \033[32mPASS\033[0m  %s\n' "$1"; RESULTS+=("PASS|$CUR|$1")
}
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; RESULTS+=("FAIL|$CUR|$1"); FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; RESULTS+=("SKIP|$CUR|$1"); }
note() { printf '  ....  %s\n' "$1"; }
section() { CUR="$1"; printf '\n== %s: %s\n' "$1" "$2"; }
changed() { CHANGED_FILES+=("$@"); }

# run CMD...: print it, and execute it unless --dry-run. Output goes to the step log.
run() {
  printf '  $ %s\n' "$*"
  [ $DRY -eq 1 ] && return 0
  "$@" >>"$LOGS/$CUR.log" 2>&1
}
wrangler() {
  if [ -f "$TS/node_modules/wrangler/bin/wrangler.js" ]; then
    (cd "$TS" && node node_modules/wrangler/bin/wrangler.js "$@")
  else
    (cd "$TS" && npx --yes "wrangler@$WRANGLER_RANGE" "$@")
  fi
}
want() {
  local s="$1"
  if [ -n "$ONLY" ]; then case " $ONLY " in *" $s "*) ;; *) return 1 ;; esac; fi
  case " $SKIP " in *" $s "*) return 1 ;; esac
  return 0
}
have_cf() { [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || (wrangler whoami 2>/dev/null | grep -qi "associated with"); }
have_r2() { [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_BUCKET:-}" ] && { [ -n "${R2_ACCOUNT_ID:-}" ] || [ -n "${R2_ENDPOINT:-}" ]; }; }
pkg_has() { node -e 'const p=require(process.argv[1]);process.exit((p.dependencies||{})[process.argv[2]]||(p.devDependencies||{})[process.argv[2]]?0:1)' "$TS/package.json" "$1"; }

# ---------------------------------------------------------------------------
section preflight "tools and network"
CUR=preflight
if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
  pass "node $(node --version)"
else
  fail "node >= 22.18 is required (found: $(node --version 2>/dev/null || echo none))"
  exit 1
fi
command -v npm >/dev/null && pass "npm $(npm --version)" || { fail "npm missing"; exit 1; }
command -v git >/dev/null && pass "git $(git --version | cut -d' ' -f3)" || fail "git missing"
NET=0
if [ "${FIX_ASSUME_NETWORK:-0}" = 1 ]; then NET=1; note "FIX_ASSUME_NETWORK=1: network check skipped"
elif curl -fsS -m 10 -o /dev/null https://registry.npmjs.org/ 2>/dev/null; then NET=1; pass "npm registry reachable"; else
  needs_net=0
  for st in deps types bucket live cobuild queue deploy secrets; do want "$st" && needs_net=1; done
  if [ $needs_net -eq 1 ]; then fail "no network access to registry.npmjs.org: the selected deps/types/Cloudflare steps cannot run"; else note "no network access (not needed by the selected steps)"; fi
fi
if [ -n "$(git -C "$ROOT" status --porcelain -- ts 2>/dev/null)" ]; then note "ts/ has uncommitted changes; they will be mixed with this script's changes"; fi
if [ ! -d "$TS/node_modules" ]; then
  if [ $NET -eq 1 ]; then run bash -c "cd '$TS' && npm ci --no-audit --no-fund" && pass "npm ci" || fail "npm ci failed (log: ts/.fix-logs/preflight.log)"; fi
fi
[ $DRY -eq 1 ] || node "$TS/scripts/ensure-exec.mjs" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
if want deps; then
  section deps "lock @cloudflare/sandbox and wrangler in package.json + package-lock.json"
  if [ $NET -eq 0 ]; then skip "no network"; else
    SDK_VERSION="${CF_SANDBOX_VERSION:-}"
    if [ -z "$SDK_VERSION" ]; then SDK_VERSION="$(cd "$TS" && npm view @cloudflare/sandbox version 2>/dev/null)"; fi
    if [ -z "$SDK_VERSION" ]; then fail "could not resolve a @cloudflare/sandbox version (set CF_SANDBOX_VERSION)"; else
      note "Sandbox SDK version: $SDK_VERSION"
      ok=1
      if pkg_has @cloudflare/sandbox; then pass "@cloudflare/sandbox already declared"; else
        run bash -c "cd '$TS' && npm install --save-exact --no-audit --no-fund @cloudflare/sandbox@$SDK_VERSION" &&
          pass "@cloudflare/sandbox@$SDK_VERSION added to dependencies" || { fail "npm install @cloudflare/sandbox failed (log: ts/.fix-logs/deps.log)"; ok=0; }
      fi
      if pkg_has wrangler; then pass "wrangler already declared"; else
        run bash -c "cd '$TS' && npm install -D --no-audit --no-fund wrangler@$WRANGLER_RANGE" &&
          pass "wrangler@$WRANGLER_RANGE added to devDependencies (locked)" || { fail "npm install wrangler failed (log: ts/.fix-logs/deps.log)"; ok=0; }
      fi
      run bash -c "cd '$TS' && npm pkg set 'scripts.cf-types=wrangler types'" && pass "cf-types now runs the locked wrangler"
      # The Sandbox SDK requires the container image tag to equal the SDK version.
      INSTALLED="$(node -p 'require(process.argv[1]).version' "$TS/node_modules/@cloudflare/sandbox/package.json" 2>/dev/null || echo "$SDK_VERSION")"
      if grep -q 'docker.io/cloudflare/sandbox:latest' "$TS/Dockerfile"; then
        if [ $DRY -eq 0 ]; then sed -i.bak "s|docker.io/cloudflare/sandbox:latest|docker.io/cloudflare/sandbox:$INSTALLED|" "$TS/Dockerfile" && rm -f "$TS/Dockerfile.bak"; fi
        pass "ts/Dockerfile: sandbox image pinned to :$INSTALLED (same as the SDK)"
      else
        note "ts/Dockerfile: $(grep -m1 '^FROM' "$TS/Dockerfile")"
      fi
      changed ts/package.json ts/package-lock.json ts/Dockerfile
      if [ $ok -eq 1 ] && [ $DRY -eq 0 ]; then
        (cd "$TS" && node scripts/check-lockfile.mjs >>"$LOGS/deps.log" 2>&1) && pass "lockfile check: package.json and package-lock.json agree" || fail "lockfile check failed"
        (cd "$TS" && node scripts/deploy.mjs --check-only >>"$LOGS/deps.log" 2>&1) && pass "deploy.mjs no longer needs to install anything" || fail "deploy.mjs --check-only still reports a missing package"
        work="$(mktemp -d)"
        cp "$TS/package.json" "$TS/package-lock.json" "$work/"
        (cd "$work" && npm ci --ignore-scripts --no-audit --no-fund >>"$LOGS/deps.log" 2>&1) && pass "npm ci succeeds in a fresh directory" || fail "npm ci fails in a fresh directory (log: ts/.fix-logs/deps.log)"
        rm -rf "$work"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want types; then
  section types "replace the stand-in Cloudflare types with generated / published ones"
  STANDIN="$TS/src/workers/cloudflare-modules.d.ts"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! pkg_has wrangler || ! [ -d "$TS/node_modules/@cloudflare/sandbox" ]; then
    skip "run the deps step first (wrangler and @cloudflare/sandbox must be installed)"
  else
    if run wrangler types; then
      pass "wrangler types -> ts/worker-configuration.d.ts"
      changed ts/worker-configuration.d.ts
      if [ $DRY -eq 0 ]; then
        node -e '
const fs=require("fs"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,"utf8"));
if(!c.include.includes("worker-configuration.d.ts")) c.include.push("worker-configuration.d.ts");
fs.writeFileSync(f, JSON.stringify(c,null,2)+"\n")' "$TS/tsconfig.edge.json"
      fi
      changed ts/tsconfig.edge.json
      if [ -f "$STANDIN" ]; then
        [ $DRY -eq 1 ] || mv "$STANDIN" "$LOGS/cloudflare-modules.d.ts.bak"
        if [ $DRY -eq 1 ] || (cd "$TS" && node node_modules/typescript/bin/tsc -p tsconfig.edge.json >"$LOGS/types.log" 2>&1); then
          pass "edge.ts type-checks against the real types; stand-in removed"
          changed ts/src/workers/cloudflare-modules.d.ts
        else
          mv "$LOGS/cloudflare-modules.d.ts.bak" "$STANDIN"
          fail "edge.ts does not type-check against the real types: stand-in restored; fix edge.ts using ts/.fix-logs/types.log, then rerun --only types"
          head -n 20 "$LOGS/types.log" | sed 's/^/        /'
        fi
      else
        (cd "$TS" && node node_modules/typescript/bin/tsc -p tsconfig.edge.json >"$LOGS/types.log" 2>&1) && pass "stand-in already gone; edge.ts type-checks" || fail "edge.ts type errors (ts/.fix-logs/types.log)"
      fi
    else
      fail "wrangler types failed (log: ts/.fix-logs/types.log)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want config; then
  section config "wrangler.toml placeholders"
  TOML="$TS/wrangler.toml"
  if [ -n "${R2_BUCKET:-}" ]; then
    [ $DRY -eq 1 ] || sed -i.bak -E "s|^bucket_name = \".*\"|bucket_name = \"$R2_BUCKET\"|" "$TOML"
    pass "bucket_name = \"$R2_BUCKET\""
  else
    skip "R2_BUCKET unset: bucket_name stays \"$(sed -nE 's/^bucket_name = "(.*)"/\1/p' "$TOML")\""
  fi
  if [ -n "${ARTIFACTS_NAMESPACE:-}" ]; then
    [ $DRY -eq 1 ] || sed -i.bak -E "s|^namespace = \"[^\"]*\".*$|namespace = \"$ARTIFACTS_NAMESPACE\"|" "$TOML"
    pass "Artifacts namespace = \"$ARTIFACTS_NAMESPACE\""
  else
    skip "ARTIFACTS_NAMESPACE unset: the Artifacts namespace is still the placeholder \"default\""
  fi
  rm -f "$TOML.bak"
  changed ts/wrangler.toml
fi

# ---------------------------------------------------------------------------
if want bucket; then
  section bucket "R2 bucket and lifecycle rules (ts/r2-lifecycle.json)"
  if [ $NET -eq 0 ]; then skip "no network"; elif [ -z "${R2_BUCKET:-}" ]; then skip "R2_BUCKET unset"; else
    if have_cf; then
      if [ $DRY -eq 0 ] && wrangler r2 bucket list 2>/dev/null | grep -qE "(^|[[:space:]])$R2_BUCKET([[:space:]]|$)"; then
        pass "bucket $R2_BUCKET exists"
      else
        run wrangler r2 bucket create "$R2_BUCKET" && pass "bucket $R2_BUCKET created" || fail "could not create bucket $R2_BUCKET (log: ts/.fix-logs/bucket.log)"
      fi
    else
      skip "no Cloudflare credentials (CLOUDFLARE_API_TOKEN or wrangler login): bucket existence not checked"
    fi
    if have_r2; then
      printf '  $ PutBucketLifecycleConfiguration %s < ts/r2-lifecycle.json\n' "$R2_BUCKET"
      if [ $DRY -eq 1 ] || (cd "$TS" && node --input-type=module >>"$LOGS/bucket.log" 2>&1 <<'EOF'
import { readFileSync } from "node:fs"
import { S3Client, PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3"
const e = process.env
const endpoint = e.R2_ENDPOINT ?? `https://${e.R2_ACCOUNT_ID}.${e.R2_JURISDICTION ? e.R2_JURISDICTION + "." : ""}r2.cloudflarestorage.com`
const s3 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY } })
const rules = JSON.parse(readFileSync("r2-lifecycle.json", "utf8"))
await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: e.R2_BUCKET, LifecycleConfiguration: rules }))
const back = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: e.R2_BUCKET }))
const want = rules.Rules.map((r) => r.ID).sort(), got = (back.Rules ?? []).map((r) => r.ID).sort()
console.log("lifecycle rules read back:", got.join(", "))
for (const id of want) if (!got.includes(id)) { console.error("missing rule " + id); process.exit(1) }
EOF
      ); then pass "lifecycle rules applied and read back (nm-cache 30 d, build-cache 30 d)"; else fail "lifecycle rules not applied (log: ts/.fix-logs/bucket.log)"; fi
    else
      skip "R2_* S3 credentials unset: lifecycle rules not applied"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want live; then
  section live "live R2 adapter tests (acquire, renew, takeover, 412, 429, blob+manifest, list)"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! have_r2; then skip "R2_* S3 credentials unset"; else
    if run bash -c "cd '$TS' && npm run --silent test:r2-live"; then
      if [ $DRY -eq 0 ] && grep -qE "skipped|↓" "$LOGS/live.log" && ! grep -qE "[1-9][0-9]* passed" "$LOGS/live.log"; then fail "the live tests were skipped (credentials not picked up?)"; else pass "test/r2.live.test.ts passed against $R2_BUCKET"; fi
      note "record what R2 actually returned (429 vs 412 precedence, 409 on races, ETag quoting) in docs/r2-end-to-end-review.md"
    else
      fail "live R2 tests failed (log: ts/.fix-logs/live.log)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want cobuild; then
  section cobuild "three-leg cobuild on real R2"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! have_r2; then skip "R2_* S3 credentials unset"; else
    [ -f "$TS/dist/cli/bin.js" ] || run bash -c "cd '$TS' && npm run --silent build"
    if run bash "$ROOT/scripts/demo-cobuild.sh" --store r2 --no-color --op-seconds 3; then
      pass "three legs on R2: each operation built once, rerun all cache hits (log: ts/.fix-logs/cobuild.log)"
    else
      fail "three-leg cobuild on R2 did not behave as expected (log: ts/.fix-logs/cobuild.log)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want queue; then
  section queue "push-event queue ($QUEUE) and cf.artifacts.repo.pushed subscription"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! have_cf; then skip "no Cloudflare credentials"; else
    if [ $DRY -eq 0 ] && wrangler queues info "$QUEUE" >/dev/null 2>&1; then pass "queue $QUEUE exists"; else
      run wrangler queues create "$QUEUE" && pass "queue $QUEUE created" || fail "could not create queue $QUEUE (log: ts/.fix-logs/queue.log)"
    fi
    # UNVERIFIED flags: event subscriptions are newer than this repository's docs.
    if run wrangler queues subscription create "$QUEUE" --source artifacts --events cf.artifacts.repo.pushed; then
      pass "event subscription cf.artifacts.repo.pushed -> $QUEUE created"
    else
      fail "wrangler did not accept the event subscription; create it in the dashboard (Queues -> $QUEUE -> Subscriptions -> source Artifacts, event cf.artifacts.repo.pushed), then push a commit and check the Worker log for a 'queue' line"
    fi
    note "after the first real push, compare the payload with parsePushEvent (ts/src/workflows/ciDriver.ts)"
  fi
fi

# ---------------------------------------------------------------------------
if want deploy; then
  section deploy "deploy the Worker (npm run deploy)"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! have_cf; then skip "no Cloudflare credentials"; elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    fail "Docker is not running: wrangler needs it to build the Sandbox container image (ts/Dockerfile)"
  elif grep -q 'replace with your Artifacts namespace' "$TS/wrangler.toml"; then
    skip "wrangler.toml still has the placeholder Artifacts namespace (set ARTIFACTS_NAMESPACE and run --only config)"
  else
    if run bash -c "cd '$TS' && npm run deploy"; then
      pass "deployed"
      url="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$LOGS/deploy.log" | tail -n 1)"
      if [ -n "$url" ]; then WORKER_URL="${WORKER_URL:-$url}"; echo "$WORKER_URL" >"$LOGS/worker-url"; note "Worker URL: $WORKER_URL"; fi
    else
      fail "npm run deploy failed (log: ts/.fix-logs/deploy.log)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want secrets; then
  section secrets "Worker secrets"
  if [ $NET -eq 0 ]; then skip "no network"; elif ! have_cf; then skip "no Cloudflare credentials"; else
    TOKEN="${COBUILDS_API_TOKEN:-}"
    if [ -z "$TOKEN" ] && [ -f "$LOGS/api-token" ]; then TOKEN="$(cat "$LOGS/api-token")"; fi
    if [ -z "$TOKEN" ]; then
      TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
      [ $DRY -eq 1 ] || { umask 077; echo "$TOKEN" >"$LOGS/api-token"; }
      note "generated API_TOKEN, saved to ts/.fix-logs/api-token (git-ignored); export COBUILDS_API_TOKEN=\$(cat ts/.fix-logs/api-token) for the TUI"
    fi
    printf '  $ wrangler secret put API_TOKEN   (value from stdin)\n'
    if [ $DRY -eq 1 ] || printf '%s' "$TOKEN" | wrangler secret put API_TOKEN >>"$LOGS/secrets.log" 2>&1; then pass "API_TOKEN set"; else fail "could not set API_TOKEN (log: ts/.fix-logs/secrets.log)"; fi
    if [ -n "${BISECT_API_TOKEN:-}" ]; then
      if [ $DRY -eq 1 ] || printf '%s' "$BISECT_API_TOKEN" | wrangler secret put BISECT_API_TOKEN >>"$LOGS/secrets.log" 2>&1; then pass "BISECT_API_TOKEN set"; else fail "could not set BISECT_API_TOKEN"; fi
    else
      skip "BISECT_API_TOKEN unset (optional write token for /api/bisect)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want verify; then
  section verify "deployed Worker answers"
  [ -n "${WORKER_URL:-}" ] || { [ -f "$LOGS/worker-url" ] && WORKER_URL="$(cat "$LOGS/worker-url")"; }
  if [ -z "${WORKER_URL:-}" ]; then skip "no Worker URL (deploy first, or set WORKER_URL)"; elif [ $DRY -eq 1 ]; then note "would GET $WORKER_URL/healthz and /api/locks"; else
    body="$(curl -fsS -m 20 "$WORKER_URL/healthz" 2>>"$LOGS/verify.log")"
    if printf '%s' "$body" | grep -q '"status":"ok"'; then pass "GET /healthz -> $body"; else fail "GET /healthz -> '${body:-no answer}'"; fi
    TOKEN="${COBUILDS_API_TOKEN:-$(cat "$LOGS/api-token" 2>/dev/null)}"
    if [ -n "$TOKEN" ]; then
      code="$(curl -s -m 20 -o "$LOGS/locks.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$WORKER_URL/api/locks?context=fix-open-issues")"
      if [ "$code" = 200 ]; then pass "GET /api/locks with the token -> 200"; else fail "GET /api/locks -> HTTP $code (body: ts/.fix-logs/locks.json)"; fi
      code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$WORKER_URL/api/locks?context=fix-open-issues")"
      if [ "$code" = 401 ] || [ "$code" = 403 ]; then pass "GET /api/locks without a token -> $code"; else fail "GET /api/locks without a token -> HTTP $code (expected 401/403)"; fi
    else
      skip "no API token known: /api/locks not checked"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if want checks; then
  section checks "repository checks"
  if [ $DRY -eq 1 ]; then note "would run the lockfile check, tsc, the edge type check and the deploy-script test"; else
    (cd "$TS" && node scripts/check-lockfile.mjs >"$LOGS/checks.log" 2>&1) && pass "lockfile check" || fail "lockfile check (ts/.fix-logs/checks.log)"
    (cd "$TS" && node node_modules/typescript/bin/tsc --noEmit >>"$LOGS/checks.log" 2>&1) && pass "tsc --noEmit" || fail "tsc --noEmit (ts/.fix-logs/checks.log)"
    (cd "$TS" && node node_modules/typescript/bin/tsc -p tsconfig.edge.json >>"$LOGS/checks.log" 2>&1) && pass "edge.ts type check (tsconfig.edge.json)" || fail "edge.ts type check (ts/.fix-logs/checks.log)"
    (cd "$TS" && node scripts/ensure-exec.mjs && node node_modules/vitest/vitest.mjs run test/deployScript.test.ts >>"$LOGS/checks.log" 2>&1) && pass "deploy-script test" || fail "deploy-script test (ts/.fix-logs/checks.log)"
    if [ $FULL_TESTS -eq 1 ]; then
      note "full ts/ suite (~8 min); do not run a Lean build at the same time (timing-sensitive tests)"
      (cd "$TS" && npm test >"$LOGS/tests.log" 2>&1) && pass "ts/ test suite ($(grep -oE '[0-9]+ passed' "$LOGS/tests.log" | tail -n 1))" || fail "ts/ test suite (ts/.fix-logs/tests.log)"
      (cd "$ROOT/tui" && node --import ./src/ink/register.ts --test test/*.test.ts >"$LOGS/tui-tests.log" 2>&1) && pass "tui/ tests" || fail "tui/ tests (ts/.fix-logs/tui-tests.log)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
section summary "report"
{
  echo "# fix-open-issues report ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo
  echo "| result | step | detail |"
  echo "|---|---|---|"
  for r in ${RESULTS[@]+"${RESULTS[@]}"}; do IFS='|' read -r a b c <<<"$r"; echo "| $a | $b | ${c//|/\\|} |"; done
  echo
  echo "Not fixable by this script: integration into Rush itself, a separate rebuild mode,"
  echo "and the timing sensitivity of test/bisectAcceptance.test.ts under heavy load."
} >"$REPORT"
note "report: ts/.fix-logs/report.md (logs per step in ts/.fix-logs/)"
npass=$(printf '%s\n' ${RESULTS[@]+"${RESULTS[@]}"} | grep -c '^PASS' || true)
nfail=$(printf '%s\n' ${RESULTS[@]+"${RESULTS[@]}"} | grep -c '^FAIL' || true)
nskip=$(printf '%s\n' ${RESULTS[@]+"${RESULTS[@]}"} | grep -c '^SKIP' || true)
nplan=$(printf '%s\n' ${RESULTS[@]+"${RESULTS[@]}"} | grep -c '^PLAN' || true)
echo "  $npass passed, $nfail failed, $nskip skipped$([ $DRY -eq 1 ] && echo ", $nplan planned (dry run: nothing was changed)")"

if [ $COMMIT -eq 1 ] && [ $DRY -eq 0 ]; then
  files=()
  for f in ${CHANGED_FILES[@]+"${CHANGED_FILES[@]}"} ts/.gitignore; do
    if [ -e "$ROOT/$f" ] || git -C "$ROOT" cat-file -e "HEAD:$f" 2>/dev/null; then files+=("$f"); fi
  done
  if [ ${#files[@]} -gt 0 ] && [ -n "$(git -C "$ROOT" status --porcelain -- "${files[@]}")" ]; then
    git -C "$ROOT" add -A -- "${files[@]}" && git -C "$ROOT" commit -q -m "Close open deployment issues (scripts/fix-open-issues.sh)" -- "${files[@]}" &&
      note "committed: $(git -C "$ROOT" log -1 --format=%h) (push it yourself)"
  else
    note "nothing to commit"
  fi
fi
exit $FAILED
