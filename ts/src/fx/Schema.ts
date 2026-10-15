/**
 * The `Schema` module, re-exported from `effect/Schema` (Effect v4).
 *
 * @remarks
 * Decode at boundaries with `Schema.decodeUnknownResult` (pure) or
 * `Schema.decodeUnknownEffect` (in an effect); both fail with
 * `Schema.SchemaError`, whose `message` is the human-readable report.
 * Refine with `Schema.check(Schema.isInt(), Schema.makeFilter(...))`; give
 * absent struct keys a default with
 * `X.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))`.
 *
 * @packageDocumentation
 */
export * from "effect/Schema"
