/**
 * Merkle lookup keys (decision D-2).
 *
 * The lookup digest of a package hashes, in an unambiguous encoding:
 *
 * - a domain-separation tag and the key-derivation version;
 * - the repository-committed flush salt (changing it by a commit is the
 *   "invalidate everything" button; no runtime epoch key exists);
 * - the toolchain / environment fingerprint;
 * - the package's own inputs (path → content digest), sorted by path;
 * - the lookup digests of its direct dependencies, sorted.
 *
 * There is deliberately no field for a branch, an epoch or a timestamp: the
 * types below do not admit one. Equal digests imply equal inputs at every
 * transitive dependency, assuming a collision-free hash
 * (`merkle_key_eq_inputs_eq`, `merkle_key_changes`). Dropping the dependency
 * digests gives stale hits (`shallow_key_stale_hit`). A package none of whose
 * transitive inputs changed keeps its key (`merkle_unaffected_preserved`).
 *
 * The scope is *not* hashed: it is the first key component (`manifestKey`).
 * That way an untrusted job finds the trusted entry for the same inputs.
 */
import { Data } from "../fx/index.js"
import { type Digest, digestBytes, formatDigest } from "./digest.js"
import { encodeKey } from "./keyEncoding.js"
import type { Scope } from "./scope.js"

export const KEY_DERIVATION = "rush-cache/lookup/v1"

export interface InputFile {
  /** Repository-relative path with `/` separators. */
  readonly path: string
  readonly digest: Digest
}

export interface KeyEnvironment {
  /** Constant committed in the repository; change it to flush every entry. */
  readonly flushSalt: string
  /** Toolchain / environment fingerprint (node version, OS, lockfile hash, …). */
  readonly toolchain: string
}

export interface PackageInputs {
  readonly inputs: ReadonlyArray<InputFile>
  readonly deps: ReadonlyArray<string>
}

export class DuplicateInputPath extends Data.TaggedError("DuplicateInputPath")<{ readonly path: string }> {}
export class DependencyCycle extends Data.TaggedError("DependencyCycle")<{ readonly cycle: ReadonlyArray<string> }> {}
export class UnknownDependency extends Data.TaggedError("UnknownDependency")<{
  readonly from: string
  readonly dep: string
}> {}

const utf8 = new TextEncoder()

/** Length-prefixed (u32 big-endian) field encoding: no two field lists share an encoding. */
const field = (parts: Array<Uint8Array>, s: string) => {
  const b = utf8.encode(s)
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, b.length)
  parts.push(len, b)
}

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The canonical byte string that is hashed. Exposed for tests. */
export const canonicalLookupInput = (
  env: KeyEnvironment,
  inputs: ReadonlyArray<InputFile>,
  depDigests: ReadonlyArray<Digest>
): Uint8Array => {
  const files = [...inputs].sort((a, b) => byCodeUnits(a.path, b.path))
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.path === files[i - 1]!.path) throw new DuplicateInputPath({ path: files[i]!.path })
  }
  const deps = depDigests.map(formatDigest).sort(byCodeUnits)
  const parts: Array<Uint8Array> = []
  field(parts, KEY_DERIVATION)
  field(parts, env.flushSalt)
  field(parts, env.toolchain)
  field(parts, String(files.length))
  for (const f of files) {
    field(parts, f.path)
    field(parts, formatDigest(f.digest))
  }
  field(parts, String(deps.length))
  for (const d of deps) field(parts, d)
  return concat(parts)
}

export const lookupDigest = (
  env: KeyEnvironment,
  inputs: ReadonlyArray<InputFile>,
  depDigests: ReadonlyArray<Digest>
): Digest => digestBytes(canonicalLookupInput(env, inputs, depDigests))

/**
 * Lookup digests for every package of an acyclic dependency graph. Each
 * package's digest covers its dependencies' digests, hence (by induction on
 * the graph) all transitive inputs.
 */
export const computeLookupDigests = (
  env: KeyEnvironment,
  graph: ReadonlyMap<string, PackageInputs>
): Map<string, Digest> => {
  const done = new Map<string, Digest>()
  const onStack: Array<string> = []
  const visit = (id: string): Digest => {
    const cached = done.get(id)
    if (cached) return cached
    const at = onStack.indexOf(id)
    if (at >= 0) throw new DependencyCycle({ cycle: [...onStack.slice(at), id] })
    const node = graph.get(id)!
    onStack.push(id)
    const depDigests = node.deps.map((dep) => {
      if (!graph.has(dep)) throw new UnknownDependency({ from: id, dep })
      return visit(dep)
    })
    onStack.pop()
    const d = lookupDigest(env, node.inputs, depDigests)
    done.set(id, d)
    return d
  }
  for (const id of graph.keys()) visit(id)
  return done
}

/** Object key of the manifest for a lookup digest in a scope: `v1/<scope>/m/<alg:hex>/`. */
export const manifestKey = (scope: Scope, lookup: Digest): string =>
  encodeKey([scope, "m", formatDigest(lookup)])

/** Object key of a content-addressed blob: `v1/<scope>/b/<alg:hex>/`. */
export const blobKey = (scope: Scope, content: Digest): string =>
  encodeKey([scope, "b", formatDigest(content)])
