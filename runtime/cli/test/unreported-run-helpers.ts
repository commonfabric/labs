/**
 * One process's worth of the process-end guard's effects, plus the ending
 * Deno performs when the event loop drains around a promise that never
 * settles: the unload hook runs, and then the exit code stands.
 *
 * Shared by the guard's own tests and by every command that arms one, so all
 * of them observe the same ending rather than each modelling it a little
 * differently.
 */

import type { UnreportedRunDeps } from "../lib/unreported-run.ts";

export interface GuardHarness {
  /** The effects to hand a command as its `guard` dependency. */
  deps: UnreportedRunDeps;

  /** What the guard reported, in order. */
  errors: string[];

  /** End the process; returns the code it ends with. */
  endProcess: () => number;
}

/** A harness whose process is ending with `startingExitCode` (0 by default). */
export function guardHarness(startingExitCode = 0): GuardHarness {
  const errors: string[] = [];
  let exitCode = startingExitCode;
  let hook: (() => void) | undefined;
  return {
    errors,
    deps: {
      addUnloadListener: (handler) => {
        hook = handler;
      },
      printError: (message) => {
        errors.push(message);
      },
      readExitCode: () => exitCode,
      setExitCode: (code) => {
        exitCode = code;
      },
    },
    endProcess: () => {
      hook?.();
      return exitCode;
    },
  };
}
