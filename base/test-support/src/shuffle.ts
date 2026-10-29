/**
 * The seed every test runner in this repository shuffles by, and the
 * permutation the runners this repository owns apply with it.
 *
 * A test that needs another test to have run before it passes for as
 * long as nothing disturbs the order, and a runner walks its tests in
 * declaration order. Shuffling disturbs that order on a schedule, so
 * such a dependence surfaces as a failed run.
 *
 * The seed is the date, in the Pacific time zone and written `YYYYMMDD`,
 * on which the commit under test was committed. So one commit runs in
 * one order wherever and whenever it runs: every job of a run, every
 * later attempt at that run, and a workstation checking it out all
 * agree. The order moves on with the commits, one new order per Pacific
 * day. This repository calls a test flaky when it passes and fails at
 * the same commit, and withholds a test that flakes often enough from
 * pull requests; a commit that could run in two orders would give every
 * order-dependent test that signature, and it would be withheld rather
 * than fixed.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

/** Names the seed to use, in place of the commit's. */
export const SHUFFLE_SEED_VARIABLE = "CF_TEST_SHUFFLE_SEED";

/**
 * The zone whose midnight divides one seed from the next. Named rather
 * than computed from an offset, because the zone spends part of the year
 * eight hours behind Coordinated Universal Time and part of it seven.
 */
const SEED_TIME_ZONE = "America/Los_Angeles";

const SEED_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: SEED_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The date `moment` falls on in the Pacific time zone, as `YYYYMMDD`. */
export function daySeed(moment: Date): number {
  const parts = SEED_DATE_FORMAT.formatToParts(moment);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return Number(`${field("year")}${field("month")}${field("day")}`);
}

/**
 * The seed of the Pacific day after the one `moment` falls on, which is
 * the order the commits of that day will run in. The next day is found on
 * the calendar rather than by adding a day's worth of time to `moment`,
 * because the zone's days are not all the same length.
 */
export function nextDaySeed(moment: Date): number {
  const today = daySeed(moment);
  const next = new Date(Date.UTC(
    Math.floor(today / 10000),
    Math.floor(today / 100) % 100 - 1,
    today % 100 + 1,
  ));
  return next.getUTCFullYear() * 10000 + (next.getUTCMonth() + 1) * 100 +
    next.getUTCDate();
}

/**
 * When a commit was committed, or nothing where git cannot say: `rev`
 * as the repository at `cwd` resolves it, which is the commit checked
 * out there unless a caller names another. The committer date rather
 * than the author's: a rebased or cherry-picked commit keeps the date it
 * was first written, which can be arbitrarily old, while the committer
 * date moves with the tree.
 */
export function commitMoment(
  cwd: string = Deno.cwd(),
  rev: string = "HEAD",
): Date | undefined {
  let output: Deno.CommandOutput;
  try {
    output = new Deno.Command("git", {
      args: ["log", "-1", "--format=%cI", rev],
      cwd,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
  } catch (error) {
    // No git to ask is a checkout with no commit to name. A process that
    // may not run git is a caller missing a permission, which is not.
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!output.success) return undefined;
  const moment = new Date(new TextDecoder().decode(output.stdout).trim());
  return Number.isNaN(moment.getTime()) ? undefined : moment;
}

/**
 * The seed an override names, or otherwise the one `moment` falls in. An
 * override that is not a non-negative integer, or is too large to hold
 * without rounding, throws: a run that ignored or rounded it would report
 * an order nobody asked for under a seed somebody chose.
 */
export function parseSeed(override: string | undefined, moment: Date): number {
  if (override === undefined || override === "") return daySeed(moment);
  const seed = Number(override);
  if (!/^\d+$/.test(override) || !Number.isSafeInteger(seed)) {
    throw new Error(
      `${SHUFFLE_SEED_VARIABLE} is "${override}", which is not a ` +
        `non-negative integer this process can hold exactly.`,
    );
  }
  return seed;
}

/**
 * The seed this process shuffles by: the environment's override where
 * there is one, and otherwise the day the commit checked out at `cwd`
 * was committed. Outside a git checkout it is today's.
 */
export function shuffleSeed(cwd: string = Deno.cwd()): number {
  return parseSeed(
    Deno.env.get(SHUFFLE_SEED_VARIABLE),
    commitMoment(cwd) ?? new Date(),
  );
}

/**
 * Settles the seed for this process and every process it starts, and
 * names it on standard error. A run that starts several test runners
 * calls this once, so that every one of them takes the seed from the
 * environment rather than each asking git for it.
 */
export function pinShuffleSeed(
  announce: (line: string) => void = console.error,
): number {
  const seed = shuffleSeed();
  Deno.env.set(SHUFFLE_SEED_VARIABLE, String(seed));
  announce(shuffleNotice(seed));
  return seed;
}

/** The flag that hands a seed to `deno test`. */
export function shuffleFlag(seed: number): string {
  return `--shuffle=${seed}`;
}

/** The line a runner prints so its order can be reproduced. */
export function shuffleNotice(seed: number): string {
  return `Test order shuffled with seed ${seed}. ` +
    `Set ${SHUFFLE_SEED_VARIABLE}=${seed} to run this order again.`;
}

/**
 * A generator over the 32-bit integers, seeded by one of them. Its
 * quality bounds nothing: what a shuffle needs of it is that the same
 * seed gives the same order on every machine that runs it.
 */
function generator(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** The items in the order the seed puts them in, leaving the input alone. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = generator(seed);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const pick = next() % (index + 1);
    [out[index], out[pick]] = [out[pick]!, out[index]!];
  }
  return out;
}

/**
 * Paths in the order the seed puts them in. They are sorted first, so
 * the order depends on the set of paths and the seed alone, and not on
 * the order a directory listing happened to return them in, which
 * differs from one filesystem to another.
 */
export function shuffledPaths(
  paths: readonly string[],
  seed: number,
): string[] {
  return shuffled([...paths].sort(utf8Compare), seed);
}
