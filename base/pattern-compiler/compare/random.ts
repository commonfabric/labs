/**
 * A seeded `Math.random` for the comparison of values: a handler that
 * draws a number draws the same one on today's runtime and on the
 * executor, when both are seeded alike before the event.
 *
 * Today's runtime gives sandboxed code a `Math` whose `random` calls the
 * `Math.random` of the host realm while a handler runs (`sandboxRandom`
 * in `runtime/runner/src/builder/safe-builtins.ts`), and the executor
 * runs a body in the host realm, so replacing the host's function seeds
 * both. The replacement gives a seeded draw to those two callers alone:
 * to a call of `Math.random()` made while a handler of today's runtime
 * runs, and to one made while the executor handles an event (`drawing`).
 * Any other caller in the process gets a draw of the realm's own
 * generator and takes none of the sequence. Code of the runtime that
 * draws with `Math.random()` inside a handler's run cannot be told from
 * the handler: `seedRandom` keeps the one such caller that was found, the
 * logger's timing statistics, from drawing.
 */
import { resetAllTimingStats } from "@commonfabric/logger";

import { getTopFrame } from "../../../runtime/runner/src/builder/pattern.ts";

const original = Math.random;

/** The seed of the event being handled, where one is. */
let seeded: number | undefined;

/** What a seeded call of `Math.random` draws from now. */
let current: (() => number) | undefined;

/** The frame of the run of a handler that drew last, in today's runtime. */
let invocation: unknown;

/** Whether the executor is handling an event. */
let executing = false;

/**
 * Whether `Math.random` of this realm is the function that draws from
 * `current`. It is installed when this module is loaded, which is before
 * today's runtime freezes the intrinsics of the realm (`lockdown` of
 * SES, in `runtime/runner/src/sandbox/ses-runtime.ts`): afterwards the
 * function cannot be replaced, and it does not have to be.
 */
let installed = false;
try {
  Math.random = function (this: unknown): number {
    // The runtime's own draws, as the jitter of a retry's delay
    // (`computeBackoffDelayMs` in
    // `runtime/runner/src/scheduler/backpressure.ts`), call the function
    // with no receiver, and take none of the sequence.
    if (seeded === undefined || this !== Math) return original();
    if (executing) return (current ??= generator(seeded))();
    const frame = getTopFrame();
    if (frame?.inHandler !== true) return original();
    // Today's runtime can run the handler of one event more than once,
    // as when a first run read something that was not loaded: each run
    // has a frame of its own and starts the sequence again.
    if (frame !== invocation) {
      invocation = frame;
      current = generator(seeded);
    }
    return (current ??= generator(seeded))();
  };
  installed = true;
} catch {
  // The intrinsics were frozen before this module was loaded.
}

/** The generator `mulberry32`, as a function that gives the next draw. */
const generator = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Has `Math.random` draw from a generator that starts from `seed`.
 * Returns whether the realm's function is the one this module installed.
 */
export const seedRandom = (seed: number): boolean => {
  // The timing statistics of the logger draw from `Math.random()` once a
  // statistic holds its full number of samples (`TimingDataStore.record` in
  // `base/logger/src/logger.ts`), and they record inside a handler's run.
  // Emptied here, they draw nothing while the event is handled, unless
  // one statistic takes that number of samples in the one event.
  resetAllTimingStats();
  seeded = seed;
  current = undefined;
  invocation = undefined;
  return installed;
};

/** Has `Math.random` draw from the realm's own generator again. */
export const restoreRandom = (): void => {
  seeded = undefined;
  current = undefined;
  invocation = undefined;
};

/** Runs what the executor does for an event, with its draws seeded. */
export const drawing = <T>(run: () => T): T => {
  executing = true;
  try {
    return run();
  } finally {
    executing = false;
  }
};

/** The seed of the event at an index of a scenario's events. */
export const eventSeed = (index: number): number => 0x9e3779b9 + index;
