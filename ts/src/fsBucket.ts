/**
 * A directory that behaves like an R2 bucket, shared by several **processes**
 * on one machine. It exists so the whole cobuild (lock, cache, status, TUI)
 * can be run and tested end to end without Cloudflare credentials, with the
 * same request semantics as the in-memory simulator (`memoryStore.ts`):
 *
 * - `putIfNoneMatch` (create-only) and `putIfMatch` (compare-and-swap) are
 *   atomic across processes: every request takes a per-key mutex (an atomic
 *   `mkdir`), checks the condition, writes data and metadata with
 *   write-then-rename, and releases the mutex;
 * - every accepted write gets a fresh ETag (quoted, like R2's S3 API);
 * - optional R2-style rate limit: a write less than `rateLimitMs` after the
 *   previous accepted write to the same key is rejected (`RateLimited`) and
 *   changes nothing, like R2's 1 write / key / second;
 * - `list(prefix)` with cursors, like the Workers binding.
 *
 * It is a development and test backend, not a production store: it trusts
 * the local clock and filesystem (POSIX `rename` / `mkdir` atomicity) and it
 * scans the whole directory to list.
 *
 * The same object implements the three interfaces the code base uses for R2:
 * `ObjectStore` (lock), `BlobStore` (cache) and `R2BucketLike` (Worker /
 * status view).
 */
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { Data, Effect, Match, Option, Stream } from "./fx/index.js"
import type { BlobStore } from "./cache/blobStore.js"
import { type ObjectStore, PreconditionFailed, RateLimited, type StoreError, StoreFailure } from "./store.js"
import type { R2BucketLike, R2ListResult, R2ObjectBodyLike } from "./worker/r2Bucket.js"

interface Meta {
  readonly key: string
  readonly etag: string
  readonly size: number
  readonly lastWriteMs: number
}

export interface FsBucketOptions {
  /** Minimum time between two accepted writes to one key (default 1000, R2's limit; 0 disables). */
  readonly rateLimitMs?: number
  /** Clock (default `Date.now`). */
  readonly now?: () => number
  /** Mutexes older than this are considered abandoned by a killed process and broken (default 10 s). */
  readonly staleMutexMs?: number
  /** Page size of `list` (default 1000, the Workers binding default). */
  readonly listPageSize?: number
}

export interface FsBucket extends R2BucketLike {
  readonly root: string
  readonly objectStore: ObjectStore
  readonly blobStore: BlobStore
  readonly putIfNoneMatchBytes: (key: string, body: Uint8Array) => Promise<string>
  readonly putIfMatchBytes: (key: string, etag: string, body: Uint8Array) => Promise<string>
  readonly getBytes: (key: string) => Promise<{ readonly body: Uint8Array; readonly etag: string } | null>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Errors thrown by the promise API; mapped to the `StoreError` types by the Effect adapters. */
class Rejected extends Data.TaggedError("Rejected")<{ readonly kind: "precondition" | "rate"; readonly message: string }> {
  /** @param kind - Which conditional-write rule refused the request. */
  constructor(kind: "precondition" | "rate") {
    super({ kind, message: kind })
  }
}

export const makeFsBucket = (root: string, options: FsBucketOptions = {}): FsBucket => {
  const rateLimitMs = options.rateLimitMs ?? 1000
  // A NaN or negative window would make `rateOk` false forever (every write after the first rejected).
  if (!Number.isFinite(rateLimitMs) || rateLimitMs < 0) throw new RangeError(`rateLimitMs must be a finite non-negative number, got ${rateLimitMs}`)
  const now = options.now ?? Date.now
  const staleMutexMs = options.staleMutexMs ?? 10_000
  const pageSize = options.listPageSize ?? 1000
  const objDir = path.join(root, "objects")

  const dirOf = (key: string) => path.join(objDir, createHash("sha256").update(key, "utf8").digest("hex"))

  const withMutex = async <A>(key: string, fn: (dir: string) => Promise<A>): Promise<A> => {
    const dir = dirOf(key)
    await fs.mkdir(dir, { recursive: true })
    const mutex = path.join(dir, "mutex")
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.mkdir(mutex)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        try {
          const st = await fs.stat(mutex)
          if (Date.now() - st.mtimeMs > staleMutexMs) await fs.rm(mutex, { recursive: true, force: true })
        } catch {
          // released in between
        }
        await sleep(Math.min(50, 1 + attempt))
      }
    }
    try {
      return await fn(dir)
    } finally {
      await fs.rm(mutex, { recursive: true, force: true })
    }
  }

  const readMeta = async (dir: string): Promise<Meta | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")) as Meta
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  }

  const writeObject = async (dir: string, key: string, body: Uint8Array): Promise<string> => {
    const etag = `"${randomUUID().replace(/-/g, "")}"`
    const tmp = randomUUID()
    await fs.writeFile(path.join(dir, `data.${tmp}`), body)
    await fs.rename(path.join(dir, `data.${tmp}`), path.join(dir, "data"))
    const meta: Meta = { key, etag, size: body.length, lastWriteMs: now() }
    await fs.writeFile(path.join(dir, `meta.${tmp}`), JSON.stringify(meta))
    await fs.rename(path.join(dir, `meta.${tmp}`), path.join(dir, "meta.json"))
    return etag
  }

  const rateOk = (meta: Meta | null) => meta === null || rateLimitMs === 0 || meta.lastWriteMs + rateLimitMs <= now()

  const putIfNoneMatchBytes = (key: string, body: Uint8Array) =>
    withMutex(key, async (dir) => {
      const meta = await readMeta(dir)
      if (!rateOk(meta)) throw new Rejected("rate")
      if (meta !== null) throw new Rejected("precondition")
      return writeObject(dir, key, body)
    })

  const putIfMatchBytes = (key: string, etag: string, body: Uint8Array) =>
    withMutex(key, async (dir) => {
      const meta = await readMeta(dir)
      if (!rateOk(meta)) throw new Rejected("rate")
      if (meta === null || meta.etag !== etag) throw new Rejected("precondition")
      return writeObject(dir, key, body)
    })

  const getBytes = (key: string) =>
    withMutex(key, async (dir) => {
      const meta = await readMeta(dir)
      if (meta === null) return null
      return { body: new Uint8Array(await fs.readFile(path.join(dir, "data"))), etag: meta.etag }
    })

  const toStoreError =
    (key: string) =>
    (e: unknown): StoreError =>
      Match.value(e).pipe(
        Match.withReturnType<StoreError>(),
        Match.when(Match.instanceOf(Rejected), (r) => (r.kind === "rate" ? new RateLimited({ key }) : new PreconditionFailed({ key }))),
        Match.orElse((cause) => new StoreFailure({ key, cause }))
      )

  const utf8 = new TextEncoder()
  const fromUtf8 = new TextDecoder()

  const objectStore: ObjectStore = {
    putIfNoneMatch: (key, body) =>
      Effect.tryPromise({ try: () => putIfNoneMatchBytes(key, utf8.encode(body)), catch: toStoreError(key) }),
    putIfMatch: (key, etag, body) =>
      Effect.tryPromise({ try: () => putIfMatchBytes(key, etag, utf8.encode(body)), catch: toStoreError(key) }),
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const o = await getBytes(key)
          return o === null ? Option.none() : Option.some({ body: fromUtf8.decode(o.body), etag: o.etag })
        },
        catch: toStoreError(key)
      })
  }

  const blobStore: BlobStore = {
    putIfNoneMatch: (key, body) =>
      Effect.tryPromise({ try: () => putIfNoneMatchBytes(key, body), catch: toStoreError(key) }).pipe(Effect.asVoid),
    getStream: (key) =>
      Effect.tryPromise({
        try: () => getBytes(key),
        catch: (cause) => new StoreFailure({ key, cause })
      }).pipe(
        Effect.map((o) => {
          if (o === null) return Option.none()
          const chunks: Array<Uint8Array> = []
          for (let i = 0; i < o.body.length; i += 64 * 1024) chunks.push(o.body.subarray(i, i + 64 * 1024))
          return Option.some(Stream.fromIterable(chunks) as Stream.Stream<Uint8Array, StoreFailure>)
        })
      )
  }

  const allMetas = async (): Promise<Array<Meta>> => {
    let names: Array<string>
    try {
      names = await fs.readdir(objDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
    const metas: Array<Meta> = []
    for (const n of names) {
      const m = await readMeta(path.join(objDir, n)).catch(() => null)
      if (m !== null) metas.push(m)
    }
    return metas.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  const list = async (opts: { readonly prefix: string; readonly cursor?: string }): Promise<R2ListResult> => {
    const all = (await allMetas()).filter((m) => m.key.startsWith(opts.prefix))
    // The cursor is the last key of the previous page (keys are listed in lexicographic order).
    const start = opts.cursor === undefined ? 0 : all.findIndex((m) => m.key > opts.cursor!)
    const from = start < 0 ? all.length : start
    const page = all.slice(from, from + pageSize)
    const truncated = from + pageSize < all.length
    return {
      objects: page.map((m) => ({ key: m.key, size: m.size, etag: m.etag.replace(/"/g, "") })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1]!.key } : {})
    }
  }

  const get = async (key: string): Promise<R2ObjectBodyLike | null> => {
    const o = await getBytes(key)
    if (o === null) return null
    // The Workers binding reports `etag` unquoted (`httpEtag` is the quoted form).
    return { etag: o.etag.replace(/"/g, ""), text: async () => fromUtf8.decode(o.body) }
  }

  return { root, objectStore, blobStore, putIfNoneMatchBytes, putIfMatchBytes, getBytes, list, get }
}
