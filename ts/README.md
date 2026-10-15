# R2 cobuild lock and CI cache client (TypeScript, Effect v4 API over the installed Effect 3)

Effect is imported only through the facade in `src/fx/` (v4 names over the
installed `effect@3`); see `docs/effect-v4-refactor.md`.

Two parts:

- the cobuild lock (`src/lock.ts`, `src/cobuild.ts`), described below;
- the CI cache client (`src/cache/`), which implements the P\*/S\* path plan
  as corrected in `docs/cache-path-review.md`: scope-first escaped keys,
  tagged BLAKE3 digests, Merkle lookup keys, blobs-then-manifest publishing,
  client-side streaming verification with staging, restore deadline, circuit
  breaker, idempotent telemetry. See "Cache client" at the end.

## Cobuild lock

This is a corrected version of the Effect.ts `CobuildLock` sketch reviewed in
`docs/critique-response.md` (Part 3), plus corrected fast-check tests (Part 2).
It implements the protocol verified in Lean in `RequestProject/Cobuilds`.

The original sketch was not in this project, so the API was rebuilt from the
review. Names follow the sketch where the review mentions them (`acquire`,
`renew`, `markCompleted`, `stealExpiredLock`, `release`).

```
npm ci                 # or restore node_modules from the R2 cache: node dist/nodeModules/bin.js ensure
npm run typecheck      # tsc --strict, no errors
npm test               # vitest: 478 tests in 48 files (+5 skipped without R2 credentials), fresh random seed on every run
npm run mutation       # 66 source mutants, all must be detected
npm run test:bench     # the node_modules restore-time benchmark (< 3 s), run on its own
npm run demo           # offline demo: build, bisect the demo monorepo, replay, dashboard frame
FC_SEED=<n> npm test -- <file>   # replay a run: the seed is printed by every test file
```

`node_modules` is not committed (`ts/.gitignore`); the repository uses npm
and `package-lock.json`. The node_modules cache, the durable bisect
(Workflows + Sandbox SDK), the CI workflow and the Ink dashboard are
described in `docs/feature-slice-report.md`.

Every randomized test prints its seed, a replay command, the generator's
domain and `total / valid / boundary` counts. It fails when there is a
counterexample, **or** when too few cases exercised the law (valid fraction),
**or** when too few cases were on a boundary. See `docs/test-review.md`.

## Files

| File | Contents |
|---|---|
| `src/store.ts` | `ObjectStore`: the three R2 calls used (`PutObject` with `If-None-Match: *`, `PutObject` with `If-Match`, `GetObject`) and the errors `PreconditionFailed` (412), `RateLimited` (429), `StoreFailure`. |
| `src/r2Store.ts` | `ObjectStore` on R2's S3 API (`@aws-sdk/client-s3`). Type-checked only; not run against R2. |
| `src/fx/` | The Effect facade: the only place that imports `effect`; v4 names over the installed v3 (`docs/effect-v4-refactor.md`). |
| `src/metrics.ts` | Cobuild metrics (store requests and latency, lock outcomes, renewals, lost locks, build outcomes and duration, input files hashed). |
| `src/ids.ts`, `src/secrets.ts` | Branded identifiers (`JobId`, `CacheKey`, `SessionId`, `CommitOid`); secrets kept `Redacted` until used. |
| `src/memoryStore.ts` | In-memory R2 with the semantics of the Lean `Bucket`: atomic calls, a fresh ETag per write, 1 write per key per second. |
| `src/lock.ts` | `makeCobuildLock`: `acquire` (create, or take over a stealable manifest), `renewOnce`, `markCompleted`, `abandon`. |
| `src/cobuild.ts` | `runCobuild`: acquire, heartbeat while building, upload, publish. |
| `test/harness.ts` | Shared harness: fresh or pinned seed (`FC_SEED`), replay command, counting runs (`law`), mutant checks, asserted replay. |
| `test/laws.test.ts` | General laws of the cobuild runtime on random inputs: renewal schedule, failure shelf life, takeover threshold and fencing, persistent 429 (sound and tight), abandon, 412, configuration predicate against a BigInt oracle, injected nonce source. |
| `test/scenarios.test.ts` | Deterministic runs with `TestClock`, one per review item / Lean result. Labelled regressions for the laws above. |
| `test/properties.test.ts` | fast-check (fresh seed, replay asserted): random interleavings of 3 jobs on 2 keys, with and without clock skew; coverage test; mutation adequacy. |
| `test/mutantStore.ts` | Planted R2 mutants for the mutation-adequacy test. |

## What was fixed

| Review item | Fix | Test |
|---|---|---|
| 1. `release` after `markCompleted` deleted the `succeeded` marker, causing a rebuild (`delete_after_success_rebuilds`) | `runCobuild` never releases after publishing; publishing ends the lease. There is no `DeleteObject` at all (see item 5). | "a 35 s build renews three times …": B gets `completed`, also one hour later |
| 2. `renew` and `stealExpiredLock` kept the old ETag, so the second renewal got 412 | Every successful write returns a new `HeldLock` with the ETag R2 returned. The takeover in `acquire` returns the new ETag too. | "two consecutive renewals succeed …"; "a crashed holder's lock is taken over …" |
| 3. `markCompleted` used the acquisition's manifest | The heartbeat keeps the latest `HeldLock` in a `Ref`. Each renewal and its `Ref.set` run uninterruptibly. The heartbeat is stopped before publishing, and the publish reads the `Ref`. A `429` right after the last renewal is retried after 1 s. | "a 35 s build …" (writes at 0, 10, 20, 30, 35 s); "a publish 500 ms after a renewal gets 429 …" (publish accepted at 31.5 s) |
| 4. Failure shelf life measured from `acquiredAt` | Failure markers store `failedAt` (publish time) and the shelf life counts from it. | "a failed build publishes a failure marker …" (build longer than the shelf life) |
| 5. `clockSkewMargin = 500` was an unchecked assumption | Giving up a lock (`abandon`) is a CAS write that marks the lease expired, not a `DeleteObject`. Every write is fenced by an ETag, so safety does not depend on clocks (`Skew.stale_cas_rejected`, `sinv_renew`, `sinv_publish`, `sinv_steal`). No skew margin is needed. | "abandon makes the lock stealable at once …"; skewed-clock property |
| 6. The retry policy retried 412 | Retries use `while: RateLimited or StoreFailure`. 412 becomes `LockLost` and is never retried. | "412 is not retried" (exactly one request) |
| 7. The heartbeat died on 429 and renewed immediately after acquiring | The first renewal comes one interval after acquiring. `429` and transient errors are retried every second while the lease would still be valid. Otherwise the heartbeat signals `LockLost` and the build is interrupted. | "persistent 429 on renewals …" |
| 8. `try/catch` inside `Effect.gen` did not see build failures | The build result is observed with `Effect.exit`. A failure publishes the failure marker. An upload failure never publishes success (`publish_before_upload_incoherent`): it abandons the lock and returns the error. If the caller is interrupted, the lock is abandoned. | "a failed build …"; "an upload failure never publishes success …" |
| 9. `pending` lacked fields required by `LockState` | `LockState` is a discriminated union whose `pending` case carries `owner` and `expiresAt` (or `null` if unknown). | type-checked |

Additional hardening:
- Every manifest version carries a fresh `nonce`, so two versions never have the same content even if the ETag is a content hash (`content_etag_aba_breaks_mutex`).
- When a conditional write fails with a network error, the client re-reads the object. If its nonce is there, the write happened and the client adopts the new ETag. If the old ETag is still there, the write did not happen and may be retried. Otherwise the lock was lost. Test: "a renewal whose response was lost is recognised by its nonce".
- Object keys are `v1/<scope>/cobuild/<context>/<cacheKey>/lock/` with the
  escaped encoding of `src/cache/keyEncoding.ts`: distinct (scope, context,
  key) triples never collide, and the trust scope (mandatory) keeps jobs of
  different trust levels from sharing a lock or a result pointer (D-1).
- The config is checked (D-10, `checkCobuildConfig`): `rateLimitMs ≤
  renewIntervalMs` and `renewIntervalMs + maxLatencyMs + maxSkewMs <
  leaseMs` (defaults: 2 s latency, 1 s skew). The previous check,
  `renewIntervalMs < leaseMs`, accepted a 29 999 ms heartbeat for a 30 s lease.

## Property tests (fixing the fast-check sketch)

`test/properties.test.ts` generates one interleaved command list for three jobs on
two keys: `acquire`, `renew`, `publish` (success or failure), `abandon`, and `tick`
of 0–12 s. Time is virtual: R2 has the true clock and each job reads it plus an
offset. After every step it checks:

- **Mutual exclusion** (one clock): at most one job holds an unexpired lease
  (`now ≤ expiresAt`) on a key, and that job's ETag is the current object's ETag
  (`mutual_exclusion`).
- **No rebuild after success**: once a manifest is `succeeded` it never changes,
  and no `acquire` returns `obtained` for it (`no_duplicate_builds`).
- **Rate limit**: writes R2 accepted for a key are at least 1 s apart, measured
  on R2's clock (`rate_limit_compliance`).

The second property runs the same checks, except mutual exclusion of beliefs, with
job clocks off by up to ±20 s. With skewed clocks two jobs can both *believe*
they hold a lock (`skew_margin_tight`), but the R2 state stays safe.

The tests follow `docs/testing-guidelines.md` and were audited in
`docs/test-audit.md` and then again in `docs/test-review.md` (rules H1–H8).
The fixed seeds of the first audit were replaced by fresh seeds with replay
(`FC_SEED`). Replay is itself an asserted property, and a mutant with a hidden
random nonce must break it. The general laws behind the scenarios are in
`test/laws.test.ts`. In addition:
the coverage test asserts that takeovers, 429s, rejected stale writes,
`completed` answers and two-believer states each occur at least 7 times over
the 500 seeded runs; the mutation-adequacy test runs the property against
planted R2 mutants (`test/mutantStore.ts`): ignoring `If-None-Match`,
ignoring `If-Match`, and no rate limit must each be detected, while stale
reads (harmless, because every write is fenced by an ETag) must not be.

The audit found that the previous property tests generated at most 10
commands per run (fast-check's default size), so takeovers and stale writes
never occurred and the `If-Match` mutant went undetected. The command list now
uses `size: "max"`.

## CLI quick start (`cobuild`)

```
npm ci && npm run build
# shared store: R2 (R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID or R2_ENDPOINT)
# or a directory with R2 semantics for local runs: --store fs:/tmp/cobuild-store
export RUSH_COBUILD_CONTEXT=$BUILD_ID
export RUSH_COBUILD_ENABLED=1        # cobuilds are opt-in (unset: build locally, cache only)
export COBUILD_SCOPE=trusted         # required, no default: "trusted" only for protected-branch builds
node dist/cli/bin.js run --plan examples/cobuild.json --job primary --op-timeout-ms 1800000   # run once per CI leg
node dist/cli/bin.js status --context "$RUSH_COBUILD_CONTEXT"
node dist/cli/bin.js cache save --name deps --path node_modules --hash-files package-lock.json
node dist/cli/bin.js cache restore --name deps --path node_modules --hash-files package-lock.json
COBUILDS_API_TOKEN=… node dist/cli/bin.js serve --port 8787   # Worker API locally, for `tui --live`
node dist/cli/bin.js artifacts publish --repo NAME --file summary.json
```

See `examples/github-actions/cobuild.yml` and `docs/r2-end-to-end-review.md`
(what runs end to end, and what still needs real credentials).

Operational rules (see `docs/production-hardening.md`):

- Build commands run without `R2_*`, `CLOUDFLARE_*`, `AWS_*`,
  `COBUILDS_API_TOKEN`, `BAYESECT_API_TOKEN` and `API_TOKEN` in their
  environment; list more names in `COBUILD_STRIP_ENV=A,B`.
- Each command runs in its own process group. `--op-timeout-ms` (or
  `timeoutMs` on a plan operation) kills the whole group and fails the
  operation; a lost lease or an interrupt also kills the group.
- SIGINT/SIGTERM abandons held locks before exiting (status 130), so the
  other legs take over at once instead of waiting out the lease.
- `--max-skew-ms` and `--failure-shelf-ms` complete the lease parameters.
- Numeric environment variables are validated (`COBUILD_FS_RATE_LIMIT_MS`
  must be a non-negative integer); invalid values exit with status 2.

## Limits

- Nothing has been run against real R2, a deployed Worker or the Artifacts
  API. The protocol runs across real processes on the `fs:` store (R2
  semantics) and in memory; the S3 adapters are unit-tested with a stubbed
  client. `npm run test:r2-live` checks them against a real bucket. In
  particular, check how R2 orders the rate-limit and precondition checks, and
  whether R2 returns 409 for racing conditional writes.
- These are tests, not proofs. The guarantees proved in Lean are about the
  model in `RequestProject/Cobuilds`. This code follows that model step by step,
  but nothing formally connects the TypeScript to it.
- Scheduling of pending operations (steps 5–6 of the design: cycling through
  pending operations and polling) is done by the runner in `src/demo/runner.ts`
  (used by `cobuild run`), which polls pending locks with plain reads
  (`lock.inspect`). `runCobuild` alone still returns `Pending` to its caller.

## Cache client (`src/cache/`)

| File | Contents | Decision |
|---|---|---|
| `blake3.ts`, `digest.ts` | pure-TS incremental BLAKE3; `blake3:<hex>` digests, length-agnostic parsing | D-5 |
| `keyEncoding.ts` | `v1/` + escaped, `/`-terminated components; rejects keys over 1024 bytes and lone surrogates | D-4 |
| `scope.ts` | trust scopes; read order (trusted first) and write rule (own scope only) | D-1 |
| `lookupKey.ts` | Merkle lookup digests over a dependency DAG (salt, toolchain, inputs, dependency digests); manifest and blob keys | D-2 |
| `manifest.ts` | manifest schema (safe relative paths, unique paths, `buildMs`, per-blob encoding) | D-3 |
| `blobStore.ts`, `r2BlobStore.ts` | create-only writes and streamed reads; in-memory store with fault injection; R2 adapter (type-checked only) | — |
| `publish.ts` | blobs (create-only, concurrent), then one create-only manifest | D-3 |
| `restore.ts`, `staging.ts` | manifest lookup with its own deadline; streaming digest + size check; staging with atomic swap (memory and filesystem); every failure is a miss | D-7, D-11 |
| `deadline.ts` | `costTimeout` (as in Lean), `restoreDeadlineMs`, competitive ratio | D-11 |
| `breaker.ts` | Lean's `probeStep` as a transition function | D-12 |
| `telemetry.ts`, `client.ts` | idempotent counters, outcome reports; the client wiring breaker, deadline and reports | D-14 |

Tests: `test/cache/blake3.test.ts`, `keys.test.ts`, `keyLaws.test.ts`,
`publishRestore.test.ts`, `publishLaws.test.ts`, `policies.test.ts`,
`policyLaws.test.ts`. The `*Laws` files hold the general laws (inverse round
trips, independent oracles, tightness, boundary generators). The other files
keep their hand-written examples as labelled regressions. The laws found two
bugs, both fixed: `decodeKey` accepted over-long keys and lone surrogates, and
`publish` accepted file/directory clashes that could never be restored. Each property is paired with a mutant that must fail it;
`scripts/mutation-check.sh` additionally mutates the source itself. The
business assertions and the reflection on each fix are in
`docs/cache-path-review.md`.
