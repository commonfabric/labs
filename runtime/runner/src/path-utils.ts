import {
  isKeyableObjectOrArray,
  isWalkableObjectOrArray,
  valueEqual,
} from "@commonfabric/data-model";

/**
 * Read one path segment out of a data container WITHOUT falling through to the
 * container's prototype.
 *
 * A path segment names data. Plain indexing returns `Object.prototype`'s
 * member when the segment is absent and happens to be named after one —
 * `toString`, `valueOf`, `hasOwnProperty` and the rest are ordinary, legal
 * keys. That turned "absent" into a function: `getValueAtPath({}, ["toString"])`
 * handed back `Object.prototype.toString`, and `setValueAtPath({}, ["toString"],
 * v)` compared against it and threw "Cannot compare a function value".
 *
 * Arrays need no special case: an index or `length` is an own property, and a
 * hole is correctly absent — the same distinction the storage-v2 path helper
 * draws between record presence and sparse slots.
 *
 * Primitives need none either, and must not be excluded. `Object.hasOwn()`
 * coerces with `ToObject`, so it returns `true` for a string's `length` and its
 * indices — genuinely own — and `false` for `toUpperCase`/`toString`, which
 * live on `String.prototype`. Bailing out on everything non-`isObjectOrArray` would
 * lose `getValueAtPath("abc", ["length"])`, which callers rely on to
 * reconstruct write details over primitive subtrees; indexing unconditionally,
 * as this did before, would hand back the prototype methods. `Object.hasOwn`
 * is the line both want.
 */
// deno-lint-ignore no-explicit-any
function ownSegment(container: unknown, key: PropertyKey): any {
  // `Object.hasOwn` throws on these two and only these two.
  if (container === null || container === undefined) return undefined;
  return Object.hasOwn(container as object, key as string)
    ? (container as Record<PropertyKey, any>)[key]
    : undefined;
}

export function setValueAtPath(
  obj: any,
  path: PropertyKey[],
  value: any,
): boolean {
  let parent = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    // `ownSegment`, not `parent[key]`: an absent segment named after a
    // prototype member would otherwise look like an existing non-object and
    // get descended into rather than created.
    //
    // A special object at a spine slot is replaced rather than descended, the
    // same as a scalar: it holds no slot for the next segment, so writing
    // through it would raise a `TypeError` on a frozen value or graft a
    // property its codec never reads onto an unfrozen one. `null` is replaced
    // for the same reason, its `typeof` being `"object"` as well.
    if (!isWalkableObjectOrArray(ownSegment(parent, key))) {
      parent[key] = typeof path[i + 1] === "number" ? [] : {};
    }
    parent = parent[key];
  }

  // Note: `valueEqual()` throws on a function or a non-`Fabric` class
  // instance; both operands here are `FabricValue`s by contract — which is
  // only true of the current value if it is read own-only. Reading through the
  // prototype hands `valueEqual` an inherited method and it throws.
  const leafKey = path[path.length - 1];
  if (valueEqual(ownSegment(parent, leafKey), value)) return false;

  // We just set the values here. If you need to delete elements from an
  // array or object, set it to another array or object without those elements.
  // We can set value to undefined here without issue
  parent[leafKey] = value;

  return true;
}

export function getValueAtPath(obj: any, path: readonly PropertyKey[]): any {
  let current = obj;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = ownSegment(current, key);
  }
  return current;
}

export function hasValueAtPath(obj: any, path: PropertyKey[]): boolean {
  let current = obj;
  for (const key of path) {
    // A path continuing below a `FabricInstance` reports absent rather than
    // refusing, as the stored path reads in `storage/v2-path.ts` do: this
    // reports what a path finds and rebuilds nothing.
    //
    // TODO(danfuzz): "absent" is an incomplete answer for an instance, whose
    // codec contents are real and not addressable by a path segment yet.
    if (
      !isKeyableObjectOrArray(current) ||
      !Object.hasOwn(current, key as string)
    ) {
      return false;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return true;
}

export function arrayEqual(
  a?: readonly PropertyKey[],
  b?: readonly PropertyKey[],
): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
