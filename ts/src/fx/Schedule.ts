/**
 * The `Schedule` module, re-exported from `effect/Schedule` (Effect v4).
 *
 * @remarks
 * Callbacks of `modifyDelay`, `tap` and `while` receive the recurrence
 * metadata `{ attempt, input, output, duration, elapsed, ... }`; combine
 * schedules with `Schedule.max([...])` / `Schedule.min([...])` and bound them
 * with `Schedule.upTo({ times, duration })`.
 *
 * @packageDocumentation
 */
export * from "effect/Schedule"
