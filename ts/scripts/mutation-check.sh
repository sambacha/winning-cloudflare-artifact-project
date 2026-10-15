#!/usr/bin/env bash
# Mutation adequacy for the cache client and the lock's scoping.
#
# Each mutant removes one safety mechanism from the *source*. The named test
# file must fail on every mutant (otherwise the tests do not check that
# mechanism). The source is restored after each run, also on Ctrl-C.
#
# The tests draw fresh seeds (FC_SEED pins one); the script prints the seed of
# each surviving run so that a survivor can be replayed.
#
#   bash scripts/mutation-check.sh      # exit 0 iff every mutant is detected
#
# If `node_modules/.bin` lost its executable bits, set ESBUILD_BINARY_PATH to
# an executable copy of `node_modules/@esbuild/<platform>/bin/esbuild`.
set -u
cd "$(dirname "$0")/.."

VITEST="node node_modules/vitest/vitest.mjs run"

# name | file | sed expression | test file   (fields are split on '|', so expressions must not contain it)
MUTANTS=(
  "lock key without trust scope (D-1)|src/lock.ts|s/encodeKey(\[cfg.scope, cfg.prefix/encodeKey([\"shared\", cfg.prefix/|test/scenarios.test.ts"
  "restore skips the digest check (D-7)|src/cache/restore.ts|s/if (!digestEquals(h.finish(), expected)) return yield\* missOf(\"digest_mismatch\", scope)/h.finish()/|test/cache/publishRestore.test.ts"
  "restore commits instead of aborting on failure (D-7)|src/cache/restore.ts|s/exit._tag === \"Success\" ? Effect.void : session.abort/exit._tag === \"Success\" ? Effect.void : Effect.ignore(session.commit)/|test/cache/publishRestore.test.ts"
  "untrusted jobs prefer their own scope (D-1)|src/cache/scope.ts|s/\[...policy.trusted, job.scope\]/[job.scope, ...policy.trusted]/|test/cache/publishRestore.test.ts"
  "trusted jobs also read untrusted scopes (D-1)|src/cache/scope.ts|s/isTrusted(policy, job) ? policy.trusted : /isTrusted(policy, job) ? [...policy.trusted, \"fork-pr\" as Scope] : /|test/cache/publishRestore.test.ts"
  "publish commits the manifest without waiting for the blobs (D-3)|src/cache/publish.ts|s/    yield\* Effect.forEach(\[...distinct\]/    void Effect.forEach([...distinct]/|test/cache/publishRestore.test.ts"
  "lookup key ignores dependencies (D-2)|src/cache/lookupKey.ts|s/for (const d of deps) field(parts, d)//|test/cache/keys.test.ts"
  "key encoding does not escape '/' (D-4)|src/cache/keyEncoding.ts|s#code === 0x2f /\\* / \\*/#false#|test/cache/keys.test.ts"
  "breaker without probe (D-12)|src/cache/breaker.ts|s/return s.cool > 0 ? { tag: \"open\", cool: s.cool - 1 } : { tag: \"halfOpen\" }/return s/|test/cache/policies.test.ts"
  "config check without latency and skew (D-10)|src/lock.ts|s/r.renewIntervalMs + r.maxLatencyMs + r.maxSkewMs < r.leaseMs/r.renewIntervalMs < r.leaseMs/|test/scenarios.test.ts"
  "BLAKE3 with one round fewer (D-5)|src/cache/blake3.ts|s/for (let r = 0; r < 7; r++)/for (let r = 0; r < 6; r++)/|test/cache/blake3.test.ts"
  # Third pass (rule H3): one source mutant per new law; each must be killed by the law's file.
  "decodeKey accepts components with lone surrogates (inverse round trip)|src/cache/keyEncoding.ts|s/if (c === null \(..\) !isWellFormed(c) .. !isNfc(c)) return null/if (c === null \1 !isNfc(c)) return null/|test/cache/keyLaws.test.ts"
  "publish accepts file/directory clashes (published iff restorable)|src/cache/publish.ts|s/if (!isTreeShaped(\[...seen\])) return yield\* /if (false) return yield* /|test/cache/publishLaws.test.ts"
  "heartbeat gives up one retry early (persistent 429 law)|src/cobuild.ts|s/if (now + rateLimitMs > held.manifest.expiresAt)/if (now + rateLimitMs >= held.manifest.expiresAt)/|test/laws.test.ts"
  "takeover allowed at the expiry instant (takeover threshold law)|src/lock.ts|s/return m.expiresAt < now/return m.expiresAt <= now/|test/laws.test.ts"
  "failure marker stale at failedAt + shelf (failure shelf-life law)|src/lock.ts|s/return m.outcome.failedAt + cfg.failureShelfMs < now/return m.outcome.failedAt + cfg.failureShelfMs <= now/|test/laws.test.ts"
  "a 429 on a conditional write is not retried (renewal schedule law)|src/lock.ts|s/schedule: Schedule.spaced(cfg.rateLimitMs),/schedule: Schedule.recurs(0),/|test/laws.test.ts"
  "breaker opens one bad observation early (run-length oracle)|src/cache/breaker.ts|s/cfg.threshold <= s.bad + 1 ?/cfg.threshold <= s.bad + 2 ?/|test/cache/policyLaws.test.ts"
  "deadline without its floor (clamp law)|src/cache/deadline.ts|s/return Math.max(Duration.toMillis(policy.floor), capped)/return capped/|test/cache/policyLaws.test.ts"
  "telemetry counts redeliveries (idempotent-count law)|src/cache/telemetry.ts|s/if (this.seen.has(eventId)) return false/if (false) return false/|test/cache/policyLaws.test.ts"
  # Bayesian bisection (test/bisect): one source mutant per law.
  "expected entropy prefix off by one (O(n) = O(n^2) oracle)|src/bisect/engine.ts|s/const z = zNew\[c + 1\]! + (zOld\[n\]! - zOld\[c + 1\]!)/const z = zNew[c]! + (zOld[n]! - zOld[c]!)/|test/bisect"
  "tested commit counted on the old side of its own hypothesis (chain rule)|src/bisect/model.ts|s/^      index >= b$/      index > b/|test/bisect"
  "rising factorial off by one (Beta marginal = integral)|src/bisect/model.ts|s/s += Math.log(x + j)/s += Math.log(x + j + 1)/|test/bisect"
  "Beta predictive ignores passes (predictive = marginal ratio)|src/bisect/model.ts|s/(r.alpha + f) \/ (r.alpha + r.beta + f + s)/(r.alpha + f) \/ (r.alpha + r.beta + f)/|test/bisect"
  "selection ignores the expected entropy (minimiser law)|src/bisect/engine.ts|s/if (!exclude.has(c) \&\& e\[c\]! < min) min = e\[c\]!/if (!exclude.has(c) \&\& e[c]! > min) min = e[c]!/|test/bisect"
  "good commit = oldest of its first page (proposal bug)|src/bisect/artifacts.ts|s/() => repo.log({ ref, limit: 1 })/() => repo.log({ ref, limit: LOG_PAGE_LIMIT }).then((p) => p.slice(-1))/|test/bisect"
  "commit range stops after the first page|src/bisect/artifacts.ts|s/if (page.length < LOG_PAGE_LIMIT) {/if (true) {/|test/bisect"
  # Bisection over Artifacts, sessions, Worker routes, local runner (test/bisect, test/worker).
  "withRepo never disposes the repository handle (A3)|src/bisect/artifactsApi.ts|s/^        disposeRepo(repo)$/        void repo/|test/bisect/artifacts.test.ts"
  "REST client retries non-retriable errors (A6)|src/bisect/artifactsRest.ts|s/Schedule.while(({ input }) => input._tag === \"ArtifactsApiError\" \&\& input.retriable)/Schedule.while(() => true)/|test/bisect/artifacts.test.ts"
  "REST client ignores Retry-After (A6)|src/bisect/artifactsRest.ts|s/if (Number.isFinite(s) \&\& s >= 0) return Duration.seconds(s)/void s/|test/bisect/artifacts.test.ts"
  "session proposes skipped commits (S4)|src/bisect/session.ts|s/const exclude = s.oldRate.kind === \"known\" ? new Set(\[...skipped, 0\]) : skipped/const exclude = new Set<number>()/|test/bisect/session.test.ts"
  "undo drops the oldest event instead of the newest (S3)|src/bisect/session.ts|s/events: s.events.slice(0, -1)/events: s.events.slice(1)/|test/bisect/session.test.ts"
  "session writes ignore the compare-and-swap result (S8)|src/bisect/session.ts|s/if (yield\* store.update(id, next, cur.version)) return next/yield* store.update(id, next, cur.version); return next/|test/bisect/session.test.ts"
  "Worker mints write tokens for runners (W3)|src/worker/bisectRoutes.ts|s/checkoutCredentials(h, \"read\"/checkoutCredentials(h, \"write\"/|test/worker/bisect.test.ts"
  "R2 session create is unconditional (W5)|src/worker/bisectStore.ts|s/onlyIf: new Headers({ \"If-None-Match\": \"\*\" }),//|test/worker/bisect.test.ts"
  "exit status 125 is not a skip (G2)|src/bisect/localGit.ts|s/if (r.code === 125) return \"skip\"//|test/bisect/cli.test.ts"
  # Worker state API (test/worker): contract law, pagination, decoding.
  "Worker lists the proposal's v1/lock/ prefix|src/worker/handler.ts|s/prefix = encodeKey(\[cfg.scope, lockPrefix, context\])/prefix = \"v1\/lock\/\" + context/|test/worker"
  "Worker joins the lock prefix naively (context prefix leak)|src/worker/handler.ts|s/prefix = encodeKey(\[cfg.scope, lockPrefix, context\])/prefix = \`v1\/\${cfg.scope}\/\${lockPrefix}\/\${context}\`/|test/worker"
  "Worker ignores the list cursor|src/worker/handler.ts|s/if (!page.truncated) return/if (true) return/|test/worker"
  "Worker treats every key under the context as a lock|src/worker/handler.ts|s/parts.length !== 5 .. parts\[4\] !== \"lock\"/parts.length !== 5/|test/worker"
  "Worker flags a lease expired at its expiry instant|src/worker/handler.ts|s/m.expiresAt < now/m.expiresAt <= now/|test/worker"
  "Worker counts manifests under k/ (proposal)|src/worker/handler.ts|s/encodeKey(\[cfg.scope, \"m\"\])/encodeKey([cfg.scope, \"k\"])/|test/worker"
  # Cobuild job runner (test/demo): scheduling, lock keys, failure propagation.
  "runner ignores dependencies (proposal: list order)|src/demo/runner.ts|s/byName.get(n)!.deps.every(isDone))/true)/|test/demo"
  "runner locks by operation name (proposal)|src/demo/runner.ts|s/const lockKey = CacheKey(formatDigest(lookup))/const lockKey = CacheKey(name)/|test/demo"
  "runner does not skip dependents of failures|src/demo/runner.ts|s/const bad = byName.get(name)!.deps.find(isBad)/const bad = [""].find(() => false)/|test/demo"
  # R2 review (docs/r2-end-to-end-review.md): reconciliation, adapters, local bucket, CLI staging.
  "lock adopts any version with its nonce (owner not checked)|src/lock.ts|s/stored.owner === written.owner \&\& stored.nonce === written.nonce/stored.nonce === written.nonce/|test/laws.test.ts"
  "a 412 or 429 on a write whose earlier attempt was applied is final (R2-3)|src/lock.ts|s/if (err._tag !== \"StoreFailure\") {/if (err._tag !== \"StoreFailure\") { return Effect.fail(err)/|test/scenarios.test.ts"
  "R2 lock client keeps the SDK retries|src/r2Client.ts|s/maxAttempts: 1/maxAttempts: 3/|test/r2Adapters.test.ts"
  "R2 lock create without If-None-Match|src/r2Store.ts|s/put(key, body, { IfNoneMatch: \"\\*\" })/put(key, body, { IfMatch: \"\\*\" })/|test/r2Adapters.test.ts"
  "fs bucket create-only overwrites|src/fsBucket.ts|s/if (meta !== null) throw new Rejected(\"precondition\")//|test/fsBucket.test.ts"
  "fs bucket CAS ignores the ETag|src/fsBucket.ts|s/meta === null .. meta.etag !== etag/meta === null/|test/fsBucket.test.ts"
  "fs bucket without the per-key rate limit|src/fsBucket.ts|s/meta.lastWriteMs + rateLimitMs <= now()/true/|test/fsBucket.test.ts"
  "restore may write outside the declared outputs|src/cli/workspace.ts|s/!isSafeRelativePath(rel) .. !inRoots(rel)/!isSafeRelativePath(rel)/|test/cli/workspace.test.ts"
  "duplicate outputs accepted|src/cli/workspace.ts|s/if (i !== j \&\& (pa === pb/if (i !== j \&\& i < 0 \&\& (pa === pb/|test/cli/workspace.test.ts"
  "key components are not checked for NFC (R2 normalizes key names)|src/cache/keyEncoding.ts|s/if (!isWellFormed(c) .. !isNfc(c)) throw/if (!isWellFormed(c)) throw/|test/cache/keys.test.ts"
  # Option A+ (docs/option-a-plus-plan.md): request timeouts, Worker roles, live feed.
  "request timeout one millisecond late (T1 deadline)|src/storeTimeout.ts|s/duration: limitDuration,/duration: Duration.sum(limitDuration, Duration.millis(1)),/|test/storeTimeout.test.ts"
  "timed-out write reported as a lost race (T5: renewal stays retryable)|src/storeTimeout.ts|s/orElse: () => Effect.fail(new StoreFailure({ key, cause: new RequestTimeout({ operation, key, timeout: limitDuration }) }))/orElse: () => Effect.fail(new PreconditionFailed({ key }))/;s/import { type ObjectStore, StoreFailure } from/import { type ObjectStore, PreconditionFailed, StoreFailure } from/|test/storeTimeout.test.ts"
  "read token opens the bisect routes (roles)|src/worker/handler.ts|s/have === \"write\" .. need === \"read\"/true/|test/worker/observability.test.ts"
  "/api/bisect is a read route (roles)|src/worker/handler.ts|s/? \"write\" : \"read\")/? \"read\" : \"read\")/|test/worker/observability.test.ts"
  "live feed misses re-acquisitions by the same job (TAKEOVER rule)|../tui/src/liveFeed.ts|s/next.owner !== prev.owner .. next.acquiredAt !== prev.acquiredAt/next.owner !== prev.owner/|test/worker/liveFeedContract.test.ts"
  "live feed labels the cost panel LIVE (provenance)|../tui/src/liveFeed.ts|s/  cost: \"DEMO\",/  cost: \"LIVE\",/|test/worker/liveFeedContract.test.ts"
  # Effect v4 refactor (docs/effect-v4-refactor.md): metrics, digest cache, restore deadline.
  # (The two facade-adapter mutants were retired at the cut-over: src/fx now re-exports effect@4 unchanged.)
  "restore deadline decided by the timer race, not the clock (D-11 threshold)|src/cache/restore.ts|s/if ((yield\* Clock.currentTimeMillis) > deadlineAt) return yield\* missOf(\"restore_deadline\", scope)/void deadlineAt/|test/cache/publishRestore.test.ts"
  "runMain lets the event loop drain (SIGINT exits 0)|src/fx/runtime.ts|s/const keepAlive = setInterval(() => undefined, 2 \*\* 31 - 1)/const keepAlive = undefined/|test/cli/e2e.test.ts"
  "store latency timer skips failed requests (metrics law)|src/metrics.ts|s/trackDurationOfAnyExit(storeRequestDuration)$/Effect.trackDuration(storeRequestDuration)/|test/metrics.test.ts"
  "heartbeat does not count renewals (metrics law)|src/cobuild.ts|s/Effect.tap(() => bump(lockRenewals))/Effect.tap(() => Effect.void)/|test/metrics.test.ts"
  "input digest cache evicts every entry (read-once law)|src/cli/workspace.ts|s/capacity = 1_000_000/capacity = 0/|test/cli/digestCache.test.ts"
)

# MUTANT_FILTER=<regex> runs only the mutants whose name matches.
# MUTANT_APPLY_ONLY=1 only checks that every sed expression still changes its
# file (fast: no tests run). Use it after refactors that touch mutated lines.
survivors=0
for m in "${MUTANTS[@]}"; do
  IFS='|' read -r name file expr test <<<"$m"
  if [ -n "${MUTANT_FILTER:-}" ] && ! [[ "$name" =~ $MUTANT_FILTER ]]; then continue; fi
  cp "$file" "$file.orig"
  trap 'mv "$file.orig" "$file"; exit 130' INT TERM
  sed -i "$expr" "$file"
  if cmp -s "$file" "$file.orig"; then
    echo "ERROR    $name: the mutation did not apply (source changed?)"
    survivors=$((survivors + 1))
  elif [ -n "${MUTANT_APPLY_ONLY:-}" ]; then
    echo "applies  $name"
  elif out=$($VITEST "$test" 2>&1); then
    echo "SURVIVED $name ($(printf '%s\n' "$out" | grep -m1 -o 'FC_SEED=[-0-9]*'))"
    survivors=$((survivors + 1))
  else
    echo "killed   $name"
  fi
  mv "$file.orig" "$file"
  trap - INT TERM
done

if [ "$survivors" -ne 0 ]; then
  echo "$survivors mutant(s) not detected"
  exit 1
fi
if [ -n "${MUTANT_APPLY_ONLY:-}" ]; then
  echo "all selected mutants apply (${#MUTANTS[@]} defined; no tests run)"
else
  echo "all selected mutants detected (${#MUTANTS[@]} defined)"
fi
