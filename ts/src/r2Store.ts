/**
 * `ObjectStore` backed by Cloudflare R2 through its S3-compatible API.
 *
 * Status mapping:
 * - `412` -> `PreconditionFailed`
 * - `409` (`ConditionalRequestConflict`, a conditional write racing another
 *   write) -> `PreconditionFailed`. The caller re-reads later, which is safe.
 * - `429` -> `RateLimited`
 * - `404` on `GetObject` -> `Option.none()`
 * - anything else -> `StoreFailure`
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { Effect, Option } from "./fx/index.js"
import {
  type ObjectStore,
  PreconditionFailed,
  RateLimited,
  type StoreError,
  StoreFailure
} from "./store.js"

const statusOf = (e: unknown): number | undefined => {
  if (typeof e === "object" && e !== null && "$metadata" in e) {
    const md = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
    return md?.httpStatusCode
  }
  return undefined
}

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

const requireETag = (key: string, etag: string | undefined): Effect.Effect<string, StoreError> =>
  etag === undefined
    ? Effect.fail(new StoreFailure({ key, cause: "R2 response carried no ETag" }))
    : Effect.succeed(etag)

export const makeR2Store = (client: S3Client, bucket: string): ObjectStore => {
  const put = (key: string, body: string, condition: { IfNoneMatch: string } | { IfMatch: string }) =>
    Effect.tryPromise({
      try: (signal) =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
            ...condition
          }),
          { abortSignal: signal }
        ),
      catch: (e) => mapError(key, e)
    }).pipe(Effect.flatMap((out) => requireETag(key, out.ETag)))

  return {
    putIfNoneMatch: (key, body) => put(key, body, { IfNoneMatch: "*" }),
    putIfMatch: (key, etag, body) => put(key, body, { IfMatch: etag }),
    get: (key) =>
      Effect.tryPromise({
        try: async (signal) => {
          try {
            const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
              abortSignal: signal
            })
            const body = (await out.Body?.transformToString()) ?? ""
            return Option.some({ body, etag: out.ETag })
          } catch (e) {
            if (statusOf(e) === 404) return Option.none()
            throw e
          }
        },
        catch: (e) => mapError(key, e)
      }).pipe(
        Effect.flatMap((o) =>
          Option.match(o, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: ({ body, etag }) =>
              Effect.map(requireETag(key, etag), (etag) => Option.some({ body, etag }))
          })
        )
      )
  }
}
