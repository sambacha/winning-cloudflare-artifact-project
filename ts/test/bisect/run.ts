/**
 * Promise adapters for tests: run the bisect effects with
 * `runPromiseOrThrow`, so that `await expect(p).rejects.toThrow(Class)`
 * observes the typed failure itself.
 *
 * @packageDocumentation
 */
import {
  type ArtifactsNamespaceLike,
  type ArtifactsRepoLike,
  checkoutCredentials as checkoutCredentialsEffect,
  type CommitInfo,
  type CommitLog,
  commitRange as commitRangeEffect,
  type TokenScope,
  withRepo as withRepoEffect
} from "../../src/bisect/index.js"
import { type Duration, Effect, type Exit, Option, runPromiseOrThrow } from "../../src/fx/index.js"
import { TestClock } from "../../src/fx/testing.js"

/** Lifts a test callback that returns either an effect or a Promise. */
export const lift = <A>(r: Effect.Effect<A, unknown> | Promise<A>): Effect.Effect<A, unknown> =>
  Effect.isEffect(r) ? r : Effect.tryPromise({ try: () => r, catch: (e) => e })

/** `withRepo` as a Promise; `use` may return an effect or a Promise. */
export const withRepo = <A>(
  ns: ArtifactsNamespaceLike,
  name: string,
  use: (h: ArtifactsRepoLike) => Effect.Effect<A, unknown> | Promise<A>
): Promise<A> => runPromiseOrThrow(withRepoEffect(ns, name, (h) => lift(use(h))))

/** `commitRange` as a Promise. */
export const commitRange = (repo: CommitLog, goodRef: string, badRef: string, max?: number): Promise<ReadonlyArray<CommitInfo>> =>
  runPromiseOrThrow(commitRangeEffect(repo, goodRef, badRef, max))

/** `checkoutCredentials` as a Promise. */
export const checkoutCredentials = (repo: ArtifactsRepoLike, scope: TokenScope, ttl: Duration.Duration) =>
  runPromiseOrThrow(checkoutCredentialsEffect(repo, scope, ttl))

/**
 * Runs `effect` against the test clock, advancing virtual time until it
 * completes (`skills.md` § 15: fork, adjust, join). Each round yields one
 * macrotask, so that real I/O promises (a fake `fetch`) settle, then moves
 * the clock far enough to wake any pending `Effect.sleep` or schedule delay.
 *
 * @param effect - The effect to run; it may sleep and await promises.
 * @returns Its exit, so that tests can inspect failures.
 */
export const runVirtual = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect)
      for (;;) {
        const done = yield* Effect.sync(() => Option.fromUndefinedOr(fiber.pollUnsafe()))
        if (Option.isSome(done)) return done.value
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
        yield* TestClock.adjust("1 hour")
      }
    }).pipe(Effect.provide(TestClock.layer()))
  )
