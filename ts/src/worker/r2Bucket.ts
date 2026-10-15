/**
 * The subset of the Workers R2 binding (`R2Bucket`) that the read-only state
 * API uses. Declared here instead of depending on `@cloudflare/workers-types`
 * (not installed in this repository); a real binding satisfies it
 * structurally. The field names follow the Workers R2 API (`list` returns
 * `objects`, `truncated` and, when truncated, `cursor`); this has been
 * type-checked but **not run against a real binding** from this repository.
 */
export interface R2ObjectSummary {
  readonly key: string
  readonly size: number
  readonly etag: string
}

export interface R2ListResult {
  readonly objects: ReadonlyArray<R2ObjectSummary>
  readonly truncated: boolean
  readonly cursor?: string
}

export interface R2ObjectBodyLike {
  readonly etag: string
  readonly text: () => Promise<string>
}

export interface R2BucketLike {
  readonly list: (options: { readonly prefix: string; readonly cursor?: string }) => Promise<R2ListResult>
  readonly get: (key: string) => Promise<R2ObjectBodyLike | null>
}
