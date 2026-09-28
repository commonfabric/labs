/**
 * Atom-list primitives every CFC module shares: structural deduplication and
 * a canonical order. They depend on nothing else in `cfc/`, so the clause,
 * observation, and input-witness modules can all import them without a cycle.
 */
import type { JSONValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { deepEqual, deepEqualKey } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

// How many kept atoms a candidate is compared against before the kept set is
// grouped instead. Keying an atom walks the whole of it, while a comparison
// against a different atom stops at the first property where they differ, so
// which of the two is cheaper depends on the atoms as well as on how many
// there are, and no single value is right everywhere. Measured over lists of
// distinct atoms at sizes from 9 to 128, in the two shapes that bound the
// ratio — atoms agreeing until their last property, and atoms differing at
// their first — a limit of 16 leaves a band just above itself where grouping
// costs at most about twice the scan, and is within a fifth of the best
// available cost by 128 atoms. A lower limit deepens that band; a higher one
// gives up the win where the growth is steepest.
const ATOM_SCAN_LIMIT = 16;

const atomGroupFor = (
  groups: Map<string, CfcAtom[]>,
  key: string,
): CfcAtom[] => {
  const group = groups.get(key);
  if (group !== undefined) {
    return group;
  }
  const created: CfcAtom[] = [];
  groups.set(key, created);
  return created;
};

const groupAtomsByKey = (
  atoms: readonly CfcAtom[],
): Map<string, CfcAtom[]> => {
  const groups = new Map<string, CfcAtom[]>();
  for (const atom of atoms) {
    atomGroupFor(groups, deepEqualKey(atom)).push(atom);
  }
  return groups;
};

/**
 * Orders atoms by their canonical value hash: a total order that depends only
 * on what each atom says, so a sort by it does not depend on the order the
 * atoms arrived in.
 */
export const compareByCanonicalHash = (
  left: CfcAtom,
  right: CfcAtom,
): number => {
  const leftHash = hashStringOf(left);
  const rightHash = hashStringOf(right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
};

// Structural deduplication, keeping the first spelling of each atom. The
// identity is `deepEqual` rather than reference equality, because a fabric
// conversion clones an atom rather than sharing it, so two atoms saying the
// same thing routinely have different references.
//
// Past `ATOM_SCAN_LIMIT` kept atoms, the kept set is grouped by `deepEqualKey`
// and a candidate is compared against its own group. Atoms that differ can
// share a key, so `deepEqual` still decides within a group. The grouping is
// built when a candidate arrives that would use it, so a list that ends at the
// limit pays for none of it.
export const uniqueCfcAtoms = (
  atoms: Iterable<unknown>,
): CfcAtom[] => {
  const unique: CfcAtom[] = [];
  const references = new Set<object>();
  let groups: Map<string, CfcAtom[]> | undefined;
  for (const atom of atoms) {
    if (isObjectOrArray(atom)) {
      if (references.has(atom)) continue;
    }
    if (groups === undefined && unique.length > ATOM_SCAN_LIMIT) {
      groups = groupAtomsByKey(unique);
    }
    if (groups === undefined) {
      if (!unique.some((kept) => deepEqual(kept, atom))) {
        unique.push(atom as JSONValue);
        if (isObjectOrArray(atom)) references.add(atom);
      }
      continue;
    }
    const group = atomGroupFor(groups, deepEqualKey(atom));
    if (group.some((kept) => deepEqual(kept, atom))) {
      continue;
    }
    group.push(atom as JSONValue);
    unique.push(atom as JSONValue);
    if (isObjectOrArray(atom)) references.add(atom);
  }
  return unique;
};
