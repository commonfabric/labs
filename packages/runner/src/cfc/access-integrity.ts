/**
 * What a release gate evaluates exchange rules over (spec §5.3): the label an
 * access consumed, taken one observation at a time. §4.6.3 has no primitive
 * read of a whole structured value: reading one is a traversal over primitive
 * observations, labeled by the join of the observations it consumed. §5.3
 * applies a value-intrinsic rule at observation, on the evidence bound to the
 * value observed there, because the class-aware join drops that evidence at
 * the next transformation. So a gate runs the value-intrinsic rules at each
 * location an access consumed, on the evidence there about the value
 * currently at it, joins what they leave (§8.10.1.1), and runs the other
 * rules over the join.
 *
 * The join's integrity is §3.1.6.2's class-aware join of every location's
 * integrity: a hereditary atom survives where every location carries it, and
 * any other atom only where the access observed one location.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { atomPropagationClass } from "./atom-classes.ts";
import { uniqueCfcAtoms } from "./atoms.ts";
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
 * `locations` with two observations of one location counted once. An
 * observation under a key already kept is dropped when it consumed the same
 * integrity, and kept beside the first when it did not, since the two then did
 * not observe one value.
 */
const distinctLocations = (
  locations: readonly ConsumedLocation[],
): ConsumedLocation[] => {
  const distinct: ConsumedLocation[] = [];
  const byKey = new Map<string, ConsumedLocation[]>();
  for (const location of locations) {
    const kept = byKey.get(location.key);
    if (kept === undefined) {
      byKey.set(location.key, [location]);
    } else if (
      kept.some((other) => deepEqual(other.integrity, location.integrity))
    ) {
      continue;
    } else {
      kept.push(location);
    }
    distinct.push(location);
  }
  return distinct;
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
  const [first, ...rest] = distinctLocations(locations);
  if (first === undefined) return [];
  if (rest.length === 0) return [...first.integrity];
  return first.integrity.filter((atom) =>
    atomPropagationClass(atom) === "hereditary" &&
    rest.every((location) =>
      location.integrity.some((other) => deepEqual(other, atom))
    )
  );
};

/**
 * The label one access consumed, exchanged one observation at a time. At each
 * of `locations`, `exchangeAt` rewrites the clauses of `confidentiality` that
 * location consumed, matched against its evidence; a location with no
 * evidence keeps them as read, since a value-intrinsic rule guards on some
 * integrity. The result's confidentiality is what the locations left, with
 * any clause of `confidentiality` no location consumed kept as read, and its
 * integrity is `joinLocationIntegrity()`'s.
 */
export const exchangeEachObservation = (
  confidentiality: readonly CfcConfClause[],
  locations: readonly ConsumedLocation[],
  exchangeAt: (
    clauses: readonly CfcConfClause[],
    evidence: readonly CfcAtom[],
  ) => readonly CfcConfClause[],
): { confidentiality: CfcConfClause[]; integrity: CfcAtom[] } => {
  const distinct = distinctLocations(locations);
  const exchanged: CfcConfClause[] = [];
  const consumed: CfcConfClause[] = [];
  for (const location of distinct) {
    const clauses = location.confidentiality.filter((clause) =>
      confidentiality.some((read) => deepEqual(read, clause))
    );
    if (clauses.length === 0) continue;
    for (const clause of clauses) consumed.push(clause);
    const left = location.evidence.length === 0
      ? clauses
      : exchangeAt(clauses, location.evidence);
    for (const clause of left) exchanged.push(clause);
  }
  for (const clause of confidentiality) {
    if (!consumed.some((other) => deepEqual(other, clause))) {
      exchanged.push(clause);
    }
  }
  return {
    confidentiality: uniqueCfcAtoms(exchanged) as CfcConfClause[],
    integrity: joinLocationIntegrity(distinct),
  };
};
