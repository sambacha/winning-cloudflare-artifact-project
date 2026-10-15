# Repository scripts

| Script | Purpose |
|---|---|
| `fix-open-issues.sh` | Closes the open deployment issues (see `docs/project-status-and-demo-guide.md` §6.3). Run it on a machine with network access; the Cloudflare steps also need an account. |
| `record-demos.sh` | Records every demo, one video per segment, and checks each recording's transcript. With `--concat`, joins the videos into one file. |
| `demo-cobuild.sh` | The three-leg cobuild (demo A) in one terminal, in one of three scenarios: `clean`, `takeover` or `failure`. `record-demos.sh` runs it; you can also run it by hand. |

## `fix-open-issues.sh`

```bash
bash scripts/fix-open-issues.sh --dry-run     # show what would run; changes nothing
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=cobuilds-demo
export ARTIFACTS_NAMESPACE=…                  # your Cloudflare Artifacts namespace
bash scripts/fix-open-issues.sh --commit      # run every step, then commit the repository changes
```

The steps run in this order. Each one can be run again safely. Choose steps with `--only` or `--skip`, for example `--only deps,types,checks`.

| Step | Open issue it closes |
|---|---|
| `deps` | Adds `@cloudflare/sandbox` (exact version) and `wrangler@^4.145.0` to `ts/package.json` and the lockfile. Gives `ts/Dockerfile` the same Sandbox image tag as the SDK. Then checks that `npm ci` works in a fresh directory. |
| `types` | Runs `wrangler types` and removes the hand-written stand-in `ts/src/workers/cloudflare-modules.d.ts`. Then type-checks `edge.ts` against the real types. If that check fails, the stand-in is put back and the errors are saved to `ts/.fix-logs/types.log`. |
| `config` | Fills in the `wrangler.toml` placeholders: `bucket_name` and the Artifacts `namespace`. |
| `bucket` | Creates the bucket if it is missing, applies `ts/r2-lifecycle.json`, and reads the rules back. |
| `live` | `npm run test:r2-live`: the R2 adapter tests that have never run. |
| `cobuild` | `demo-cobuild.sh --store r2`: three real legs against real R2. |
| `queue` | Creates the push-event queue and tries to create the `cf.artifacts.repo.pushed` subscription. If wrangler does not accept that command, the script prints where to create it in the dashboard instead. |
| `deploy` | `npm run deploy`. Needs Docker running, to build the Sandbox container image. |
| `secrets` | Sets `API_TOKEN` (and `BISECT_API_TOKEN` if given). If no token is supplied, one is generated and saved to `ts/.fix-logs/api-token`. |
| `verify` | Checks that `/healthz` answers `{"status":"ok"}`, `/api/locks` answers 200 with the token, and 401/403 without it. |
| `checks` | Lockfile check, `tsc`, the edge type check and the deploy-script test. Add `--full-tests` for the full `ts/` and `tui/` suites. |

If a step's inputs are missing, it is reported as SKIP. Logs and `report.md` go to `ts/.fix-logs/`, which Git ignores.

Three open items need code or design work and no script can close them:
- integrating into Rush itself;
- a separate rebuild mode;
- the timing sensitivity of `test/bisectAcceptance.test.ts` under heavy load.

## `record-demos.sh`

```bash
bash scripts/record-demos.sh --rehearse       # run each segment here, no recording, and check it
bash scripts/record-demos.sh                  # record with VHS (falls back to asciinema, then script(1))
bash scripts/record-demos.sh --concat         # also write recordings/full-demo.mp4
bash scripts/record-demos.sh --store r2       # demo A against real R2 (after fix-open-issues.sh)
```

The segments, in film order:

| Segment | What it shows | Pass condition |
|---|---|---|
| `proof` | The Lean axiom audit | `axiom audit: N theorems … 0 violations` |
| `cobuild-clean` | Three legs share a 7-operation plan; the lock status; a rerun | Every operation is built by exactly one leg, and the rerun is all cache hits |
| `cobuild-takeover` | Ctrl-C on one leg mid-build | Another leg takes over, and the rerun restores everything |
| `cobuild-failure` | One package fails | It fails once; the other legs reuse the failure |
| `bisect` | Bayesian bisection with a flaky test, run twice | The culprit is found; the second run replays and re-runs nothing |
| `tui` | The scripted dashboard (uses `tui/scripts/record-demo.sh`) | Its own checks (two identical takes) |

Output goes to `recordings/`, which Git ignores:
- with VHS: `<segment>.mp4`, `.gif` and `.txt`;
- with asciinema: `<segment>.cast`;
- with `script(1)`: `<segment>.log`.

`--tapes-only` writes the VHS tapes so you can edit them before recording.

The captions follow the guide's honesty rules (§3.5):
- `fs:` runs are labelled as a local store with R2 write rules, not Cloudflare;
- the Lean proofs are described as covering a model of R2;
- the dashboard is labelled as illustrative data.
