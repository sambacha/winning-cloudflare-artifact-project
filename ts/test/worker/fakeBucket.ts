/**
 * An in-memory `R2BucketLike` over the in-memory lock store and blob store,
 * so that the Worker reads exactly the objects the real lock and cache code
 * wrote. Keys are listed in lexicographic order, `pageSize` at a time, with
 * an opaque cursor, like R2's `list`.
 */
import type { MemoryBlobStore } from "../../src/cache/blobStore.js"
import type { MemoryStore } from "../../src/memoryStore.js"
import type { R2BucketLike, R2ObjectSummary } from "../../src/worker/r2Bucket.js"

export interface FakeBucket extends R2BucketLike {
  /** Number of `list` calls (to check that cursors are followed). */
  readonly listCalls: () => number
  /** Out-of-band objects (e.g. a malformed body at a lock path). */
  readonly extra: Map<string, string>
}

export const makeFakeBucket = (
  sources: { readonly locks?: MemoryStore; readonly blobs?: MemoryBlobStore },
  pageSize = 1000
): FakeBucket => {
  let lists = 0
  const extra = new Map<string, string>()
  const utf8 = new TextEncoder()

  const all = (): Array<R2ObjectSummary & { readonly text: string }> => {
    const out: Array<R2ObjectSummary & { readonly text: string }> = []
    for (const key of sources.locks?.keys() ?? []) {
      const o = sources.locks!.peek(key)!
      out.push({ key, size: utf8.encode(o.body).length, etag: o.etag, text: o.body })
    }
    for (const key of new Set(sources.blobs?.writes ?? [])) {
      const bytes = sources.blobs!.peek(key)!
      out.push({ key, size: bytes.length, etag: `"blob-${key.length}"`, text: new TextDecoder().decode(bytes) })
    }
    for (const [key, text] of extra) out.push({ key, size: utf8.encode(text).length, etag: `"extra"`, text })
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  return {
    extra,
    listCalls: () => lists,
    list: async ({ prefix, cursor }) => {
      lists++
      const matching = all().filter((o) => o.key.startsWith(prefix))
      const start = cursor === undefined ? 0 : Number(cursor)
      const page = matching.slice(start, start + pageSize).map(({ key, size, etag }) => ({ key, size, etag }))
      const next = start + pageSize
      return next < matching.length ? { objects: page, truncated: true, cursor: String(next) } : { objects: page, truncated: false }
    },
    get: async (key) => {
      const o = all().find((x) => x.key === key)
      return o === undefined ? null : { etag: o.etag, text: async () => o.text }
    }
  }
}
