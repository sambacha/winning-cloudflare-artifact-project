/**
 * Cloudflare resource names and URIs of the demo (illustrative: the account
 * id is a placeholder, so no URI shown here points at a real account).
 *
 * - R2: the bucket of `ts/wrangler.toml` (`cobuilds-demo`); objects are shown
 *   as `r2://<bucket>/<key>` and the bucket's S3 endpoint as
 *   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>`.
 * - Artifacts: every repo has a Git smart-HTTP remote
 *   `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
 *   (cloudflare-artifacts.md, "Git remotes"); a fork is a new repo, named
 *   here `<repo>-<fork id>`, created with
 *   `POST /artifacts/namespaces/<namespace>/repos/<repo>/fork`.
 */

export const CLOUDFLARE = {
  account: "<ACCOUNT_ID>",
  bucket: "cobuilds-demo",
  namespace: "default",
  repo: "fame-xga",
  lockPrefix: "v1/lock/ctx/"
} as const

/** R2 key of an operation's lease lock (`op:build-core` → `v1/lock/ctx/build-core`). */
export const lockKey = (op: string): string => `${CLOUDFLARE.lockPrefix}${op.replace(/^op:/, "")}`

/** `r2://<bucket>/<key>`. */
export const r2Uri = (key: string): string => `r2://${CLOUDFLARE.bucket}/${key}`

/** The bucket's S3-compatible endpoint. */
export const r2Endpoint = (): string => `https://${CLOUDFLARE.account}.r2.cloudflarestorage.com/${CLOUDFLARE.bucket}`

/** Artifacts repo of a fork. */
export const forkRepo = (fork: string): string => `${CLOUDFLARE.repo}-${fork}`

/** Git remote of an Artifacts repo. */
export const artifactsRemote = (repo: string): string => `https://${CLOUDFLARE.account}.artifacts.cloudflare.net/git/${CLOUDFLARE.namespace}/${repo}.git`

/** REST route that forks the trunk repo. */
export const forkRoute = (): string => `/artifacts/namespaces/${CLOUDFLARE.namespace}/repos/${CLOUDFLARE.repo}/fork`
