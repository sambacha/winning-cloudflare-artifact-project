/**
 * The R2 adapters (`r2Store.ts`, `cache/r2BlobStore.ts`, `r2Client.ts`)
 * against a fake `S3Client` that records the commands it is sent and answers
 * the way R2's S3 API does (status codes in `$metadata.httpStatusCode`,
 * quoted ETags). These pin the request shapes the R2 review checked
 * (`docs/r2-end-to-end-review.md`): `If-None-Match: *` for create-only writes,
 * `If-Match: <etag>` for compare-and-swap, the 412 / 409 / 429 / 404 mapping,
 * and the client options (region `auto`, checksums only when required, no
 * SDK retries for the lock client). They do not replace the real-R2 test
 * (`r2.live.test.ts`).
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { createHash } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inspect } from "node:util"
import { Effect, Option, Redacted, Result, Stream } from "../src/fx/index.js"
import { describe, expect, it } from "vitest"
import { makeR2BlobStore } from "../src/cache/r2BlobStore.js"
import { makeS3BucketView, r2ClientOptions, r2ConfigFromEnv, R2ConfigError } from "../src/r2Client.js"
import { makeR2Store } from "../src/r2Store.js"

type Sent = { readonly name: string; readonly input: Record<string, unknown> }

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { $metadata: { httpStatusCode: status } })

/** Fake client: `answer` decides the response of each command. */
const fakeClient = (answer: (c: Sent) => unknown): { client: S3Client; sent: Array<Sent> } => {
  const sent: Array<Sent> = []
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const c = { name: cmd.constructor.name, input: cmd.input }
      sent.push(c)
      const r = answer(c)
      if (r instanceof Error) throw r
      return r
    }
  } as unknown as S3Client
  return { client, sent }
}

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(e))

describe("lock store over the S3 API", () => {
  it("create-only and compare-and-swap writes carry If-None-Match: * / If-Match: <etag>, and return R2's ETag", async () => {
    const { client, sent } = fakeClient(() => ({ ETag: '"e1"' }))
    const store = makeR2Store(client, "bucket")
    expect(await run(store.putIfNoneMatch("k", "{}"))).toEqual(Result.succeed('"e1"'))
    expect(await run(store.putIfMatch("k", '"e0"', "{}"))).toEqual(Result.succeed('"e1"'))
    expect(sent.map((s) => s.name)).toEqual([PutObjectCommand.name, PutObjectCommand.name])
    expect(sent[0]!.input).toMatchObject({ Bucket: "bucket", Key: "k", IfNoneMatch: "*", ContentType: "application/json" })
    expect(sent[0]!.input["IfMatch"]).toBeUndefined()
    expect(sent[1]!.input).toMatchObject({ Key: "k", IfMatch: '"e0"' })
    expect(sent[1]!.input["IfNoneMatch"]).toBeUndefined()
  })

  it("regression (recorded): 412/409 → PreconditionFailed, 429 → RateLimited, 500/403/socket error → StoreFailure", async () => {
    for (const [status, tag] of [
      [412, "PreconditionFailed"],
      [409, "PreconditionFailed"],
      [429, "RateLimited"],
      [500, "StoreFailure"],
      [403, "StoreFailure"]
    ] as const) {
      const { client } = fakeClient(() => httpError(status))
      const r = await run(makeR2Store(client, "b").putIfMatch("k", '"e"', "{}"))
      expect(Result.isFailure(r) && r.failure._tag, `HTTP ${status}`).toBe(tag)
    }
    const { client } = fakeClient(() => new Error("socket hang up"))
    const r = await run(makeR2Store(client, "b").putIfNoneMatch("k", "{}"))
    expect(Result.isFailure(r) && r.failure._tag).toBe("StoreFailure")
  })

  /*
   * Error mapping as a rule (the example above checks five statuses; the
   * requirement is about all of them). Requirement: a failed write answered
   * with HTTP 412 or 409 is PreconditionFailed, 429 is RateLimited, and every
   * other failure — any other status 100–599, a response without a status, or
   * a non-HTTP error — is StoreFailure; for reads, 404 is "absent" and every
   * other failure follows the same mapping. The domain is finite, so the law
   * is checked exhaustively rather than by sampling.
   */
  const ALL_STATUSES = Array.from({ length: 500 }, (_, i) => 100 + i)
  const expectedTag = (status: number | undefined) =>
    status === 412 || status === 409 ? "PreconditionFailed" : status === 429 ? "RateLimited" : "StoreFailure"
  const failures: ReadonlyArray<{ readonly label: string; readonly status: number | undefined; readonly error: () => unknown }> = [
    ...ALL_STATUSES.map((st) => ({ label: `HTTP ${st}`, status: st as number | undefined, error: () => httpError(st) })),
    { label: "no $metadata", status: undefined, error: () => new Error("socket hang up") },
    { label: "$metadata without status", status: undefined, error: () => Object.assign(new Error("x"), { $metadata: {} }) },
    { label: "thrown string", status: undefined, error: () => "boom" }
  ]
  const throwing = (err: () => unknown): S3Client =>
    ({
      send: async () => {
        throw err()
      }
    }) as unknown as S3Client
  type MakeStore = typeof makeR2Store
  /** Returns the labels of the failure shapes `make` maps against the rule (empty = the rule holds everywhere). */
  const mappingViolations = async (make: MakeStore, includeBlob: boolean): Promise<Array<string>> => {
    const bad: Array<string> = []
    for (const f of failures) {
      const want = expectedTag(f.status)
      const store = make(throwing(f.error), "b")
      const writes: Array<[string, Effect.Effect<unknown, { _tag: string }>]> = [
        ["putIfNoneMatch", store.putIfNoneMatch("k", "{}")],
        ["putIfMatch", store.putIfMatch("k", '"e"', "{}")],
        ...(includeBlob ? [["blob putIfNoneMatch", makeR2BlobStore(throwing(f.error), "b").putIfNoneMatch("k", new Uint8Array([1]))] as [string, Effect.Effect<unknown, { _tag: string }>]] : [])
      ]
      for (const [op, eff] of writes) {
        const r = await run(eff)
        if (!(Result.isFailure(r) && r.failure._tag === want)) bad.push(`${op} ${f.label}`)
      }
      const g = await run(store.get("k"))
      const getOk = f.status === 404 ? Result.isSuccess(g) && Option.isNone(g.success) : Result.isFailure(g) && g.failure._tag === want
      if (!getOk) bad.push(`get ${f.label}`)
    }
    return bad
  }
  /** Load a planted source mutant of the lock store (patched copy next to the original, removed afterwards). */
  const loadStoreMutant = async (from: string, to: string): Promise<MakeStore> => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src/r2Store.ts")
    const code = readFileSync(src, "utf8")
    if (!code.includes(from)) throw new Error(`mutation anchor not found: ${from}`)
    const patched = code.replace(from, to)
    // One file name per distinct patched source, so the module cache never hands back another mutant.
    const file = join(dirname(src), `r2Store.mutant-${process.pid}-${createHash("sha256").update(patched).digest("hex").slice(0, 12)}.ts`)
    writeFileSync(file, patched)
    try {
      return ((await import(pathToFileURL(file).href)) as { makeR2Store: MakeStore }).makeR2Store
    } finally {
      rmSync(file, { force: true })
    }
  }
  /** Mutant 1: 503 ("slow down") also mapped to RateLimited — none of the example statuses is 503. */
  const slowDownIsRateLimited = () => loadStoreMutant("    case 429:\n", "    case 429:\n    case 503:\n")
  /** Mutant 2: a 404 on a write mapped to PreconditionFailed — none of the example statuses is 404. */
  const notFoundIsPrecondition = () => loadStoreMutant("    case 409:\n", "    case 404:\n    case 409:\n")

  it("law (exhaustive): every status 100–599 and every non-HTTP failure is mapped by the rule, on every write path and on reads", async () => {
    expect(await mappingViolations(makeR2Store, true)).toEqual([])
    // Non-degeneracy: the domain exercises all three outcomes and the read-only 404 case.
    expect(new Set(failures.map((f) => expectedTag(f.status)))).toEqual(new Set(["PreconditionFailed", "RateLimited", "StoreFailure"]))
    expect(failures.some((f) => f.status === 404)).toBe(true)
  })

  it("counterexample 1 (mutant: 503 → RateLimited): a write answered 503 must be StoreFailure; the old examples cannot see it", async () => {
    const m = await slowDownIsRateLimited()
    const r = await run(makeR2Store(throwing(() => httpError(503)), "b").putIfMatch("k", '"e"', "{}"))
    expect(Result.isFailure(r) && r.failure._tag).toBe("StoreFailure")
    const rm = await run(m(throwing(() => httpError(503)), "b").putIfMatch("k", '"e"', "{}"))
    expect(Result.isFailure(rm) && rm.failure._tag).toBe("RateLimited")
    for (const st of [412, 409, 429, 500, 403]) {
      const old = await run(m(throwing(() => httpError(st)), "b").putIfMatch("k", '"e"', "{}"))
      expect(Result.isFailure(old) && old.failure._tag, `old example ${st}`).toBe(expectedTag(st))
    }
  })

  it("counterexample 2 (mutant: 404 on write → PreconditionFailed): a create answered 404 must be StoreFailure", async () => {
    const m = await notFoundIsPrecondition()
    const r = await run(makeR2Store(throwing(() => httpError(404)), "b").putIfNoneMatch("k", "{}"))
    expect(Result.isFailure(r) && r.failure._tag).toBe("StoreFailure")
    const rm = await run(m(throwing(() => httpError(404)), "b").putIfNoneMatch("k", "{}"))
    expect(Result.isFailure(rm) && rm.failure._tag).toBe("PreconditionFailed")
  })

  it("negation 1: the exhaustive law is refuted for the 503 → RateLimited mutant, exactly at 503", async () => {
    const bad = await mappingViolations(await slowDownIsRateLimited(), false)
    expect(bad.length).toBeGreaterThan(0)
    expect(new Set(bad.map((b) => b.split(" ").slice(-1)[0]))).toEqual(new Set(["503"]))
  })

  it("negation 2: the exhaustive law is refuted for the 404 → PreconditionFailed mutant, on writes only", async () => {
    const bad = await mappingViolations(await notFoundIsPrecondition(), false)
    expect(bad.sort()).toEqual(["putIfMatch HTTP 404", "putIfNoneMatch HTTP 404"])
  })

  it("GetObject: 404 is none; a body is returned with its ETag; a response without ETag is a failure", async () => {
    const body = (s: string) => ({ transformToString: async () => s })
    const answers: Array<unknown> = [httpError(404), { Body: body('{"a":1}'), ETag: '"e7"' }, { Body: body("{}") }]
    const { client, sent } = fakeClient(() => answers.shift())
    const store = makeR2Store(client, "b")
    expect(await run(store.get("k"))).toEqual(Result.succeed(Option.none()))
    expect(await run(store.get("k"))).toEqual(Result.succeed(Option.some({ body: '{"a":1}', etag: '"e7"' })))
    const noEtag = await run(store.get("k"))
    expect(Result.isFailure(noEtag) && noEtag.failure._tag).toBe("StoreFailure")
    expect(sent.every((s) => s.name === GetObjectCommand.name)).toBe(true)
  })
})

describe("blob store over the S3 API", () => {
  it("blobs are written create-only as octet streams; reads stream the body; 404 is none", async () => {
    async function* chunks() {
      yield new Uint8Array([1, 2])
      yield new Uint8Array([3])
    }
    const answers: Array<unknown> = [{ ETag: '"b"' }, httpError(412), { Body: chunks() }, httpError(404)]
    const { client, sent } = fakeClient(() => answers.shift())
    const blobs = makeR2BlobStore(client, "b")
    expect(Result.isSuccess(await run(blobs.putIfNoneMatch("x", new Uint8Array([1]))))).toBe(true)
    const again = await run(blobs.putIfNoneMatch("x", new Uint8Array([1])))
    expect(Result.isFailure(again) && again.failure._tag).toBe("PreconditionFailed")
    expect(sent[0]!.input).toMatchObject({ IfNoneMatch: "*", ContentType: "application/octet-stream" })
    const s = await Effect.runPromise(blobs.getStream("x"))
    expect(Option.isSome(s)).toBe(true)
    const collected = await Effect.runPromise(Stream.runCollect(Option.getOrThrow(s)))
    expect([...collected].flatMap((c) => [...c])).toEqual([1, 2, 3])
    expect(Option.isNone(await Effect.runPromise(blobs.getStream("y")))).toBe(true)
  })
})

describe("R2 client configuration", () => {
  const base = { R2_BUCKET: "b", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" }

  it("builds the endpoint from the account id (and jurisdiction); nothing set means not configured", () => {
    const account = "0123456789abcdef0123456789abcdef"
    expect(r2ConfigFromEnv({})).toBeNull()
    expect(r2ConfigFromEnv({ ...base, R2_ACCOUNT_ID: account })?.endpoint).toBe(`https://${account}.r2.cloudflarestorage.com`)
    expect(r2ConfigFromEnv({ ...base, R2_ACCOUNT_ID: account, R2_JURISDICTION: "eu" })?.endpoint).toBe(`https://${account}.eu.r2.cloudflarestorage.com`)
    expect(r2ConfigFromEnv({ ...base, R2_ENDPOINT: `https://${account}.r2.cloudflarestorage.com/` })?.endpoint).toBe(
      `https://${account}.r2.cloudflarestorage.com`
    )
  })

  it("rejects partial or malformed configurations with the missing names", () => {
    expect(() => r2ConfigFromEnv({ R2_BUCKET: "b" })).toThrow(/R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT or R2_ACCOUNT_ID/)
    expect(() => r2ConfigFromEnv({ ...base, R2_ACCOUNT_ID: "not-an-id" })).toThrow(R2ConfigError)
    expect(() => r2ConfigFromEnv({ ...base, R2_ENDPOINT: "http://example.com" })).toThrow(/https/)
    expect(() => r2ConfigFromEnv({ ...base, R2_ENDPOINT: "https://x.r2.cloudflarestorage.com/bucket" })).toThrow(/path/)
  })

  it("credentials are Redacted: never printed or serialized, unwrapped only in the client options", () => {
    const account = "0123456789abcdef0123456789abcdef"
    const cfg = r2ConfigFromEnv({ ...base, R2_ACCESS_KEY_ID: "AKID-1234", R2_SECRET_ACCESS_KEY: "sk-5678", R2_ACCOUNT_ID: account })!
    expect(Redacted.isRedacted(cfg.accessKeyId)).toBe(true)
    expect(Redacted.isRedacted(cfg.secretAccessKey)).toBe(true)
    expect(Redacted.value(cfg.accessKeyId)).toBe("AKID-1234")
    expect(Redacted.value(cfg.secretAccessKey)).toBe("sk-5678")
    const printed = [JSON.stringify(cfg), String(cfg.secretAccessKey), inspect(cfg, { depth: 5 })].join("\n")
    expect(printed).not.toContain("AKID-1234")
    expect(printed).not.toContain("sk-5678")
    expect(printed).toContain("<redacted>")
    expect(r2ClientOptions(cfg, "blob").credentials).toEqual({ accessKeyId: "AKID-1234", secretAccessKey: "sk-5678" })
  })

  it("client options: region auto, checksums only when required, SDK retries off for the lock client only", () => {
    const cfg = { endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: Redacted.make("id"), secretAccessKey: Redacted.make("s"), bucket: "b" }
    const lock = r2ClientOptions(cfg, "lock")
    const blob = r2ClientOptions(cfg, "blob")
    for (const o of [lock, blob]) {
      expect(o).toMatchObject({ region: "auto", endpoint: cfg.endpoint, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
    }
    expect(lock).toMatchObject({ maxAttempts: 1 })
    expect("maxAttempts" in blob).toBe(false)
  })

  it("the S3 listing view follows continuation tokens and reports ETags unquoted, like the Workers binding", async () => {
    const pages: Array<unknown> = [
      { Contents: [{ Key: "p/a", Size: 1, ETag: '"x"' }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "p/b", Size: 2, ETag: '"y"' }], IsTruncated: false }
    ]
    const { client, sent } = fakeClient(() => pages.shift())
    const view = makeS3BucketView(client, "b")
    const p1 = await view.list({ prefix: "p/" })
    expect(p1).toEqual({ objects: [{ key: "p/a", size: 1, etag: "x" }], truncated: true, cursor: "t1" })
    const p2 = await view.list({ prefix: "p/", cursor: "t1" })
    expect(p2).toEqual({ objects: [{ key: "p/b", size: 2, etag: "y" }], truncated: false })
    expect(sent.map((s) => s.name)).toEqual([ListObjectsV2Command.name, ListObjectsV2Command.name])
    expect(sent[1]!.input).toMatchObject({ Prefix: "p/", ContinuationToken: "t1" })
  })
})
