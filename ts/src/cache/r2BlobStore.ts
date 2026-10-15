/**
 * `BlobStore` on Cloudflare R2's S3-compatible API.
 *
 * Type-checked only; not run against R2 (no credentials in this project).
 * Status mapping as in `../r2Store.ts`: 409 / 412 → `PreconditionFailed`,
 * 429 → `RateLimited`, 404 on `GetObject` → `Option.none()`, anything else →
 * `StoreFailure`.
 *
 * Single `PutObject` requests only. Blobs above R2's single-request size limit
 * need multipart upload (not implemented here); whether R2 honours
 * `If-None-Match: *` on `CompleteMultipartUpload` is an unchecked external
 * fact (Phase 0 of the plan).
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { Effect, Option, Stream } from "../fx/index.js"
import { PreconditionFailed, RateLimited, type StoreError, StoreFailure } from "../store.js"
import type { BlobStore } from "./blobStore.js"

const statusOf = (e: unknown): number | undefined =>
  typeof e === "object" && e !== null && "$metadata" in e
    ? (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined

const mapError = (key: string, e: unknown): StoreError => {
  switch (statusOf(e)) {
    case 409:
    case 412:
      return new PreconditionFailed({ key })
    case 429:
      return new RateLimited({ key })
    default:
      return new StoreFailure({ key, cause: e })
  }
}

const isAsyncIterable = (x: unknown): x is AsyncIterable<Uint8Array> =>
  typeof x === "object" && x !== null && Symbol.asyncIterator in x

export const makeR2BlobStore = (client: S3Client, bucket: string): BlobStore => ({
  putIfNoneMatch: (key, body) =>
    Effect.tryPromise({
      try: (signal) =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "application/octet-stream",
            IfNoneMatch: "*"
          }),
          { abortSignal: signal }
        ),
      catch: (e) => mapError(key, e)
    }).pipe(Effect.asVoid),

  getStream: (key) =>
    Effect.tryPromise({
      try: async (signal) => {
        try {
          const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })
          return Option.some(out.Body)
        } catch (e) {
          if (statusOf(e) === 404) return Option.none()
          throw e
        }
      },
      catch: (e) => new StoreFailure({ key, cause: e })
    }).pipe(
      Effect.flatMap((o) => {
        if (Option.isNone(o)) return Effect.succeed(Option.none())
        const body = o.value
        if (!isAsyncIterable(body)) {
          return Effect.fail(new StoreFailure({ key, cause: "GetObject body is not a byte stream" }))
        }
        return Effect.succeed(
          Option.some(Stream.fromAsyncIterable(body, (cause) => new StoreFailure({ key, cause })))
        )
      })
    )
})
