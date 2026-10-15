/**
 * In-memory Cloudflare Artifacts namespace that implements the documented
 * contract of the Workers binding (see `src/bisect/artifactsApi.ts`), and a
 * `fetch` that serves the documented REST routes from the same data.
 *
 * Contract implemented (from `cloudflare-artifacts.md`, not from any test):
 * - `get(name)` throws `NOT_FOUND` for an unknown repo and returns a
 *   disposable handle; using a handle after disposal throws;
 * - `log({ ref = "HEAD", limit = 50, offset = 0 })`: `limit` above 1000 is
 *   `INVALID_INPUT`; follows first parents from the resolved ref, newest
 *   first; an unresolvable ref gives `[]`;
 * - `readCommit(hash)` returns the commit or `null`;
 * - `info()` returns `{ name, remote, defaultBranch }`;
 * - `createToken(scope = "write", ttl)` returns `{ plaintext, expiresAt }`.
 *
 * The field name of the commit id is a parameter (`idField`), because the
 * documentation does not fix it; tests run with every accepted name.
 */
import type { ArtifactsNamespaceLike, ArtifactsRepoLike, LogOptions, TokenScope } from "../../src/bisect/artifactsApi.js"

export interface FakeCommit {
  readonly oid: string
  readonly parents: ReadonlyArray<string>
  readonly message: string
}

export interface FakeRepo {
  readonly commits: Map<string, FakeCommit>
  readonly refs: Map<string, string>
  readonly defaultBranch: string
}

export type IdField = "oid" | "id" | "hash" | "sha"

export interface FakeNamespace extends ArtifactsNamespaceLike {
  readonly repos: Map<string, FakeRepo>
  readonly opened: () => number
  readonly disposed: () => number
  readonly tokens: Array<{ repo: string; scope: TokenScope; ttl: number | undefined; plaintext: string }>
  readonly logCalls: Array<LogOptions>
}

const hex40 = (n: number, salt: number): string => {
  let s = ""
  let x = (n * 2654435761 + salt * 97) >>> 0
  while (s.length < 40) {
    x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0
    s += x.toString(16).padStart(8, "0")
  }
  return s.slice(0, 40)
}

/**
 * A repository whose `main` has `mainLength` first-parent commits
 * (`mainline[0]` oldest). Commits listed in `mergesAt` are merge commits whose
 * second parent is a side branch of `sideLength` commits off the previous
 * mainline commit, so first-parent history differs from full history.
 */
export const makeRepo = (
  mainLength: number,
  opts: { readonly mergesAt?: ReadonlyArray<number>; readonly sideLength?: number; readonly salt?: number } = {}
): { repo: FakeRepo; mainline: string[]; sideCommits: string[] } => {
  const salt = opts.salt ?? 1
  const commits = new Map<string, FakeCommit>()
  const mainline: string[] = []
  const sideCommits: string[] = []
  let counter = 0
  const add = (parents: string[], message: string): string => {
    const oid = hex40(counter++, salt)
    commits.set(oid, { oid, parents, message })
    return oid
  }
  const merges = new Set(opts.mergesAt ?? [])
  for (let i = 0; i < mainLength; i++) {
    const prev = mainline[i - 1]
    if (prev !== undefined && merges.has(i)) {
      let side = prev
      for (let k = 0; k < (opts.sideLength ?? 2); k++) {
        side = add([side], `side ${i}.${k}`)
        sideCommits.push(side)
      }
      mainline.push(add([prev, side], `merge ${i}`))
    } else {
      mainline.push(add(prev === undefined ? [] : [prev], `commit ${i}`))
    }
  }
  const refs = new Map<string, string>([["main", mainline.at(-1)!]])
  return { repo: { commits, refs, defaultBranch: "main" }, mainline, sideCommits }
}

const resolve = (r: FakeRepo, ref: string): string | undefined => {
  if (ref === "HEAD") return r.refs.get(r.defaultBranch)
  if (r.refs.has(ref)) return r.refs.get(ref)
  return r.commits.has(ref) ? ref : undefined
}

export const firstParentChain = (r: FakeRepo, from: string): string[] => {
  const out: string[] = []
  let cur: string | undefined = from
  while (cur !== undefined) {
    out.push(cur)
    cur = r.commits.get(cur)!.parents[0]
  }
  return out
}

export const commitRecord = (c: FakeCommit, idField: IdField) => ({ [idField]: c.oid, message: c.message, parents: [...c.parents] })

export class FakeArtifactsError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

export const makeFakeNamespace = (
  repos: Record<string, FakeRepo>,
  opts: {
    readonly idField?: IdField
    readonly accountId?: string
    readonly namespace?: string
    readonly remoteOf?: (name: string) => string
    /** Does `log({ ref })` accept a commit id? Undocumented, so tests run both ways (default `true`). */
    readonly logByCommitId?: boolean
    /** Called before each `log()` is answered, with the call number (from 0): lets a test push mid-paging. */
    readonly beforeLog?: (o: LogOptions, call: number, repo: FakeRepo) => void
  } = {}
): FakeNamespace => {
  const idField = opts.idField ?? "oid"
  const map = new Map(Object.entries(repos))
  let opened = 0
  let disposed = 0
  let tokenCounter = 0
  const tokens: FakeNamespace["tokens"] = []
  const logCalls: LogOptions[] = []
  return {
    repos: map,
    opened: () => opened,
    disposed: () => disposed,
    tokens,
    logCalls,
    get: async (name: string) => {
      const r = map.get(name)
      if (r === undefined) throw new FakeArtifactsError("NOT_FOUND", `repo ${name} does not exist`)
      opened++
      let live = true
      const alive = () => {
        if (!live) throw new Error("repository capability used after dispose")
      }
      const handle: ArtifactsRepoLike & { [Symbol.dispose]: () => void } = {
        log: async (o: LogOptions = {}) => {
          alive()
          opts.beforeLog?.(o, logCalls.length, r)
          logCalls.push(o)
          const limit = o.limit ?? 50
          const offset = o.offset ?? 0
          if (limit > 1000) throw new FakeArtifactsError("INVALID_INPUT", "limit above 1000")
          const ref = o.ref ?? "HEAD"
          if (opts.logByCommitId === false && r.commits.has(ref) && !r.refs.has(ref)) return []
          const start = resolve(r, ref)
          if (start === undefined) return []
          return firstParentChain(r, start)
            .slice(offset, offset + limit)
            .map((oid) => commitRecord(r.commits.get(oid)!, idField))
        },
        readCommit: async (hash: string) => {
          alive()
          const c = r.commits.get(hash)
          return c === undefined ? null : commitRecord(c, idField)
        },
        info: async () => {
          alive()
          return {
            name,
            remote: opts.remoteOf?.(name) ?? `https://${opts.accountId ?? "acct"}.artifacts.cloudflare.net/git/${opts.namespace ?? "default"}/${name}.git`,
            defaultBranch: r.defaultBranch
          }
        },
        createToken: async (scope: TokenScope = "write", ttl?: number) => {
          alive()
          const plaintext = `art_v1_${hex40(tokenCounter++, 7)}?expires=${1_760_000_000 + (ttl ?? 86_400)}`
          tokens.push({ repo: name, scope, ttl, plaintext })
          return { plaintext, expiresAt: new Date((1_760_000_000 + (ttl ?? 86_400)) * 1000).toISOString() }
        },
        [Symbol.dispose]: () => {
          if (live) disposed++
          live = false
        }
      }
      return handle
    }
  }
}

/**
 * A `fetch` serving the documented REST routes from a fake namespace, with
 * the v4 envelope. `faults(method, path)` may return an HTTP status and
 * error code to inject before the real handling (e.g. 409 FORK_IN_PROGRESS).
 */
export const makeRestFetch = (
  ns: FakeNamespace,
  cfg: {
    readonly accountId: string
    readonly namespace: string
    readonly apiToken: string
    readonly faults?: (method: string, path: string) => { status: number; code: number; retryAfter?: string } | null
  }
) => {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = []
  const prefix = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/artifacts/namespaces/${cfg.namespace}`
  const envelope = (result: unknown, status = 200, errors: Array<{ code: number; message: string }> = [], headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ result, success: errors.length === 0, errors, messages: [] }), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    requests.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) })
    if (init.headers["authorization"] !== `Bearer ${cfg.apiToken}`) return envelope(null, 401, [{ code: 10000, message: "Authentication error" }])
    if (!url.startsWith(prefix)) return envelope(null, 404, [{ code: 7003, message: "No route" }])
    const u = new URL(url)
    const path = u.pathname.slice(new URL(prefix).pathname.length)
    const fault = cfg.faults?.(init.method, path)
    if (fault) return envelope(null, fault.status, [{ code: fault.code, message: "injected" }], fault.retryAfter ? { "retry-after": fault.retryAfter } : {})
    const parts = path.split("/").filter((p) => p.length > 0).map(decodeURIComponent)
    try {
      if (init.method === "POST" && parts.length === 1 && parts[0] === "tokens") {
        const body = JSON.parse(init.body ?? "{}") as { repo: string; scope?: TokenScope; ttl?: number }
        const h = await ns.get(body.repo)
        const t = (await h.createToken!(body.scope, body.ttl)) as { plaintext: string; expiresAt: string }
        ;(h as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]()
        return envelope({ id: "tok", plaintext: t.plaintext, scope: body.scope ?? "write", expires_at: t.expiresAt })
      }
      if (init.method !== "GET" || parts[0] !== "repos" || parts[1] === undefined) return envelope(null, 404, [{ code: 7003, message: "No route" }])
      const h = await ns.get(parts[1])
      try {
        if (parts.length === 2) {
          const i = (await h.info!()) as { name: string; remote: string; defaultBranch: string }
          return envelope({ id: "repo_1", name: i.name, description: null, default_branch: i.defaultBranch, remote: i.remote, read_only: false })
        }
        if (parts[2] === "log" && parts.length === 3) {
          const q = u.searchParams
          const o: LogOptions = {
            ...(q.has("ref") ? { ref: q.get("ref")! } : {}),
            ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}),
            ...(q.has("offset") ? { offset: Number(q.get("offset")) } : {})
          }
          return envelope(await h.log(o))
        }
        if (parts[2] === "commit" && parts.length === 4) {
          const c = await h.readCommit!(parts[3]!)
          return c === null ? envelope(null, 404, [{ code: 10200, message: "Commit not found" }]) : envelope(c)
        }
        return envelope(null, 404, [{ code: 7003, message: "No route" }])
      } finally {
        ;(h as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]()
      }
    } catch (e) {
      if (e instanceof FakeArtifactsError && e.code === "NOT_FOUND") return envelope(null, 404, [{ code: 10200, message: e.message }])
      if (e instanceof FakeArtifactsError && e.code === "INVALID_INPUT") return envelope(null, 400, [{ code: 10100, message: e.message }])
      throw e
    }
  }
  return { fetch: fetchFn, requests }
}
