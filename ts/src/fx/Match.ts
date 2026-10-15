/**
 * The `Match` module of the Effect v4 facade.
 *
 * @remarks
 * Re-exports the installed `effect/Match` unchanged (the pattern-matching API
 * is the same in v4) and adds {@link unknownValue}, the entry point used at
 * the program's error boundaries: there the error is `unknown` (a caught
 * exception, a rejected promise, the failure rethrown by
 * `runPromiseOrThrow`), and `Match.value(e)` on an `unknown` admits no
 * `Match.tag` case at all.
 *
 * @packageDocumentation
 */
import * as M from "effect/Match"

export * from "effect/Match"

/** A value with no `_tag` (or none of the known ones): what `Match.orElse` receives. */
export interface Untagged {
  readonly _tag?: undefined
}

/**
 * Starts a match on an `unknown` error, typed as one of the `Known` tagged
 * errors or something else, so that `Match.tag` cases (`skills.md` § 11) can
 * classify it and `Match.orElse` handles the rest.
 *
 * @remarks
 * The type is a claim, not a check: `Match.tag("X", …)` matches any object
 * whose `_tag` is `"X"`, which is how `Data.TaggedError` values are
 * discriminated everywhere in Effect. A value that is not an object, or has
 * no matching `_tag`, falls through to the next case. Classes that are not
 * tagged (built-in `RangeError`, plain `Error` subclasses) are matched with
 * `Match.when(Match.instanceOf(C), …)`.
 *
 * @typeParam Known - The tagged errors the boundary classifies.
 * @param u - The caught value.
 * @returns A matcher over `Known | Untagged`.
 */
export const unknownValue = <Known extends { readonly _tag: string }>(u: unknown) => M.value(u as Known | Untagged)
