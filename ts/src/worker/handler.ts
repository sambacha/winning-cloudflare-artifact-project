/**
 * State API for the cobuild dashboard, served by a Cloudflare Worker bound
 * to the cache bucket.
 *
 *   GET /api/locks?context=<ctx>   lock objects of one cobuild context
 *   GET /api/cache                 blob and manifest counts / bytes of the scope
 *   GET /api/artifacts?repo=<name> remote and newest commits of one Artifacts repo
 *                                  (`artifactsView.ts`), when the binding is configured
 *   GET /api/node-modules          node_modules cache entries, hits / misses, restore and saved time
 *                                  (`nodeModulesView.ts`)
 *   GET /healthz                   liveness (no authentication, no bucket access)
 *   /api/bisect…                   Bayesian bisection sessions (`bisectRoutes.ts`),
 *                                  only when an Artifacts binding is configured
 *
 * The lock and cache routes never write, so they cannot interfere with locks
 * (no 429 on a holder's key, no ETag change) or with the cache. Bisection
 * sessions live under their own key prefix (`v1/<scope>/bisect/…`).
 *
 * Fixes relative to the proposal's Worker (see `docs/demo-dependency-plan.md`
 * C1–C3, C13, C14):
 * - lock objects live at `v1/<scope>/cobuild/<context>/<cacheKey>/lock/`
 *   (`encodeKey`, the same function the lock uses), not `v1/lock/…`;
 * - the lock state is the object *body* (a JSON `Manifest`), not custom
 *   metadata, so every lock object is read and decoded; undecodable bodies
 *   are reported, not dropped;
 * - manifests are under `m/`, not `k/`;
 * - listings follow `cursor` while `truncated`, up to `maxObjects`, and say
 *   whether they were cut short;
 * - requests need `Authorization: Bearer <token>` (a Worker secret), are GET
 *   only, and are limited to the configured scope. No wildcard CORS: the
 *   dashboard is a terminal program, not a browser page.
 *
 * Roles (audit B-3b). With `writeToken` configured, the read token (`token`)
 * only opens the GET views (locks, cache, artifacts); every `/api/bisect`
 * route (it writes sessions or mints Git credentials) needs `writeToken`,
 * which also opens the views. Without `writeToken`, `token` opens everything
 * (the earlier single-token behaviour).
 *
 * Observability (audit B-7). Every request produces exactly one structured
 * log entry (`RequestLogEntry`: method, path, status, duration, scope, role).
 * It never contains the Authorization header, the query string or an error
 * message; unexpected exceptions become `500 {"error":"internal error"}` with
 * only the error's class name logged.
 */
import { Result, Schema } from "../fx/index.js"
import { decodeKey, encodeKey } from "../cache/keyEncoding.js"
import { isValidScope } from "../cache/scope.js"
import { Manifest } from "../lockManifest.js"
import type { R2BucketLike, R2ObjectSummary } from "./r2Bucket.js"
import { loadNodeModulesView } from "./nodeModulesView.js"
import { type BisectDeps, handleBisect } from "./bisectRoutes.js"
import type { ArtifactsNamespaceLike } from "../bisect/artifactsApi.js"
import { Effect, type Redacted } from "../fx/index.js"
import { reveal } from "../secrets.js"
import { artifactsErrorBody, artifactsErrorStatus, parseArtifactsQuery, viewArtifactsRepo } from "./artifactsView.js"

export interface HandlerConfig {
  /** Trust scope whose objects are visible (first key component). */
  readonly scope: string
  /** Bearer token required on every request (unwrapped only inside {@link roleOf}). */
  readonly token: Redacted.Redacted<string>
  /** Lock-key prefix component (default `cobuild`, as in `CobuildConfig.prefix`). */
  readonly lockPrefix?: string
  /** Maximum number of objects listed per prefix and request (default 5000). */
  readonly maxObjects?: number
  /** Lock bodies fetched in parallel by `GET /api/locks` (default 16). */
  readonly lockFetchConcurrency?: number
  /** Current time in ms, used only to flag expired leases. */
  readonly now: () => number
  /** Bayesian bisection over an Artifacts repository (`bisectRoutes.ts`); off when absent. */
  readonly bisect?: BisectDeps
  /** Second token for the `/api/bisect` routes (see "Roles"); absent = `token` opens everything. */
  readonly writeToken?: Redacted.Redacted<string>
  /** Artifacts binding for `GET /api/artifacts`; the route answers 404 when absent. */
  readonly artifacts?: ArtifactsNamespaceLike
  /** Receives one entry per request (default: none). */
  readonly log?: (entry: RequestLogEntry) => void
}

export type Role = "read" | "write"

export interface RequestLogEntry {
  readonly level: "info" | "warn" | "error"
  readonly msg: "request"
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly scope: string
  /** Role the request authenticated as; `public` for `/healthz`; `denied` for 401/403. */
  readonly auth: Role | "public" | "denied"
  /** Class name of an unexpected exception (never its message). */
  readonly error?: string
}



export type LockView =
  | {
      readonly key: string
      readonly cacheKey: string
      readonly etag: string
      readonly owner: string
      readonly status: "building" | "succeeded" | "failed"
      readonly acquiredAt: number
      readonly heartbeatAt: number
      readonly expiresAt: number
      /** `building` and past `expiresAt`: another job may take it over. */
      readonly leaseExpired: boolean
      readonly buildCacheKey: string | null
      readonly failedAt: number | null
      readonly logKey: string | null
    }
  | { readonly key: string; readonly error: string }

export interface LocksResponse {
  readonly scope: string
  readonly context: string
  readonly locks: ReadonlyArray<LockView>
  readonly truncated: boolean
}

export interface CacheResponse {
  readonly scope: string
  readonly blobCount: number
  readonly blobBytes: number
  readonly manifestCount: number
  readonly manifestBytes: number
  readonly truncated: boolean
}

const decodeManifestEither = Schema.decodeUnknownResult(Schema.fromJsonString(Manifest))

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  })

/** Comparison without an early exit on the first differing byte. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/** List every object under `prefix`, following cursors, up to `max` objects. */
export const listAll = async (
  bucket: R2BucketLike,
  prefix: string,
  max: number
): Promise<{ objects: Array<R2ObjectSummary>; truncated: boolean }> => {
  const objects: Array<R2ObjectSummary> = []
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor })
    for (const o of page.objects) {
      if (objects.length >= max) return { objects, truncated: true }
      objects.push(o)
    }
    if (!page.truncated) return { objects, truncated: false }
    if (page.cursor === undefined) throw new Error("R2 list reported truncated without a cursor")
    cursor = page.cursor
  }
}

/** `f` over `xs` with at most `limit` calls in flight; results in input order. */
export const mapBounded = async <A, B>(xs: ReadonlyArray<A>, limit: number, f: (a: A) => Promise<B>): Promise<Array<B>> => {
  const out = new Array<B>(xs.length)
  let next = 0
  const worker = async () => {
    while (next < xs.length) {
      const i = next++
      out[i] = await f(xs[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker))
  return out
}

const viewLock = async (bucket: R2BucketLike, key: string, cacheKey: string, now: number): Promise<LockView | null> => {
  const obj = await bucket.get(key)
  // Deleted between list and get. The lock never deletes, so this only happens after manual cleanup.
  if (obj === null) return null
  const decoded = decodeManifestEither(await obj.text())
  if (Result.isFailure(decoded)) return { key, error: "body is not a cobuild lock manifest" }
  const m = decoded.success
  const o = m.outcome
  return {
    key,
    cacheKey,
    etag: obj.etag,
    owner: m.owner,
    status: o.status,
    acquiredAt: m.acquiredAt,
    heartbeatAt: m.heartbeatAt,
    expiresAt: m.expiresAt,
    leaseExpired: o.status === "building" && m.expiresAt < now,
    buildCacheKey: o.status === "succeeded" ? o.buildCacheKey : null,
    failedAt: o.status === "failed" ? o.failedAt : null,
    logKey: o.status === "failed" ? o.logKey : null
  }
}

/** Role the route needs: `/api/bisect…` writes sessions or mints credentials. */
export const requiredRole = (pathname: string): Role => (pathname === "/api/bisect" || pathname.startsWith("/api/bisect/") ? "write" : "read")

/** Role granted by an `Authorization` header value, or `null`. Both comparisons always run. */
export const roleOf = (header: string, cfg: Pick<HandlerConfig, "token" | "writeToken">): Role | null => {
  const isRead = timingSafeEqual(header, `Bearer ${reveal(cfg.token)}`)
  const write = cfg.writeToken === undefined ? "" : reveal(cfg.writeToken)
  const isWrite = write.length > 0 && timingSafeEqual(header, `Bearer ${write}`)
  if (isWrite) return "write"
  if (isRead) return cfg.writeToken === undefined ? "write" : "read"
  return null
}

const grants = (have: Role, need: Role): boolean => have === "write" || need === "read"

interface Routed {
  readonly response: Response
  readonly auth: RequestLogEntry["auth"]
}

/**
 * Serve one request and emit exactly one log entry. Exceptions from the
 * bucket or the binding become a bare 500; nothing about them reaches the
 * client.
 */
export const handle = async (request: Request, bucket: R2BucketLike, cfg: HandlerConfig): Promise<Response> => {
  const started = cfg.now()
  const url = new URL(request.url)
  let routed: Routed
  let error: string | undefined
  try {
    routed = await route(request, url, bucket, cfg)
  } catch (e) {
    error = e instanceof Error ? e.name : typeof e
    routed = { response: json({ error: "internal error" }, 500), auth: "denied" }
  }
  const status = routed.response.status
  cfg.log?.({
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    msg: "request",
    method: request.method,
    path: url.pathname,
    status,
    durationMs: Math.max(0, cfg.now() - started),
    scope: cfg.scope,
    auth: routed.auth,
    ...(error !== undefined ? { error } : {})
  })
  return routed.response
}

const route = async (request: Request, url: URL, bucket: R2BucketLike, cfg: HandlerConfig): Promise<Routed> => {
  if (!isValidScope(cfg.scope)) return { response: json({ error: "server misconfigured: invalid scope" }, 500), auth: "denied" }
  if (reveal(cfg.token).length === 0) return { response: json({ error: "server misconfigured: empty token" }, 500), auth: "denied" }
  if (url.pathname === "/healthz") {
    return { response: request.method === "GET" ? json({ status: "ok" }) : json({ error: "method not allowed" }, 405), auth: "public" }
  }
  const role = roleOf(request.headers.get("authorization") ?? "", cfg)
  if (role === null) return { response: json({ error: "unauthorized" }, 401), auth: "denied" }
  if (!grants(role, requiredRole(url.pathname))) return { response: json({ error: "forbidden" }, 403), auth: "denied" }
  return { response: await serve(request, url, bucket, cfg), auth: role }
}

const serve = async (request: Request, url: URL, bucket: R2BucketLike, cfg: HandlerConfig): Promise<Response> => {
  // Bisection routes (POST allowed) are only served when an Artifacts binding is configured.
  if (cfg.bisect !== undefined) {
    const r = await handleBisect(request, cfg.bisect)
    if (r !== null) return r
  }
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405)

  if (url.pathname === "/api/artifacts") {
    const artifacts = cfg.artifacts
    if (artifacts === undefined) return json({ error: "no Artifacts binding configured" }, 404)
    return Effect.runPromise(
      parseArtifactsQuery(url.searchParams).pipe(
        Effect.flatMap((q) => viewArtifactsRepo(artifacts, q)),
        Effect.match({
          onFailure: (e) => json(artifactsErrorBody(e), artifactsErrorStatus(e)),
          onSuccess: (view) => json({ scope: cfg.scope, ...view })
        })
      )
    )
  }
  const max = cfg.maxObjects ?? 5000
  const lockPrefix = cfg.lockPrefix ?? "cobuild"

  if (url.pathname === "/api/locks") {
    const context = url.searchParams.get("context")
    if (context === null) return json({ error: "missing ?context=" }, 400)
    let prefix: string
    try {
      prefix = encodeKey([cfg.scope, lockPrefix, context])
    } catch {
      return json({ error: "invalid context" }, 400)
    }
    const { objects, truncated } = await listAll(bucket, prefix, max)
    const now = cfg.now()
    const lockObjects: Array<{ key: string; cacheKey: string }> = []
    for (const o of objects) {
      const parts = decodeKey(o.key)
      // [scope, prefix, context, cacheKey, "lock"]; anything else under the prefix is not a lock object.
      if (parts === null || parts.length !== 5 || parts[4] !== "lock") continue
      lockObjects.push({ key: o.key, cacheKey: parts[3]! })
    }
    // Bodies are fetched with bounded concurrency (not one at a time), in listing order.
    const views = await mapBounded(lockObjects, cfg.lockFetchConcurrency ?? 16, (l) => viewLock(bucket, l.key, l.cacheKey, now))
    const locks: Array<LockView> = views.filter((v): v is LockView => v !== null)
    const body: LocksResponse = { scope: cfg.scope, context, locks, truncated }
    return json(body)
  }

  if (url.pathname === "/api/node-modules") {
    return json({ scope: cfg.scope, ...(await loadNodeModulesView(bucket, listAll, mapBounded, max)) })
  }

  if (url.pathname === "/api/cache") {
    const blobs = await listAll(bucket, encodeKey([cfg.scope, "b"]), max)
    const manifests = await listAll(bucket, encodeKey([cfg.scope, "m"]), max)
    const body: CacheResponse = {
      scope: cfg.scope,
      blobCount: blobs.objects.length,
      blobBytes: blobs.objects.reduce((s, o) => s + o.size, 0),
      manifestCount: manifests.objects.length,
      manifestBytes: manifests.objects.reduce((s, o) => s + o.size, 0),
      truncated: blobs.truncated || manifests.truncated
    }
    return json(body)
  }

  return json({ error: "not found" }, 404)
}
