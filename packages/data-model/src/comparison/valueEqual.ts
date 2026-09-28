import { isPlainObject } from "@commonfabric/utils/types";

import { codecOf } from "@/codec-common";
import { isDeepFrozen } from "@/deep-freeze.ts";
import {
  type FabricArray,
  FabricInstance,
  type FabricPlainObject,
  type FabricSpecialObject,
  type FabricValue,
} from "@/interface.ts";
import { isFabricSpecialObject } from "@/types";
import { debugStr } from "@/value-debug";
import { hashStringOf } from "@/value-hash";

/**
 * Compares two `FabricValue`s for logical (content) equality.
 *
 * This is the `data-model`-aware equality the storage layer's no-op /
 * change-detection gates need, and the fix for what `deepEqual()` gets wrong:
 * any `FabricSpecialObject` (`FabricPrimitive` leaves like `FabricBytes` /
 * `FabricRegExp` / `FabricEpoch*` / `FabricHash`, and `FabricInstance`
 * wrappers) keeps its state in private `#fields` with zero enumerable
 * own-properties, so `deepEqual()` conflates every distinct same-class instance
 * as equal (the CT-1770 bug). Here object equality is decided by canonical
 * content hash (`hashStringOf()`), which feeds special objects, plain objects,
 * and arrays alike — including the distinctions a naive walk misses (sparse
 * array holes vs a stored `undefined`, a present `undefined` vs an absent key)
 * — so a special object nested arbitrarily deep is still compared by content.
 *
 * (Unlike `deepEqual()` it does not handle non-`Fabric` class instances or
 * non-index properties on arrays: those are not representable as
 * `FabricValue`s.)
 */
export function valueEqual(a: FabricValue, b: FabricValue): boolean {
  if (Object.is(a, b)) return true;

  switch (typeof a) {
    case "object": {
      // `null` is the one `object`-typed value that isn't a container; with
      // `Object.is()` already ruled out, `a === null` can't equal `b`.
      if (a === null) return false;
      break;
    }

    case "function": {
      // Not a `FabricValue`; reachable only via an unsound cast.
      throw new Error("Cannot compare a function value.");
    }

    default: {
      // Any other type is a primitive that `Object.is()` already settled as
      // unequal above.
      return false;
    }
  }

  // `a` is a non-`null` object. Classify `b` the same way, so invalid input
  // fails identically regardless of argument order: only another non-`null`
  // object can be equal to `a`.
  switch (typeof b) {
    case "object": {
      // A non-`null` object can't equal `null`; otherwise compare below.
      if (b === null) return false;
      break;
    }

    case "function": {
      // Not a `FabricValue`; reachable only via an unsound cast.
      throw new Error("Cannot compare a function value.");
    }

    default: {
      // `b` is a primitive, which can't equal the object `a`.
      return false;
    }
  }

  // The canonical content hash is the general object comparator, but it's worth
  // a few cheap checks first.

  if (isDeepFrozen(a) && isDeepFrozen(b)) {
    // Both sides are deep-frozen, the hash is cacheable (frozen ~==
    // non-ephemeral), so hashing can be reasonably assumed to pay for itself.
    return hashStringOf(a) === hashStringOf(b);
  }

  // Otherwise, short-circuit the mismatched subtypes that can never be equal,
  // without paying for a hash.

  const subtype = objectSubtypeOf(a);
  const bSubtype = objectSubtypeOf(b);

  if (subtype !== bSubtype) {
    // Different subtypes can't possibly be equal.
    return false;
  }

  switch (subtype) {
    case "array": {
      // Alas, casts are required because TS doesn't know the correspondence
      // between subtype names and type restrictions.
      const aArray = a as FabricArray;
      const bArray = b as FabricArray;
      if (aArray.length !== bArray.length) {
        // Arrays can't possibly be equal if lengths are different.
        return false;
      }
      break;
    }

    case "plain": {
      // Alas, casts are required because TS doesn't know the correspondence
      // between subtype names and type restrictions.
      const aObject = a as FabricPlainObject;
      const bObject = b as FabricPlainObject;
      if (Object.keys(aObject).length !== Object.keys(bObject).length) {
        // Plain objects can't possibly be equal if they have different numbers
        // of properties.
        return false;
      }
      break;
    }

    case "special": {
      if (a instanceof FabricInstance && b instanceof FabricInstance) {
        // A `FabricInstance` is hashed by its codec's tag and state, so two of
        // different concrete classes can be equal (e.g. an `UnknownValue`
        // preserving another instance's tag and state). Different tags,
        // though, can't possibly be equal.
        if (codecOf(a).tagForValue(a) !== codecOf(b).tagForValue(b)) {
          return false;
        }
      } else if (a.constructor !== b.constructor) {
        // Any other `FabricSpecialObject`s can't possibly be equal if they are
        // of different concrete classes.
        return false;
      }
      break;
    }
  }

  // No quick check managed to disqualify full-scale comparison. So it goes.
  return hashStringOf(a) === hashStringOf(b);
}

/**
 * Helper for {@link #valueEqual}, which classifies object subtypes. This
 * `throw`s given an object that shouldn't have been passed as a `FabricValue`.
 */
function objectSubtypeOf(
  value: FabricPlainObject | FabricArray | FabricSpecialObject,
): "array" | "plain" | "special" {
  if (isFabricSpecialObject(value)) {
    return "special";
  } else if (Array.isArray(value)) {
    return "array";
  } else if (isPlainObject(value, false)) {
    return "plain";
  } else {
    throw new Error(
      debugStr`Cannot compare value $quote${value}`,
    );
  }
}
