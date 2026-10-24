/**
 * How much a run's caller wants it to do: answer `quick`ly, work at the
 * `standard` depth, the default, or go `deep`.
 * The caller decides it, before the run starts; the run's task classification
 * says what kind of work it is, and the depth how far to take it. It selects
 * prompt sections and the opening research pass, and grants no authority.
 *
 * `quick` and `deep` each add strategy sections (`strategy.ts`) that a
 * `standard` run does not get: a quick run takes the shortest path to what was
 * asked, and a deep run searches exhaustively where its domains are, then reads
 * its result back. `deep` also gives a classified task in the `fabric` domain
 * the opening research pass, which an `author` task gets at any depth and a
 * run that was never classified already gets.
 */
export const HARNESS_RUN_DEPTHS = ["quick", "standard", "deep"] as const;

export type HarnessRunDepth = typeof HARNESS_RUN_DEPTHS[number];

/** The depth of a run whose caller named none. */
export const DEFAULT_HARNESS_RUN_DEPTH: HarnessRunDepth = "standard";

/** `value` as a run depth, or undefined when it names none. */
export const parseHarnessRunDepth = (
  value: unknown,
): HarnessRunDepth | undefined =>
  HARNESS_RUN_DEPTHS.find((depth) => depth === value);
