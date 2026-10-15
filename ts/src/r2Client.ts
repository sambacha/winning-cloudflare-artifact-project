/**
 * Connecting to Cloudflare R2 through its S3-compatible API.
 *
 * R2 settings that matter for the cobuild (see `docs/r2-end-to-end-review.md`):
 *
 * - endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (or the
 *   jurisdiction form `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`),
 *   region `auto`;
 * - credentials are an R2 API token's S3 access key id / secret
 *   (Object Read & Write on the bucket);
 * - `requestChecksumCalculation` / `responseChecksumValidation` =
 *   `WHEN_REQUIRED`: recent AWS SDK versions add CRC checksums to every
 *   request by default. That default is not needed by R2 and has caused
 *   incompatibilities with S3-compatible services, so checksums are sent only
 *   when an operation requires them. Blob integrity is checked end to end by
 *   the cache client anyway (BLAKE3 digest verified on restore);
 * - the **lock** client is built with `maxAttempts: 1`. The SDK's own retry
 *   would resend a conditional `PutObject` whose first attempt may already
 *   have been applied; the resend then gets `412`/`429` and would look like
 *   a lost lock. The lock does its own retrying and reconciles ambiguous
 *   outcomes by reading back its nonce (`lock.ts`, `ownWrite`). The blob
 *   client keeps the SDK's retries: blob writes are create-only and
 *   content-addressed, so a duplicate attempt is harmless.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import type { R2BucketLike } from "./worker/r2Bucket.js"
import { Data, type Redacted } from "./fx/index.js"
import { reveal, secretFromConfig } from "./secrets.js"

/**
 * An R2 connection. The access key id and secret are `Redacted` (decoded
 * through `Schema.RedactedFromValue` in {@link r2ConfigFromEnv}) and are
 * unwrapped only when the S3 client is built ({@link r2ClientOptions}).
 */
export interface R2Config {
  readonly endpoint: string
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly bucket: string
}

export class R2ConfigError extends Data.TaggedError("R2ConfigError")<{ readonly message: string }> {
  override readonly name = "R2ConfigError"
  /** @param message - Human-readable description. */
  constructor(message: string) {
    super({ message })
  }
}

/**
 * Read the R2 connection from environment variables:
 *
 *   R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and either
 *   R2_ENDPOINT (full URL) or R2_ACCOUNT_ID (+ optional R2_JURISDICTION=eu|fedramp)
 *
 * Returns `null` when none of them is set; throws `R2ConfigError` when some
 * but not all are set, naming the missing ones.
 */
export const r2ConfigFromEnv = (env: Record<string, string | undefined>): R2Config | null => {
  const v = (k: string) => (env[k] !== undefined && env[k] !== "" ? env[k] : undefined)
  const names = ["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_ACCOUNT_ID"]
  if (names.every((k) => v(k) === undefined)) return null
  let endpoint = v("R2_ENDPOINT")
  if (endpoint === undefined && v("R2_ACCOUNT_ID") !== undefined) {
    const account = v("R2_ACCOUNT_ID")!
    if (!/^[0-9a-f]{32}$/i.test(account)) throw new R2ConfigError("R2_ACCOUNT_ID must be the 32-hex-digit Cloudflare account id")
    const j = v("R2_JURISDICTION")
    if (j !== undefined && j !== "eu" && j !== "fedramp") throw new R2ConfigError("R2_JURISDICTION must be eu or fedramp")
    endpoint = `https://${account}${j === undefined ? "" : `.${j}`}.r2.cloudflarestorage.com`
  }
  const missing = [
    ...(v("R2_BUCKET") === undefined ? ["R2_BUCKET"] : []),
    ...(v("R2_ACCESS_KEY_ID") === undefined ? ["R2_ACCESS_KEY_ID"] : []),
    ...(v("R2_SECRET_ACCESS_KEY") === undefined ? ["R2_SECRET_ACCESS_KEY"] : []),
    ...(endpoint === undefined ? ["R2_ENDPOINT or R2_ACCOUNT_ID"] : [])
  ]
  if (missing.length > 0) throw new R2ConfigError(`incomplete R2 configuration, missing: ${missing.join(", ")}`)
  let url: URL
  try {
    url = new URL(endpoint!)
  } catch {
    throw new R2ConfigError(`R2_ENDPOINT is not a URL: ${endpoint}`)
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new R2ConfigError("R2_ENDPOINT must use https")
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new R2ConfigError("R2_ENDPOINT must not contain the bucket name or a path; set R2_BUCKET instead")
  }
  return {
    endpoint: url.origin,
    accessKeyId: secretFromConfig(v("R2_ACCESS_KEY_ID"))!,
    secretAccessKey: secretFromConfig(v("R2_SECRET_ACCESS_KEY"))!,
    bucket: v("R2_BUCKET")!
  }
}

/**
 * The S3 client options used for R2 (exported so tests can pin them). This
 * is the one place the R2 credentials are unwrapped.
 */
export const r2ClientOptions = (cfg: R2Config, purpose: "lock" | "blob") => ({
  region: "auto",
  endpoint: cfg.endpoint,
  credentials: { accessKeyId: reveal(cfg.accessKeyId), secretAccessKey: reveal(cfg.secretAccessKey) },
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
  ...(purpose === "lock" ? { maxAttempts: 1 } : {})
})

export const makeR2S3Client = (cfg: R2Config, purpose: "lock" | "blob"): S3Client =>
  new S3Client(r2ClientOptions(cfg, purpose))

/**
 * Read-only `R2BucketLike` over the S3 API (`ListObjectsV2` + `GetObject`),
 * so the status view (`cobuild status`) can read real R2 without the Worker.
 * ETags are reported unquoted, like the Workers binding's `etag`.
 */
export const makeS3BucketView = (client: S3Client, bucket: string): R2BucketLike => ({
  list: async ({ prefix, cursor }) => {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(cursor !== undefined ? { ContinuationToken: cursor } : {}) })
    )
    const truncated = out.IsTruncated === true
    return {
      objects: (out.Contents ?? []).map((o) => ({ key: o.Key ?? "", size: o.Size ?? 0, etag: (o.ETag ?? "").replace(/"/g, "") })),
      truncated,
      ...(truncated && out.NextContinuationToken !== undefined ? { cursor: out.NextContinuationToken } : {})
    }
  },
  get: async (key) => {
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const text = (await out.Body?.transformToString()) ?? ""
      return { etag: (out.ETag ?? "").replace(/"/g, ""), text: async () => text }
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404) return null
      throw e
    }
  }
})
