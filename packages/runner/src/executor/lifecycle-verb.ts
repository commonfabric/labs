/**
 * What running a lifecycle verb yields or fails with, as the serving worker's
 * port and the browser-reachable piece operations both name it. Nothing here
 * imports the executor host or its store, which is what lets a browser bundle
 * hold these types without the SQLite module behind the host.
 */

/**
 * One step the serving side timed while running a lifecycle verb: `phase`
 * names it as `<verb>.<step>`, `ms` is its length in whole milliseconds.
 */
export type LifecyclePhaseTiming = { phase: string; ms: number };

/**
 * What running a lifecycle verb from a descriptor yields: the verb's receipt,
 * and the steps the serving side timed in the order they happened — the
 * session it opened (`session`), the wait for a cycle of the loop to take the
 * verb (`queue`), the verb's run (`run`), the wave commit after it (`commit`)
 * and the durability read (`confirm`). A step that never finished is left
 * out.
 */
export type LifecycleVerbRun = {
  receipt: unknown;
  timings: LifecyclePhaseTiming[];
};

/** A failed lifecycle verb, retaining the phases completed before failure. */
export class LifecycleVerbFailure extends Error {
  readonly #timings: readonly LifecyclePhaseTiming[];
  readonly #code: string | undefined;

  constructor(cause: unknown, timings: readonly LifecyclePhaseTiming[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.#timings = [...timings];
    this.name = cause instanceof Error ? cause.name : "Error";
    if (cause instanceof Error) this.stack = cause.stack;
    const code = cause instanceof Error
      ? (cause as { code?: unknown }).code
      : undefined;
    this.#code = typeof code === "string" ? code : undefined;
  }

  /** The steps that completed before the failure, in the order they ran. */
  get timings(): readonly LifecyclePhaseTiming[] {
    return this.#timings;
  }

  /** The cause's refusal code, when it carried one as a string. */
  get code(): string | undefined {
    return this.#code;
  }
}
