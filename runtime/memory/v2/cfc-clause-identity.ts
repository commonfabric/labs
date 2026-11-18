/**
 * The identity of CFC atoms and clauses: structural deduplication of atoms, a
 * canonical order over them, the canonical form of a clause, and the
 * canonical clause digest that names a stored clause across evaluations
 * (§8.12.7 identifies a released or widened clause by it). It lives here,
 * below the runner, so that the store judges a release by intent
 * (`cfc-owner-release-by-intent.ts`) by the same digest the runtime records;
 * the runner imports each name from here.
 */

import type { JSONValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { deepEqual, deepEqualKey } from "@commonfabric/js-values/deep-equal";
import { isObjectOrArray } from "@commonfabric/js-values/types";

import { type CfcConfClause, isOrClause } from "./cfc-release-authority.ts";

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

/**
 * Canonical form of a clause:
 * - a non-clause value (bare atom) is returned unchanged (identity — flat
 *   labels are byte-identical through canonicalization);
 * - an OR-clause gets its alternatives structurally deduped and sorted by
 *   canonical value hash, so two clauses that differ only in alternative
 *   insertion order canonicalize (and hash) identically;
 * - a singleton `{anyOf: [a]}` unwraps to the bare atom `a` (semantically
 *   identical, so the two spellings must not hash differently) — UNLESS `a`
 *   is itself clause-shaped: `{anyOf: [{anyOf: […]}]}` is malformed (the
 *   reserved key must not appear in atom position), and its sole alternative
 *   is an opaque, unsatisfiable atom. Unwrapping would PROMOTE that inner
 *   value into an active OR-clause, loosening what the raw label admits —
 *   the wrong direction. Malformed nesting stays wrapped and opaque;
 * - an empty `{anyOf: []}` is kept as-is: it is an unsatisfiable clause
 *   (see `clauseSubsumes` for how both positions treat it fail-closed).
 *
 * Canonicalization never merges clauses, never unions alternative sets
 * across clauses, and never dedups an atom across a singleton clause and an
 * OR-clause containing it — `[A]` and `[A ∨ B]` are different constraints
 * (spec §3.1.8 normalization prohibitions).
 */
export const normalizeClause = (clause: CfcConfClause): CfcConfClause => {
  if (!isOrClause(clause)) return clause;
  const unique = uniqueCfcAtoms(clause.anyOf);
  if (unique.length === 1 && !isOrClause(unique[0])) return unique[0];
  return { anyOf: unique.sort(compareByCanonicalHash) };
};

/**
 * Canonical clause digest: the identity of a stored clause for a route-2b
 * exemption, an owner release's receipt, and a release by intent's request
 * and record. Clause indices are evaluation-ephemeral; the digest of the
 * canonicalized clause (alternatives deduped and hash-sorted, singleton
 * unwrapped) is not.
 */
export const cfcCanonicalClauseDigest = (clause: CfcConfClause): string =>
  hashStringOf(normalizeClause(clause));
