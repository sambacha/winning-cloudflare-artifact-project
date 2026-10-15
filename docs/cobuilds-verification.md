# Cobuilds on Cloudflare R2: what was verified

The Lean development in `RequestProject/Cobuilds/` models the cooperative-build
lock protocol running on R2 and proves its properties. Everything listed as
*proved* builds with no `sorry` and depends only on the standard axioms
(`propext`, `Classical.choice`, `Quot.sound`). The layout follows
`STYLEGUIDE.md`.

Follow-up work answering the critique and gap analysis (clock skew, fencing,
build-graph composition, and the critique's per-property conjectures,
counterexamples and negations) is described in `docs/critique-response.md`.

## 1. The model

**R2** (`R2.lean`). Each API call is one atomic transition of the bucket:

| Call | Model |
|---|---|
| `PutObject` + `If-None-Match: *` | `putIfNoneMatch`: `ok` if the key is absent, else `412` |
| `PutObject` + `If-Match: e` | `putIfMatch`: `ok` if the current ETag is `e`, else `412` |
| `DeleteObject` | `deleteObject` (unconditional) |
| `GetObject` | `getObject` returns the current object |
| 1 write per key per second | a write less than `rateMs` after the previous successful write to the key gets `429` and has no effect |
| ETags | every successful write gets a fresh ETag (`nextETag`) |

These R2 properties are **modelling assumptions written as definitions**.
The handoff's three `axiom`s are not used. I took the R2 behaviour from the
handoff itself and did not check it against Cloudflare's documentation. Its
citation markers (for example `【turn4fetch1】`) are not resolvable references.

**Protocol** (`Protocol/Defs.lean`). The global state is the bucket, one shared
clock, the build cache, and each job's local knowledge:

* `held`: the manifest version the job last wrote, i.e. the lock it believes it holds;
* `seen`: the manifest version it last read.

Each job step sends at most one R2 request and reacts to the response. Reads
and the conditional writes that depend on them are separate steps, so a job
can act on stale information. The steps are:

* `acquire`
* `read`
* `steal`: take over an expired lease, or a failure marker past its shelf life, by `If-Match` on the ETag the job read
* `renew`
* `upload`: write to the build cache
* `publish`: mark the manifest `succeeded` (only after `upload`) or `failed`; this is Approach 2, where the lock object carries the result pointer
* `release`
* `drop`
* `crash`
* `tick`

A job may renew, upload, publish or release only while its own lease is
valid on the clock (`Enabled`).

**Assumptions to keep in mind**

1. *One shared clock.* Application-level leases are only safe if the jobs'
   clocks agree. Real deployments need a safety margin for clock skew. The
   model does not include skew.
2. *Unique ETags.* R2's ETag for a single-part upload is a content hash. The
   manifest should include a nonce so that two writes never produce the same
   ETag; otherwise ABA becomes possible.
3. *Liveness needs fairness.* Nothing forces a job to act, so every liveness
   theorem states its assumption explicitly (a non-Zeno clock, or that the
   job stops renewing).

## 2. Results: handoff property → Lean theorem

The **safety** results hold for every run (`ValidTrace`) of the protocol.

| Handoff item | Lean | Status / remark |
|---|---|---|
| INV-1 mutual exclusion | `mutual_exclusion` (`Invariants/Safety.lean`) | proved. Taken literally (one owner field), INV-1 is trivial (`lockHeld_unique`). The real statement proved is that at most one job holds a **valid lease**, even with stale readers. |
| INV-2 no duplicate builds | `no_duplicate_builds` (`Invariants/History.lean`) | proved: after `succeeded`, the manifest never changes and nobody holds a lease again |
| INV-3 lease validity | `lease_validity` | proved in corrected form. The literal "`expiresAt − acquiredAt = 30 s`" is false after a renewal (`handoff_inv3_literal_false`). |
| INV-4 rate-limit compliance | `rate_limit_compliance` | proved in a meaningful form. The literal statement is vacuous. |
| INV-5 strong consistency | `strong_consistency_lock_state`, `strong_consistency_after_acquire`, `read_returns_current` | proved |
| INV-6 cache coherence | `cache_coherence` | proved: `succeeded` ⇒ the cache entry was uploaded |
| INV-7 owner monotonicity | `owner_monotonicity` (`Invariants/Authority.lean`) | proved: while a lease is valid, no other job's step changes the manifest |
| LEMMA-1 conditional put atomicity | `conditional_put_atomicity` (`Lemmas.lean`) | proved for sequential composition. The literal statement is false (`handoff_lemma1_literal_false`). |
| LEMMA-2 ETag uniqueness | `etag_no_reuse` | proved (no ABA) |
| LEMMA-3 expiry ⇒ availability | `lease_expiry_implies_availability`, `acquire_free` | proved: succeeds unless rate-limited |
| LEMMA-4 renewal interval | `renew_in_window`, `renewal_on_schedule`, `default_schedule_ok` | proved: renewing at any time in [heartbeat + 1 s, heartbeat + 30 s] succeeds, and 1 s ≤ 10 s ≤ 30 s |
| LEMMA-5 CAS without contention | `cas_no_contention` | proved |
| LEMMA-6 consistency preservation | `inv_step`, `Reachable.inv` | proved (the inductive invariant) |
| LEMMA-7 failed-build isolation | `publish_failure_keeps_cache`, `failed_does_not_poison_success` | proved |
| LEMMA-8 application-level TTL | `app_level_ttl_exact` | proved: "stealable" ⇔ "lease expired", and expiry = heartbeat + 30 s |
| THEOREM-1 safety | `cobuilds_safety` (`Theorems.lean`) | proved |
| THEOREM-2 liveness | `cobuilds_liveness` | proved for non-Zeno runs with expiry enabled |
| THEOREM-3 refinement | `refinement` (`Refinement.lean`) | proved: refines an abstract lock-and-result spec. That spec allows no stealing a held lock, no publishing without the lock, and nothing ever leaves `succeeded`. |
| THEOREM-4 lease management | `lease_management_correctness`, `lease_holding_bound` | proved. "No indefinite holding" is stated as "if the job stops extending its lease, it loses it within 30 s"; a job that keeps renewing may legitimately hold the lock forever. |
| THEOREM-5 failure recovery | `failure_recovery`, `eventual_lock_release` | proved, quantitatively: within 30 s of a crash, the crashed job has no valid lease and everything it left behind is stealable |
| LIVE-1 | `eventual_lock_release` | proved (non-Zeno clock) |
| LIVE-2 progress | `progress_unconditional_false` (`Negations.lean`) | false without fairness. One attempt suffices (`acquire_free`), and the rate limit always clears (`rate_limit_no_livelock`). |
| LIVE-3 eventual completion | `eventual_completion_unconditional_false` | false without fairness |
| LIVE-4 failure staleness | `failure_marker_persists_without_retry` | false as stated (R2 has no per-object TTL). Proved instead: the marker blocks retries for its whole shelf life (`failure_marker_blocks_retry`) and is stealable exactly afterwards (`failure_marker_stealable_iff`). |
| NEG-1 | `not_multiple_lock_holders`, `not_multiple_lease_holders` | proved |
| NEG-2 | `rate_limit_compliance` | proved |
| NEG-3 | `failed_does_not_poison_success` | proved |

### Counterexamples (each proved in Lean)

| Broken design | Lean | What goes wrong |
|---|---|---|
| CE-1: unconditional `PutObject` for acquisition | `unconditional_put_breaks_mutex` | two valid leases at once |
| CE-2: leases never expire | `no_expiry_blocks_forever` | in every run, a crashed holder blocks the key forever |
| CE-3: writing faster than 1/s | `rate_limit_violation`, `rate_limited_acquire_is_noop` | `429` with no effect |
| CE-4: conditional write checked against a stale replica | `stale_replica_breaks_mutex` | two valid leases at once |
| Extra: `DeleteObject` release without the lease check | `unguarded_release_breaks_mutex`, `beforeRelease_reachable`, `unguarded_release_not_enabled` | a job whose lease silently expired deletes the new owner's manifest, and a third job then acquires the key |

### Conjectures

* **CONJECTURE-2** (the rate limit causes no livelock): **proved** as
  `rate_limit_no_livelock` for non-Zeno runs.
* **CONJECTURE-3** (strong consistency is necessary): **shown by
  counterexample** (`stale_replica_breaks_mutex`). The precise requirement is
  that conditional writes are linearizable. The safety proof does not need
  fresh *reads*: a stale read only causes a failed `If-Match`.
* **CONJECTURE-1** (30 s / 10 s is optimal) and **CONJECTURE-4** (Approach 2
  is better than Approach 1): **not formalized**. The handoff defines no cost
  model (`WastedWork`, `FailureRecoveryTime`), and inventing one would make
  the statement arbitrary. Related facts that are proved: recovery after a
  crash is bounded by one lease duration (`failure_recovery`), and with
  Approach 2 a published failure prevents any rebuild for its shelf life
  (`failure_marker_blocks_retry`).

## 3. Findings relevant to the implementation

1. **Release must check the lease, or be avoided.** R2's `DeleteObject` is
   unconditional. A job whose lease expired without it noticing (GC pause,
   slow network) can delete the next owner's lock (`UnguardedRelease`). Safe
   options: delete only while the local lease is valid with a skew margin
   (this is what the model proves safe), or never delete and let leases
   expire.
2. **Take over expired locks with `If-Match`, never `If-None-Match`.** An
   expired manifest still exists, so `If-None-Match: *` fails. The takeover
   must be a compare-and-swap on the ETag that was read. This is what the
   design's TypeScript sketch does; note that it uses an undefined
   `updatedManifest`.
3. **The rate limit applies to the lock holder too.** A `renew` or `publish`
   less than 1 s after the job's own previous write gets `429`. For example,
   publishing immediately after acquiring fails; the concrete run in
   `Negations.lean` had to wait a second. Clients must retry on `429`.
   `renew_in_window` gives the window in which renewal is guaranteed to
   succeed.
4. **Without retries, failure markers stay forever.** The 30-minute shelf
   life only makes the marker stealable. Removing it needs a later build or
   a cleanup job.
