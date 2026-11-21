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

/** The time of day `scenarioGlobals` gives before the first event. */
const SCENARIO_START = Date.UTC(2026, 0, 1);

/**
 * The time of day the value code of a run with `scenarioGlobals` reads:
 * one time for the start and one for each event, a minute apart, set by
 * `seedRandom` and kept after the event for what is evaluated later.
 */
let scenarioTime = SCENARIO_START;

/** A `Date` whose time without an argument is `scenarioTime`. */
class ScenarioDate extends Date {
  constructor(...given: unknown[]) {
    super(...((given.length === 0 ? [scenarioTime] : given) as [number]));
  }

  static override now(): number {
    return scenarioTime;
  }
}

/** A `crypto` whose draws are draws of `Math.random`. */
const scenarioCrypto = {
  subtle: crypto.subtle,
  getRandomValues: <T extends ArrayBufferView>(into: T): T => {
    const bytes = new Uint8Array(into.buffer, into.byteOffset, into.byteLength);
    for (let at = 0; at < bytes.length; at++) {
      bytes[at] = Math.floor(Math.random() * 256);
    }
    return into;
  },
  randomUUID: (): string => {
    const hex = Array.from(
      scenarioCrypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `8${hex.slice(17, 20)}`,
      hex.slice(20),
    ].join("-");
  },
};

/**
 * The globals of the value code of a run whose values depend on no time of
 * day and on no draw outside the seeded sequence (`Instance`'s option
 * `globals`): `Date` gives the time of the event being handled, the same
 * in every run, and `crypto` draws from `Math.random`, which `seedRandom`
 * seeds for the event.
 */
export const scenarioGlobals: Record<string, unknown> = {
  Date: ScenarioDate,
  crypto: scenarioCrypto,
};

/**
 * Has `Math.random` draw from a generator that starts from `seed`, and
 * sets the time of day of `scenarioGlobals` to that of the event the seed
 * is of (`eventSeed`). Returns whether the realm's function is the one
 * this module installed.
 */
export const seedRandom = (seed: number): boolean => {
  scenarioTime = SCENARIO_START + (seed - eventSeed(-1)) * 60_000;
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
