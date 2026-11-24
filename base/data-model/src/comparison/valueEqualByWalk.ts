import type {
  FabricArray,
  FabricPlainObject,
  FabricValue,
} from "@/interface.ts";
import { isFabricPlainContainer } from "@/types";
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
 * Like `valueEqual()`, except that two plain records or two arrays are
 * compared by walking them in step rather than by hashing each whole, and a
 * subtree both operands share is settled by identity without being read. So
 * comparing a value with a copy-on-write revision of itself costs the edited
 * spine, and a walk stops at the first difference it finds.
 *
 * Any other pair goes to `valueEqual()`, and so do operands nested deeper than
 * the walk goes, which includes two cyclic graphs sharing nothing. The two
 * therefore return the same result on every acyclic pair of `FabricValue`s.
 * They part only at a shared subtree, which is never read: a value
 * `valueEqual()` would refuse to hash does not throw from inside one, and one
 * that closes a cycle through a container the operands do not share is taken
 * as equal. The hash cache is neither consulted nor filled for a record or an
 * array, so two distinct equal values hashed once already cost a full walk.
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
  if (!isFabricPlainContainer(a) || !isFabricPlainContainer(b)) {
    return valueEqual(a, b);
  }
  if (depth >= MAX_WALK_DEPTH) return undefined;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  return aIsArray
    ? walkArrays(a as FabricArray, b as FabricArray, depth + 1)
    : walkRecords(a as FabricPlainObject, b as FabricPlainObject, depth + 1);
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
