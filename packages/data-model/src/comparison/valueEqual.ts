import { isObjectOrArray, isPlainObject } from "@commonfabric/utils/types";

import { codecOf } from "@/codec-common";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import {
  type FabricArray,
  FabricInstance,
  type FabricPlainObject,
  type FabricSpecialObject,
  type FabricValue,
} from "@/interface.ts";
import { isFabricSpecialObject } from "@/types";
import { debugStr } from "@/value-debug";
import { cachedHashStringOf, hashStringOf } from "@/value-hash.ts";

/**
 * Compares `FabricValue`s by logical content, preserving signed zero, sparse
 * holes, explicit `undefined`, and the codec-defined state of special values.
 *
 * Identical descendants and available immutable hashes need no traversal.
 * Other containers are compared once per object pair with an explicit work
 * stack, so shared references and cycles do not expand into repeated trees.
 * Sharing itself is not content: a repeated object may equal separate copies,
 * and cycles compare by the contents reached through their corresponding
 * edges. A mismatch reachable after a back edge still makes the values unequal.
 *
 * Primitives compare with `Object.is()`, at the top level and nested alike,
 * which draws the same distinctions content hashing does: `-0` and `0` differ,
 * `NaN` equals itself, and strings (property names and symbol registry keys
 * included) are equal only when they have the same UTF-16 code units,
 * including any lone surrogates. Primitive special values use canonical
 * hashes; instances expose their contents through their codecs.
 * Non-Fabric classes are unsupported, and non-index properties on arrays are
 * ignored, as they are by content hashing.
 */
export function valueEqual(a: FabricValue, b: FabricValue): boolean {
  if (Object.is(a, b)) return true;
  if (!isObjectOrArray(a) || !isObjectOrArray(b)) {
    if (typeof a === "function" || typeof b === "function") {
      throw new Error("Cannot compare a function value.");
    }
    return false;
  }
  const pending: [FabricValue, FabricValue][] = [[a, b]];
  const compared = new WeakMap<object, WeakSet<object>>();

  while (pending.length > 0) {
    const [left, right] = pending.pop()!;
    if (Object.is(left, right)) continue;
    if (typeof left === "function" || typeof right === "function") {
      throw new Error("Cannot compare a function value.");
    }
    if (
      left === null || right === null ||
      typeof left !== "object" || typeof right !== "object"
    ) {
      return false;
    }

    const leftHash = cachedHashStringOf(left);
    const rightHash = cachedHashStringOf(right);
    if (leftHash !== undefined && rightHash !== undefined) {
      if (leftHash !== rightHash) return false;
      continue;
    }

    let counterparts = compared.get(left);
    if (counterparts?.has(right)) continue;
    if (counterparts === undefined) {
      counterparts = new WeakSet();
      compared.set(left, counterparts);
    }
    counterparts.add(right);

    const subtype = objectSubtypeOf(left);
    if (subtype !== objectSubtypeOf(right)) return false;
    switch (subtype) {
      case "array": {
        const leftArray = left as FabricArray;
        const rightArray = right as FabricArray;
        if (leftArray.length !== rightArray.length) return false;
        for (let index = 0; index < leftArray.length; index++) {
          const present = index in leftArray;
          if (present !== (index in rightArray)) return false;
          if (present) {
            const leftItem = leftArray[index];
            const rightItem = rightArray[index];
            if (!Object.is(leftItem, rightItem)) {
              pending.push([leftItem, rightItem]);
            }
          }
        }
        break;
      }
      case "plain": {
        const leftObject = left as FabricPlainObject;
        const rightObject = right as FabricPlainObject;
        const keys = Object.keys(leftObject);
        if (keys.length !== Object.keys(rightObject).length) return false;
        for (const key of keys) {
          if (!Object.prototype.propertyIsEnumerable.call(rightObject, key)) {
            return false;
          }
          const leftItem = leftObject[key];
          const rightItem = rightObject[key];
          if (!Object.is(leftItem, rightItem)) {
            pending.push([leftItem, rightItem]);
          }
        }
        break;
      }
      case "special": {
        if (left instanceof FabricInstance && right instanceof FabricInstance) {
          const leftCodec = codecOf(left);
          const rightCodec = codecOf(right);
          if (leftCodec.tagForValue(left) !== rightCodec.tagForValue(right)) {
            return false;
          }
          pending.push([
            leftCodec.encode(left, NULL_LIVE_ENVIRONMENT),
            rightCodec.encode(right, NULL_LIVE_ENVIRONMENT),
          ]);
        } else if (
          left.constructor !== right.constructor ||
          hashStringOf(left) !== hashStringOf(right)
        ) {
          return false;
        }
        break;
      }
    }
  }
  return true;
}

/**
 * Helper for {@link valueEqual}, which classifies supported object subtypes.
 * Throws for classes whose contents are not represented by Fabric codecs.
 */
function objectSubtypeOf(
  value: FabricPlainObject | FabricArray | FabricSpecialObject,
): "array" | "plain" | "special" {
  if (isFabricSpecialObject(value)) {
    return "special";
  } else if (Array.isArray(value)) {
    return "array";
  } else if (isPlainObject(value)) {
    return "plain";
  } else {
    throw new Error(
      debugStr`Cannot compare value $quote${value}`,
    );
  }
}
