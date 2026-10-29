/**
 * The repository's structural equality, and the key that groups values for it.
 *
 * The two belong together because the key is only meaningful against the
 * comparison it is built for: values `deepEqual` calls equal share a
 * `deepEqualKey`, and a caller with a set of values to compare against uses
 * that to reach the few any candidate could equal. A change to either has to
 * hold that property, and holding it is what this file is for.
 */

import { isObjectOrArray } from "./types.ts";

/**
 * Comparator a caller supplies to {@link deepEqual} for the object pairs it
 * knows more about than a property walk can discover. It is consulted for every
 * pair of non-`null` objects the walk reaches, the arguments included, before
 * the walk reads either one's keys. Two references to one object are settled
 * ahead of it, so it never sees such a pair.
 *
 * A `boolean` result settles that pair, and the walk neither descends into it
 * nor compares its constructors. `undefined` declines the pair, leaving the
 * ordinary property comparison to decide it.
 */
export type ObjectEqual = (a: object, b: object) => boolean | undefined;

/**
 * Performs a deep equality comparison between two values.
 *
 * - Handles primitives, arrays, and plain objects
 * - Uses `Object.is()` for primitive comparison (handles NaN and -0 correctly)
 * - Does not handle circular references (will cause stack overflow)
 * - Does not compare symbol-keyed properties
 *
 * @param a - First value to compare
 * @param b - Second value to compare
 * @param objectEqual - Comparator consulted for each pair of objects reached,
 *   before their properties are read. Omitted, every pair is compared by its
 *   properties.
 * @returns True if the values are deeply equal
 *
 * **Not for `FabricValue`s on its own.** This function compares class instances
 * by enumerable own-props, so two same-class `FabricPrimitive` values (state in
 * private `#fields`, zero own-props) compare equal regardless of value, and
 * `FabricInstance` values compare by internal slots rather than logical
 * contents. `utils` sits below `data-model` and cannot reach the codecs that
 * decide fabric equality, so the knowledge arrives through `objectEqual`:
 * `data-model`'s `fabricAwareEqual()` is this walk carrying a comparator that
 * hands every fabric special object to `valueEqual()`. Use that, or
 * `valueEqual()` directly, for any comparison whose operands can hold a
 * `FabricValue`.
 */
export function deepEqual(a: any, b: any, objectEqual?: ObjectEqual): boolean {
  if (Object.is(a, b)) return true;

  if (!(isObjectOrArray(a) && isObjectOrArray(b))) {
    return false;
  }

  // At this point, we're looking at a pair of non-null records (e.g. plain
  // objects, arrays, or instances).

  if (objectEqual !== undefined) {
    const answer = objectEqual(a, b);
    if (answer !== undefined) return answer;
  }

  // Note: Even if they have the same `constructor`, it's technically possible
  // for `a` and `b` to have different prototypes, in which case it's possible
  // for this function to decide, ultimately, that they are "equal" in some
  // cases where, in some sort of plane of pure existence, we'd want to say they
  // aren't. However, practically speaking, all such cases are going to be from
  // some code intentionally doing something that's probably a bad idea for
  // other reasons, and we'll probably never actually encounter this in the real
  // world. And, very notably, in the case of stuff ending up here from
  // comparisons done regarding stored data, that's all normalized anyway, so
  // we'll only be getting plain objects, normal arrays, and trusted instances
  // made by the storage system.
  if (a.constructor !== b.constructor) return false;

  const keysA = Object.keys(a);
  const keysALength = keysA.length;
  const keysBLength = Object.keys(b).length;
  if (keysALength !== keysBLength) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (!(aIsArray || bIsArray)) {
    // General record (non-array object) comparison.
    return checkSpecificProps(a, b, keysA, objectEqual);
  }

  if (!(aIsArray && bIsArray)) {
    // One array and one non-array. Not equal!
    return false;
  }

  // Special-case handling for arrays, because the overwhelming majority of
  // cases is non-sparse arrays with no additional enumerable own properties.

  const lengthA = a.length;
  if (lengthA !== b.length) {
    return false;
  }

  let indexCount = 0; // Counts non-hole indexed properties.
  for (let i = 0; i < lengthA; i++) {
    const aValue = a[i];
    const bValue = b[i];

    indexCount++; // Assume non-hole to start. Might get reversed below.

    if (!deepEqual(aValue, bValue, objectEqual)) {
      return false;
    }

    if (aValue === undefined) {
      // Need to distinguish hole from a truly stored `undefined`.
      const aHasIt = Object.hasOwn(a, i);
      const bHasIt = Object.hasOwn(b, i);
      if ((aHasIt && !bHasIt) || (!aHasIt && bHasIt)) {
        return false;
      } else if (!aHasIt && !bHasIt) {
        // It's a hole.
        indexCount--;
      }
    }
  }

  if (indexCount === keysALength) {
    // All properties are accounted for as array indices. That is, there are
    // no named properties.
    return true;
  }

  // Ok, here's the "fun" part: We know how many indexed properties there are,
  // and ES (as of ES2015) guarantees that all the indexed properties are
  // listed first in the result from `Object.keys()`, so we slice those off
  // and just check the remainder.
  return checkSpecificProps(a, b, keysA.slice(indexCount), objectEqual);
}

/**
 * Helper for {@link deepEqual} that checks whether specific properties are
 * deeply equal between two records. Used for general object comparison and
 * for checking named (non-index) properties on arrays.
 *
 * @param a - First record (properties assumed to exist here)
 * @param b - Second record (properties checked via `hasOwn` before access)
 * @param keysToCheck - Property keys to compare
 * @param objectEqual - Comparator to carry into the recursion
 * @returns `true` if all specified properties exist on `b` and are deeply equal
 */
function checkSpecificProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keysToCheck: string[],
  objectEqual: ObjectEqual | undefined,
): boolean {
  for (const key of keysToCheck) {
    const aValue = a[key];
    const bValue = b[key];

    if (!deepEqual(aValue, bValue, objectEqual)) {
      return false;
    }

    if (aValue === undefined) {
      // Need to distinguish a missing property from a truly stored `undefined`.
      // Given how `keysToCheck` we know `a` definitely has the property, so we
      // just have to check `b`.
      if (!Object.hasOwn(b, key)) {
        // `a` has the property (because of how `keysToCheck` was constructed),
        // but `b` does not.
        return false;
      }
    }
  }

  return true;
}

/**
 * How many tokens one key carries at most. A key groups values so that a
 * comparison can settle them, so stopping the walk here costs a comparison and
 * nothing else, and it is what makes the function total. Three shapes need it:
 * a value that refers to itself, one that reaches a subtree along many paths,
 * and one carrying a great many properties. Each would otherwise build a key
 * out of all proportion to what a group needs — the first without end. Room
 * for a few hundred properties, which is past anything a key is asked for.
 */
const DEEP_EQUAL_KEY_TOKENS = 1024;

/**
 * Structural key for {@link deepEqual}, for grouping values before comparing
 * them. Values that compare equal share a key, so a group holds every value
 * that some given value could be equal to, and the comparison decides within
 * the group. That direction is the whole contract, and it is what lets a
 * caller compare a candidate against one group rather than against everything
 * it holds. The converse does not hold: values sharing a key may well differ,
 * so the comparison is still what settles it.
 *
 * The property holds over the values `deepEqual` is built for — plain objects,
 * ordinary arrays, and anything else keeping all of its data in own enumerable
 * properties. It can hold nowhere else, because `deepEqual` is not an
 * equivalence relation elsewhere: it counts properties with `Object.keys` and
 * reads them with `b[key]`, which resolves through the prototype chain, so an
 * object carrying `x` and one carrying `y` while inheriting `x` compare equal
 * to each other and to different third values. Grouping cannot reproduce a
 * comparison that is not transitive, and neither can deduplicating a list
 * under one.
 *
 * The key is built from what `deepEqual` looks at: `Object.is` on everything
 * that is not a non-`null` object, and own enumerable string-keyed properties
 * below that, with the property names sorted so that insertion order cannot
 * separate two values carrying the same properties. Four distinctions
 * `deepEqual` draws are left out, each of which merges values into one group
 * rather than splitting equal ones apart: the constructor, `0` against `-0`,
 * two symbols sharing a description, and one function against another.
 *
 * @param value - The value to key
 * @returns A key that values comparing equal share
 */
export function deepEqualKey(value: unknown): string {
  const parts: string[] = [];
  appendDeepEqualKey(value, parts);
  return parts.join(" ");
}

/**
 * Helper for {@link deepEqualKey} that appends the tokens for one value.
 *
 * @param value - The value to key
 * @param parts - Tokens accumulated so far
 */
function appendDeepEqualKey(value: unknown, parts: string[]): void {
  if (parts.length >= DEEP_EQUAL_KEY_TOKENS) {
    return;
  }
  if (!isObjectOrArray(value)) {
    const type = typeof value;
    parts.push(type === "function" ? "fn" : `${type}:${String(value)}`);
    return;
  }
  // Values that compare equal carry the same own enumerable keys, and the
  // order those come back in is insertion order for a record and numeric order
  // for an array's elements. Sorting settles both at once.
  const keys = Object.keys(value).sort();
  parts.push(Array.isArray(value) ? `[${value.length}` : "{");
  for (const key of keys) {
    if (parts.length >= DEEP_EQUAL_KEY_TOKENS) {
      return;
    }
    parts.push(`.${key}`);
    appendDeepEqualKey(value[key], parts);
  }
  parts.push("}");
}
