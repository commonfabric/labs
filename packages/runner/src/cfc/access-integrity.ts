/**
 * The integrity an access holds evidence for when an exchange rule is matched
 * against it (spec §5.3): the class-aware join (§3.1.6.2) of the integrity at
 * every confidential location the access consumed. A clause comes from one of
 * those locations, and a rule may release it only on evidence about the value
 * the access materializes (§8.10.1.1), which an atom one location carries and
 * another lacks is not.
 *
 * A hereditary atom survives when every location carries it. Any other atom
 * is a claim about one exact value, which a join of two values drops; it
 * survives only where one label stamp supplies it at every location, which
 * makes those locations parts of the one value that stamp labels. A location
 * names its stamps by keys its producer chooses, so two locations share a
 * stamp exactly when their producer says they do.
 *
 * Integrity at a location the access consumed with no confidentiality does
 * not enter the join: such a location holds no clause to release, and its
 * value is released whatever a rule decides.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { atomPropagationClass } from "./atom-classes.ts";
import type { CfcConfClause } from "./clause.ts";

/** One integrity atom at a location, with the label stamps supplying it there. */
export type LocatedIntegrityAtom = {
  readonly atom: CfcAtom;

  /**
   * Keys naming the label stamps that supply the atom at this location. Two
   * locations name one stamp by one key.
   */
  readonly stamps: readonly string[];
};

/** One location an access consumed, as the per-access join reads it. */
export type ConsumedLocation = {
  /** The clauses the access consumed here. */
  readonly confidentiality: readonly CfcConfClause[];

  /** The integrity that vouches for the value here. */
  readonly integrity: readonly LocatedIntegrityAtom[];
};

/**
 * The integrity an access consumed at `locations` holds evidence for: the
 * class-aware join over the ones carrying confidentiality, or nothing when
 * none does.
 */
export const accessIntegrity = (
  locations: readonly ConsumedLocation[],
): CfcAtom[] => {
  let joined: LocatedIntegrityAtom[] | undefined;
  for (const location of locations) {
    if (location.confidentiality.length === 0) continue;
    if (joined === undefined) {
      joined = [...location.integrity];
    } else {
      joined = meetLocated(joined, location.integrity);
    }
    // Nothing survives a join with a location carrying nothing in common.
    if (joined.length === 0) return [];
  }
  return (joined ?? []).map(({ atom }) => atom);
};

/**
 * The atoms of `left` that the join with `right` keeps: a hereditary atom
 * `right` also carries, and any other atom `right` carries from a stamp
 * supplying it in `left`, narrowed to the stamps the two share.
 */
const meetLocated = (
  left: readonly LocatedIntegrityAtom[],
  right: readonly LocatedIntegrityAtom[],
): LocatedIntegrityAtom[] => {
  const kept: LocatedIntegrityAtom[] = [];
  for (const entry of left) {
    const other = right.find(({ atom }) => deepEqual(atom, entry.atom));
    if (other === undefined) continue;
    if (atomPropagationClass(entry.atom) === "hereditary") {
      kept.push(entry);
      continue;
    }
    const stamps = entry.stamps.filter((stamp) => other.stamps.includes(stamp));
    if (stamps.length > 0) kept.push({ atom: entry.atom, stamps });
  }
  return kept;
};
