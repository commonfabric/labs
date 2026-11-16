/**
 * A seeded `Math.random` for the comparison of values: a handler that
 * draws a number draws the same one on today's runtime and on the
 * executor, when both are seeded alike before the event.
 *
 * Today's runtime gives sandboxed code a `Math` whose `random` calls the
 * `Math.random` of the host realm while a handler runs (`sandboxRandom`
 * in `runtime/runner/src/builder/safe-builtins.ts`), and the executor
 * runs a body in the host realm, so replacing the host's function seeds
 * both. Anything else of the process that calls `Math.random` while the
 * replacement is in place draws from the same sequence.
 */

const original = Math.random;

/** What a call of `Math.random` draws from now. */
let current: () => number = original;

/**
 * Whether `Math.random` of this realm is the function that draws from
 * `current`. It is installed when this module is loaded, which is before
 * today's runtime freezes the intrinsics of the realm (`lockdown` of
 * SES, in `runtime/runner/src/sandbox/ses-runtime.ts`): afterwards the
 * function cannot be replaced, and it does not have to be.
 */
let installed = false;
try {
  Math.random = () => current();
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
  current = generator(seed);
  return installed;
};

/** Has `Math.random` draw from the realm's own generator again. */
export const restoreRandom = (): void => {
  current = original;
};

/** The seed of the event at an index of a scenario's events. */
export const eventSeed = (index: number): number => 0x9e3779b9 + index;
