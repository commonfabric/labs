/**
 * What a release gate evaluates exchange rules over (spec §5.3): the label an
 * access consumed, taken one observation at a time. §4.6.3 has no primitive
 * read of a whole structured value — "Structured materialization is a
 * derived traversal over primitive observations, and the resulting label is
 * the join of the observations actually consumed" — and §5.3 applies a
 * value-intrinsic rule "at observation", on the evidence bound to the value
 * observed there, because "the class-aware meet drops it at the next
 * transformation". So a gate runs the value-intrinsic rules at each location
 * an access consumed, on that location's own label, joins what they leave,
 * and runs every rule over the join (§8.10.1.1).
 *
 * The join's integrity is §3.1.6.2's class-aware join of every location's
 * integrity: a hereditary atom survives where every location carries it, and
 * any other atom only where the access observed one location.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { atomPropagationClass } from "./atom-classes.ts";
import type { CfcConfClause } from "./clause.ts";

/** One location an access consumed, as a release gate reads it. */
export type ConsumedLocation = {
  /**
   * Names the value observed: the document and the path within it. Two
   * observations of one location observe one value.
   */
  readonly key: string;

  /** The clauses the access consumed here. */
  readonly confidentiality: readonly CfcConfClause[];

  /** The integrity the access consumed here, which the join is taken over. */
  readonly integrity: readonly CfcAtom[];

  /**
   * The integrity here that is evidence about the value currently at this
   * location, which the value-intrinsic rules are matched against.
   */
  readonly evidence: readonly CfcAtom[];
};

/**
 * §3.1.6.2's class-aware join of the integrity at `locations`, with two
 * observations of one location counted once: nothing when there are no
 * locations, a location's own integrity when there is one, and otherwise the
 * hereditary atoms every location carries.
 */
export const joinLocationIntegrity = (
  locations: readonly ConsumedLocation[],
): CfcAtom[] => {
  const distinct = new Map<string, ConsumedLocation>();
  for (const location of locations) {
    if (!distinct.has(location.key)) distinct.set(location.key, location);
  }
  const [first, ...rest] = distinct.values();
  if (first === undefined) return [];
  if (rest.length === 0) return [...first.integrity];
  return first.integrity.filter((atom) =>
    atomPropagationClass(atom) === "hereditary" &&
    rest.every((location) =>
      location.integrity.some((other) => deepEqual(other, atom))
    )
  );
};
