#!/usr/bin/env -S deno run --allow-env=CF_TEST_SHUFFLE_SEED --allow-run=git

/**
 * Prints the seed every test runner in this repository shuffles by, so
 * that a `deno test` spelled in a task can be handed it.
 *
 * With `--tomorrow`, it prints the seed of the Pacific day after the
 * current one instead, which is the order the next day's commits will run
 * in. The scheduled workflow in `.github/workflows/test-order-tomorrow.yml`
 * runs the suites in that order.
 *
 * The seed goes to standard output alone, which is what a command
 * substitution reads. The line naming it goes to standard error, so that
 * a run reports the order it took whether or not anyone thought to ask.
 */

import {
  nextDaySeed,
  shuffleNotice,
  shuffleSeed,
} from "@commonfabric/test-support/shuffle";

/**
 * The seed `args` ask for at `now`. An argument other than `--tomorrow`
 * throws.
 */
export function requestedSeed(args: readonly string[], now: Date): number {
  if (args.length === 0) return shuffleSeed();
  if (args.length === 1 && args[0] === "--tomorrow") return nextDaySeed(now);
  throw new Error(
    `test-seed takes no argument, or --tomorrow; it was given: ${
      args.join(" ")
    }`,
  );
}

/**
 * Runs the command line `args` at `now`, and returns the status to exit
 * with. The seed goes to `print` and the line naming it to `announce`; a
 * command line this refuses prints nothing and says why to `announce`.
 */
export function main(
  args: readonly string[],
  now: Date,
  print: (line: string) => void = console.log,
  announce: (line: string) => void = console.error,
): number {
  let seed: number;
  try {
    seed = requestedSeed(args, now);
  } catch (error) {
    announce(error instanceof Error ? error.message : String(error));
    return 2;
  }
  announce(shuffleNotice(seed));
  print(String(seed));
  return 0;
}

if (import.meta.main) Deno.exitCode = main(Deno.args, new Date());
