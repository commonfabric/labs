import { isObjectOrArray, isPlainObject } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

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
 * Primitive arguments use `Object.is()`. Containers preserve canonical hash
 * semantics, including UTF-8 replacement of lone surrogates in nested strings,
 * symbol registry keys, and property names. Primitive special values use
 * canonical hashes; instances expose their contents through their codecs.
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
      // Container hashes encode strings as UTF-8, replacing lone surrogates.
      // Preserve that equivalence for nested strings and symbol registry keys.
      if (
        typeof left === "string" && typeof right === "string" &&
        left.toWellFormed() === right.toWellFormed()
      ) continue;
      if (typeof left === "symbol" && typeof right === "symbol") {
        const leftKey = Symbol.keyFor(left);
        const rightKey = Symbol.keyFor(right);
        if (
          leftKey !== undefined && rightKey !== undefined &&
          leftKey.toWellFormed() === rightKey.toWellFormed()
        ) continue;
      }
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
        if (
          keys.every((key) =>
            Object.prototype.propertyIsEnumerable.call(rightObject, key)
          )
        ) {
          for (const key of keys) {
            const leftItem = leftObject[key];
            const rightItem = rightObject[key];
            if (!Object.is(leftItem, rightItem)) {
              pending.push([leftItem, rightItem]);
            }
          }
        } else {
          // Different JS keys can encode to the same UTF-8 bytes. Match their
          // positions in the canonical hash stream, including repeated names
          // after replacement; sorting normalized keys changes that stream.
          const leftKeys = utf8SortedKeysOf(leftObject);
          const rightKeys = utf8SortedKeysOf(rightObject);
          for (let index = 0; index < leftKeys.length; index++) {
            const leftKey = leftKeys[index]!;
            const rightKey = rightKeys[index]!;
            if (leftKey.toWellFormed() !== rightKey.toWellFormed()) {
              return false;
            }
            const leftItem = leftObject[leftKey];
            const rightItem = rightObject[rightKey];
            if (!Object.is(leftItem, rightItem)) {
              pending.push([leftItem, rightItem]);
            }
          }
        }
        break;
      }
      case "special": {
        if (left instanceof FabricInstance && right instanceof FabricInstance) {
          const leftCodec = codecOf(left);
          const rightCodec = codecOf(right);
          if (
            leftCodec.tagForValue(left).toWellFormed() !==
              rightCodec.tagForValue(right).toWellFormed()
          ) {
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
