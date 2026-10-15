/**
 * The single entry point through which this package uses Effect.
 *
 * @remarks
 * Every module imports Effect from here, never from `"effect"` directly (the
 * facade lint test and the Oxlint `no-restricted-imports` rule enforce
 * this). The modules re-exported here are written against the Effect v4 API
 * documented at {@link https://effect.website/docs/v4/getting-started}.
 * Until `effect@4` can be installed, the modules in this directory implement
 * the v4 names over the installed v3 package; switching to v4 replaces the
 * contents of this directory with plain re-exports (see
 * `docs/effect-v4-refactor.md`, section "Cut-over").
 *
 * @packageDocumentation
 */
export * as Brand from "./Brand.js"
export * as Cache from "./Cache.js"
export * as Cause from "./Cause.js"
export * as Duration from "./Duration.js"
export * as Effect from "./Effect.js"
export * as Exit from "./Exit.js"
export * as Match from "./Match.js"
export * as Metric from "./Metric.js"
export * as Result from "./Result.js"
export * as Schedule from "./Schedule.js"
export * as Schema from "./Schema.js"
export { fromAbortablePromise, runMain, type RunMainOptions, runPromiseOrThrow } from "./runtime.js"
export { Chunk, Clock, Console, Data, Deferred, Fiber, Option, pipe, Redacted, Ref, Scope, Stream } from "effect"
