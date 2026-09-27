import { isPlainObject } from "@commonfabric/utils/types";

import type {
  FabricArray,
  FabricPlainObject,
  FabricValue,
} from "@/interface.ts";
import { isFabricSpecialObject } from "@/types";
import { valueEqual } from "./valueEqual.ts";

/**
 * How many containers deep the walk goes before handing the operands to
 * `valueEqual()` whole. Two distinct cyclic graphs never bottom out, and this
 * is what stops the walk on them; it sits well under the call-stack depth an
 * engine allows. A value nested deeper than this is compared at what
 * `valueEqual()` costs, and no more.
 */
const MAX_WALK_DEPTH = 256;

/**
 * Like `valueEqual()`, except that two records or two arrays are decided by
 * walking them in step rather than by hashing each whole, and a pair of
 * subtrees that are one and the same object is decided by identity without
 * being read.
 *
 * That is what makes it the comparison for a value against a revision of
 * itself. A copy-on-write edit shares every subtree off the edited spine with
 * the value it was made from, so comparing the two costs the spine, where
 * `valueEqual()` hashes the whole of any operand whose hash it has not
 * cached. A walk also stops at the first difference it finds, which a hash
 * cannot.
 *
 * Every pair the walk does not decide itself goes to `valueEqual()` — a
 * special object on either side, a record against an array, and anything
 * that is not a `FabricValue` — and operands nested deeper than the walk
 * goes, two cyclic graphs sharing nothing among them, go to it whole. So the
 * two return the same result on every acyclic pair of `FabricValue`s. Where
 * they part is at a subtree the operands share, which the walk never visits.
 * A value `valueEqual()` would refuse to hash — a function, or a class whose
 * codec is a stub — does not throw from inside one. And a shared subtree that
 * leads back to a container the operands do not share is passed as equal,
 * where `valueEqual()`, which encodes a cycle relative to where its hash
 * began, can tell the two apart.
 *
 * A record or an array is decided without the hash cache, neither consulting
 * it nor filling it. So two large, distinct, equal, deep-frozen values that
 * were hashed once already cost this a full walk, where `valueEqual()`
 * compares two cached hashes.
 */
export function valueEqualByWalk(a: FabricValue, b: FabricValue): boolean {
  return walkEqual(a, b, 0) ?? valueEqual(a, b);
}

/**
 * Helper for {@link valueEqualByWalk}, which compares one pair of positions.
 * Returns `undefined` once the walk has gone too deep, which abandons the
 * whole walk rather than this pair: `valueEqual()` encodes a cycle relative to
 * where its hash began, so only the operands' own roots are a sound place to
 * hand it.
 */
function walkEqual(
  a: FabricValue,
  b: FabricValue,
  depth: number,
): boolean | undefined {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" || a === null || typeof b !== "object" ||
    b === null || isFabricSpecialObject(a) || isFabricSpecialObject(b)
  ) {
    return valueEqual(a, b);
  }
  if (depth >= MAX_WALK_DEPTH) return undefined;

  const aIsArray = Array.isArray(a);
  if (aIsArray && Array.isArray(b)) {
    return walkArrays(a as FabricArray, b as FabricArray, depth + 1);
  }
  if (!aIsArray && isPlainObject(a, false) && isPlainObject(b, false)) {
    return walkRecords(
      a as FabricPlainObject,
      b as FabricPlainObject,
      depth + 1,
    );
  }
  return valueEqual(a, b);
}

/**
 * Helper for {@link walkEqual}, which compares two arrays element by element.
 * A hole matches only a hole, as it does in a hash, where a hole and a stored
 * `undefined` are fed differently.
 */
function walkArrays(
  a: FabricArray,
  b: FabricArray,
  depth: number,
): boolean | undefined {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const aHas = index in a;
    if (aHas !== (index in b)) return false;
    if (!aHas) continue;
    const result = walkEqual(a[index], b[index], depth);
    if (result !== true) return result;
  }
  return true;
}

/**
 * Helper for {@link walkEqual}, which compares two records key by key. Key
 * order is not compared, since a hash feeds keys in sorted order; a key
 * holding `undefined` is compared as present, as a hash feeds it.
 */
function walkRecords(
  a: FabricPlainObject,
  b: FabricPlainObject,
  depth: number,
): boolean | undefined {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false;
    const result = walkEqual(a[key], b[key], depth);
    if (result !== true) return result;
  }
  return true;
}
