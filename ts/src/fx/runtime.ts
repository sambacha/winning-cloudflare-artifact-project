/**
 * Running effects at the edge of the program (process entry points, HTTP
 * handlers, Promise-based callers).
 *
 * @remarks
 * `Effect.runPromise` rejects with a wrapper around the failure. Callers at
 * a boundary usually classify errors with `instanceof` (`UsageError` maps to
 * exit status 2, `SessionConflict` to HTTP 409, ...), so they need the typed
 * failure itself. {@link runPromiseOrThrow} awaits the `Exit` and rethrows
 * the failure value unchanged; defects and interruptions are rethrown as the
 * squashed cause.
 *
 * @packageDocumentation
 */
import { Fiber } from "effect"
import * as Cause from "./Cause.js"
import * as Exit from "./Exit.js"
import * as Effect from "./Effect.js"

/**
 * Runs `self` and resolves with its value, or rejects with its typed failure
 * value (not a wrapper).
 *
 * @param self - An effect with no remaining requirements.
 * @param options - Optional `signal`: aborting it interrupts the effect.
 * @returns The success value.
 * @throws The failure value of `self`, or the squashed cause of a defect or interruption.
 */
export const runPromiseOrThrow = async <A, E>(
  self: Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal }
): Promise<A> => {
  const exit = await Effect.runPromiseExit(self, options?.signal === undefined ? undefined : { signal: options.signal })
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findError(exit.cause)
  if (failure._tag === "Success") throw failure.success
  throw Cause.squash(exit.cause)
}

/**
 * Wraps a Promise-returning entry point that supports cancellation through an
 * `AbortSignal` as an effect whose interruption is graceful: interrupting the
 * fiber aborts the signal and then **waits** for the promise to settle, so
 * the entry point's own teardown (killing child processes, abandoning held
 * locks, closing a server) completes before the fiber's interruption does.
 *
 * @remarks
 * `Effect.tryPromise` also aborts its signal on interruption, but it does not
 * wait for the promise: under {@link runMain} the process would exit before
 * the teardown ran. This is the bridge used by the CLI entry points, whose
 * `main` functions are Promise-based (their tests call them directly).
 * A rejection of the promise is a defect (the entry points resolve with an
 * exit status and do not reject).
 *
 * @param run - Starts the work; must stop promptly once `signal` is aborted.
 * @returns The effect, resolving with the promise's value.
 */
export const fromAbortablePromise = <A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> =>
  Effect.callback<A>((resume: (effect: Effect.Effect<A>) => void) => {
    const controller = new AbortController()
    const settled = run(controller.signal)
    settled.then(
      (a) => resume(Effect.succeed(a)),
      (e: unknown) => resume(Effect.die(e))
    )
    return Effect.promise(() => {
      controller.abort()
      return settled.then(
        () => undefined,
        () => undefined
      )
    })
  })

/** Options of {@link runMain}. */
export interface RunMainOptions {
  /** Called on the first SIGINT/SIGTERM, before the main fiber is interrupted. */
  readonly onSignal?: (signal: NodeJS.Signals) => void
  /** Exit status when the main fiber was interrupted (default 130). */
  readonly interruptedExitCode?: number
  /** Writes the rendered cause of an unexpected failure (default: stderr). */
  readonly report?: (text: string) => void
}

/**
 * Runs the program's main effect as the process: the Node.js counterpart of
 * `NodeRuntime.runMain` from `@effect/platform-node` (style guide § 2.2),
 * which is not installed in this repository.
 *
 * @remarks
 * - The first SIGINT/SIGTERM interrupts the main fiber, so finalizers
 *   (`Effect.addFinalizer`, `acquireRelease`, `onInterrupt`, the cancel
 *   effect of `Effect.callback`) run before the process exits; a second
 *   signal exits at once.
 * - Success with a number sets that exit status (CLIs compute their own);
 *   any other success exits 0.
 * - Interruption exits with `interruptedExitCode` (130).
 * - A failure or defect is rendered with `Cause.pretty` and exits 1.
 * - The process is kept alive until the main fiber ends: an Effect v4 fiber
 *   suspended on `Effect.never` (or on a `Deferred`) holds no Node.js handle,
 *   so without the keep-alive timer the event loop would drain and the
 *   process would exit 0 with the fiber still running.
 *
 * @param self - The main effect; teardown belongs inside it.
 * @param options - Signal hook, interruption status, failure reporter.
 */
export const runMain = <A, E>(self: Effect.Effect<A, E>, options: RunMainOptions = {}): void => {
  // The handlers are installed before the fiber starts: a signal that
  // arrives while the main effect is still starting up must interrupt it
  // too, not kill the process with Node's default action.
  let fiber: Fiber.Fiber<A, E> | undefined
  let signalled = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) process.exit(options.interruptedExitCode ?? 130)
    signalled = true
    options.onSignal?.(signal)
    if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  const keepAlive = setInterval(() => undefined, 2 ** 31 - 1)
  fiber = Effect.runFork(self)
  if (signalled) Effect.runFork(Fiber.interrupt(fiber))
  fiber.addObserver((exit: Exit.Exit<A, E>) => {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    clearInterval(keepAlive)
    if (Exit.isSuccess(exit)) {
      process.exit(typeof exit.value === "number" ? exit.value : 0)
    }
    if (Cause.hasInterruptsOnly(exit.cause)) process.exit(options.interruptedExitCode ?? 130)
    ;(options.report ?? ((t: string) => process.stderr.write(`${t}\n`)))(Cause.pretty(exit.cause))
    process.exit(1)
  })
}
