/**
 * A local durable step runner with the replay semantics of Cloudflare
 * Workflows' `step.do`, for tests and the offline demo:
 *
 * - a step whose name has a stored output is **not** run again; its stored
 *   output is returned (the replay of a restarted instance);
 * - otherwise the body runs and its output is stored (JSON round-trip, as
 *   Workflows serialises step outputs) before it is returned.
 *
 * Outputs live in a {@link StepJournal}: in memory, or a JSON file so a real
 * process can be killed and restarted. A crash can be injected at two points
 * to exercise recovery:
 *
 * - `crashBefore: n` - throw {@link SimulatedCrash} before running the n-th
 *   *new* (not replayed) step: the instance died between steps;
 * - `crashAfterBody: n` - run the n-th new step's body, then throw before its
 *   output is stored: the instance died after the step's side effects but
 *   before Workflows checkpointed it (the step will run again on restart).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { StepLike } from "./bisectDriver.js"

/** Thrown by an injected crash. */
export class SimulatedCrash extends Error {
  override readonly name = "SimulatedCrash"
  /** @param step - The step at which the instance "died". */
  constructor(readonly step: string) {
    super(`simulated crash at step ${step}`)
  }
}

/** Where completed step outputs are kept. */
export interface StepJournal {
  readonly get: (name: string) => { readonly value: unknown } | undefined
  readonly set: (name: string, value: unknown) => void
  /** Completed step names, in completion order. */
  readonly names: () => ReadonlyArray<string>
}

/** An in-memory journal (survives a simulated crash, not a process exit). */
export const memoryJournal = (): StepJournal => {
  const m = new Map<string, string>()
  return {
    get: (name) => (m.has(name) ? { value: JSON.parse(m.get(name)!) } : undefined),
    set: (name, value) => void m.set(name, JSON.stringify(value ?? null)),
    names: () => [...m.keys()]
  }
}

/**
 * A journal in a JSON file, rewritten atomically (write + rename) after every
 * step, so killing the process at any point leaves a consistent journal.
 *
 * @param file - Journal path.
 */
export const fileJournal = (file: string): StepJournal => {
  const load = (): Array<[string, unknown]> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Array<[string, unknown]>) : [])
  return {
    get: (name) => {
      const e = load().find(([n]) => n === name)
      return e === undefined ? undefined : { value: e[1] }
    },
    set: (name, value) => {
      const entries = load().filter(([n]) => n !== name)
      entries.push([name, JSON.parse(JSON.stringify(value ?? null))])
      writeFileSync(`${file}.tmp`, JSON.stringify(entries))
      renameSync(`${file}.tmp`, file)
    },
    names: () => load().map(([n]) => n)
  }
}

/** Options of {@link makeLocalSteps}. */
export interface LocalStepsOptions {
  readonly journal: StepJournal
  /** Crash before the n-th new step (1-based). */
  readonly crashBefore?: number
  /** Crash after the n-th new step's body, before storing its output (1-based). */
  readonly crashAfterBody?: number
}

/** A {@link StepLike} plus counters of what actually ran. */
export interface LocalSteps extends StepLike {
  /** Names of step bodies that ran in this instance (replays excluded). */
  readonly ran: ReadonlyArray<string>
  /** Names of steps answered from the journal. */
  readonly replayed: ReadonlyArray<string>
}

/**
 * A durable `step` for one run of an instance.
 *
 * @param opts - Journal and optional crash point.
 */
export const makeLocalSteps = (opts: LocalStepsOptions): LocalSteps => {
  const ran: Array<string> = []
  const replayed: Array<string> = []
  let fresh = 0
  return {
    ran,
    replayed,
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const hit = opts.journal.get(name)
      if (hit !== undefined) {
        replayed.push(name)
        return hit.value as T
      }
      fresh += 1
      if (opts.crashBefore === fresh) throw new SimulatedCrash(name)
      ran.push(name)
      const value = await fn()
      if (opts.crashAfterBody === fresh) throw new SimulatedCrash(name)
      opts.journal.set(name, value)
      // Return what a replay would return (the serialised form), never a live reference.
      return opts.journal.get(name)!.value as T
    }
  }
}
