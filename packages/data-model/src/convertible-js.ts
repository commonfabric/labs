/**
 * The boundary between convertible JS values and `FabricValue`s, in both
 * directions, along with the predicate saying in advance whether a value can
 * cross it.
 *
 * The inbound work splits along one question -- does conversion produce a new
 * value? Minting a JS object's fabric form is one function, and vetting a value
 * that needs no minting is the other, in `types/validation.ts`. The shallow
 * conversion is those two asked in that order, plus a frozenness adjustment, so
 * that a caller can ask either without having to work the answer back out of
 * what it was handed.
 *
 * Inbound, anything not representable is refused rather than approximated: a
 * `Map`, a class instance, an unrecognized type all throw, on the principle
 * that a wrong value is worse than none. A value that is already a deep-frozen
 * `FabricValue` crosses by identity instead of being rebuilt, and a cycle is
 * detected rather than followed.
 *
 * Outbound, a wrapper is unwrapped to the JS type it stands for, while a
 * `FabricInstance` with no JS counterpart passes through untouched. Both
 * directions take the result's freeze state as an argument; on the way out, a
 * class defined to be always frozen comes back frozen regardless of what was
 * asked for.
 */

import {
  isInstance,
  isObjectOrArray,
  isUnsafeObjectKey,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";
import { isInertPlainObject } from "@commonfabric/utils/objects";
import {
  isArrayIndexPropertyName,
  isInertArray,
} from "@commonfabric/utils/arrays";

import {
  type FabricConvertibleJsValue,
  type FabricValue,
  type FabricValueLayer,
} from "./interface.ts";
import {
  assertValidFabricValueLayer,
  isFabricSpecialObject,
  isValidFabricConvertibleJsObject,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@/types";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@/fabric-primitives";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricNativeWrapper } from "@/fabric-instances/FabricNativeWrapper.ts";
import { cloneHelper } from "./value-clone.ts";
import { isValidDeepFrozenFabricValue } from "./deep-freeze.ts";

/**
 * Helper for `shallowFabricFromConvertibleJsObjectElseUndefined()`, which
 * rejects JS objects with extra enumerable properties.
 */
function rejectExtraProperties(value: object, typeName: string): void {
  if (Object.keys(value).length > 0) {
    throw new Error(
      `Not representable as a \`FabricValue\`: \`${typeName}\` with extra ` +
        "enumerable properties",
    );
  }
}

/**
 * Returns a shallow clone of the given array carrying nothing but its
 * enumerable index properties and `length`, that is, one which satisfies
 * `isInertArray()` -- a direct `Array` instance, whatever the given array's
 * prototype. Holes are preserved as holes, and elements are copied by reference
 * without themselves being converted or validated, this being a shallow
 * operation.
 *
 * This exists for a caller holding an array that has picked up non-index own
 * properties which it knows are not content -- a runtime annotation, say -- and
 * which the conversion functions here would therefore reject outright. Calling
 * this is how such a caller says explicitly that it means to drop them. Code
 * with no such warrant should let the rejection happen ("death before
 * confusion").
 *
 * The given array's index properties must all be enumerable data properties:
 * the copy reads elements through enumeration, which would execute an
 * accessor-backed index (silently flattening it to its momentary value) and
 * would turn a non-enumerable data index into a hole.
 *
 * @param value The array to clean.
 * @param frozen Whether to freeze the result. Defaults to `true`.
 */
export function shallowCleanArray(
  value: unknown[],
  frozen = true,
): FabricValueLayer {
  const result: unknown[] = [];

  // Set the extent first, so that trailing holes survive; assigning only the
  // present elements would leave `length` short.
  result.length = value.length;

  // A canonical index string addresses exactly the element slot it names, so
  // these are indexed by key directly, with no number parsing. The record views
  // exist only to say as much to TypeScript, which otherwise rejects a string
  // index on an array (TS7015).
  const from = value as unknown as Record<string, unknown>;
  const to = result as unknown as Record<string, unknown>;

  // `for...in` visits only the keys an array actually has, so a sparse one --
  // `length` can run to 2**32 - 2 -- does no JS-level work per absent slot, and
  // no key array gets materialized either. Note this is a large constant
  // factor, not a change of order: the engine still scans the index range to
  // work out which keys exist, measured at roughly 10x per 10x of `length` on a
  // two-element array. What it buys is that the scan happens inside the engine
  // instead of as a JS iteration, which for a proxied array also means one
  // `ownKeys` trap rather than a `has` trap per slot. It also yields any
  // named properties, which the index test drops, those being the whole point
  // of this function. Inherited keys are not a concern: this project bans
  // prototype pollution of the globals, and `Array.prototype`'s own methods are
  // non-enumerable. Every index key is necessarily below `length`, so none of
  // these assignments extends it.
  for (const key in value) {
    if (isArrayIndexPropertyName(key)) {
      to[key] = from[key];
    }
  }

  if (frozen) {
    Object.freeze(result);
  }

  return result;
}

/**
 * Returns a shallow clone of the given object carrying nothing but its
 * enumerable string-keyed properties, that is, one which satisfies
 * `isInertPlainObject()`. Values are copied by reference without themselves
 * being converted or validated, this being a shallow operation.
 *
 * This is the object counterpart of `shallowCleanArray()`, and exists for the
 * same reason: a caller holding an object that has picked up keys which it
 * knows are not content -- a runtime annotation, say -- uses this to say
 * explicitly that it means to drop them. Code with no such warrant should let
 * the rejection happen ("death before confusion").
 *
 * The result is always `Object.prototype`-based, so a null-prototype input
 * comes back with an ordinary prototype. That re-rooting is the point for such
 * an input: a `FabricPlainObject` has exactly one shape, so this is how a
 * caller holding a null-prototype object says it means to shed the prototype
 * rather than have the conversion functions refuse the value.
 *
 * @param value The object to clean.
 * @param frozen Whether to freeze the result. Defaults to `true`.
 */
export function shallowCleanPlainObject(
  value: object,
  frozen = true,
): FabricValueLayer {
  // `Object.entries()` yields exactly the enumerable string keys, which is the
  // set being kept, so rebuilding from it drops symbol keys and non-enumerable
  // string keys alike. A key holding `undefined` is still a present key and
  // survives as one, `undefined` being a `FabricValue` in its own right.
  const result = Object.fromEntries(Object.entries(value));

  if (frozen) {
    Object.freeze(result);
  }

  return result;
}

/** Map from Error subclass name to its constructor. */
const ERROR_CLASS_BY_TYPE: ReadonlyMap<string, ErrorConstructor> = new Map([
  ["TypeError", TypeError],
  ["RangeError", RangeError],
  ["SyntaxError", SyntaxError],
  ["ReferenceError", ReferenceError],
  ["URIError", URIError],
  ["EvalError", EvalError],
]);

/**
 * Helper for `FabricError`'s codec decoding, which returns the `Error`
 * constructor for the given type string (e.g. `"TypeError"`). Falls back
 * to the base `Error` constructor for unknown types.
 */
export function errorClassFromType(type: string): ErrorConstructor {
  return ERROR_CLASS_BY_TYPE.get(type) ?? Error;
}

/**
 * Returns the freshly-minted fabric form of a `Date`, `Uint8Array`, `RegExp`
 * or `Error`, and `undefined` for every other value. The result is always
 * frozen and always new: the whole of what this decides is whether conversion
 * produces a value, and for these four it does. An inert array or plain object
 * is already a fabric layer and mints nothing; so, at the other end, does a
 * value with no fabric representation at all.
 *
 * **The `undefined` says nothing about whether the value is usable.** It
 * reports only that there was nothing to mint, which is as true of a `Map` -- a
 * `FabricConvertibleJsObject` whose fabric form has yet to be built -- as it is
 * of a function. Membership and convertibility are separate questions, and this
 * answers neither: `assertValidFabricValueLayer()` decides what a value that
 * minted nothing may do next, and the pair is meant to be asked in that order.
 * A caller that skips the vet walks straight into a container it has not
 * vetted, and a `Map` rebuilt from its (empty) entries is a bare `{}`.
 *
 * @param value The value to convert.
 */
export function shallowFabricFromConvertibleJsObjectElseUndefined(
  value: unknown,
): FabricValueLayer | undefined {
  switch (tagOfConvertibleJsValueElseNull(value)) {
    case VALUE_TAGS.JsError: {
      // Shallow conversion, so the JS `Error` is wrapped without recursing
      // into its internals: `cause` and the custom properties are stored as
      // they stand, and the result is only a _shallow_ `FabricError`, whose
      // `.cause` may still be a raw `Error`. A caller needing a proper
      // (fully-`FabricValue`) one uses the deep
      // `fabricFromConvertibleJsValue()`, which rebuilds those slots; the cell
      // write paths do so at the points where they treat a `FabricError` as an
      // atomic leaf.
      //
      // The identity converter is a type lie: it says the values it hands
      // back are `FabricValue`s, and they are whatever the JS error held.
      // TODO(danfuzz): Address this type lie, for example by giving the deep
      // walk an error arm of its own so that no shallow instance is ever
      // built.
      return Object.freeze(FabricError.fromNativeError(value as Error, {
        convert: (nested) => nested as FabricValue,
      }));
    }

    case VALUE_TAGS.JsDate: {
      // A `Date` becomes a `FabricEpochNsec` (nanoseconds from the epoch).
      // Extra enumerable properties cause rejection ("death before
      // confusion").
      rejectExtraProperties(value as object, "Date");
      const nsec = BigInt((value as Date).getTime()) * 1_000_000n;
      return new FabricEpochNsec(nsec);
    }

    case VALUE_TAGS.JsRegExp: {
      // `FabricRegExp` rejects extra enumerable properties of its own accord.
      return new FabricRegExp(value as RegExp);
    }

    case VALUE_TAGS.JsUint8Array: {
      // A JS `Uint8Array` becomes a `FabricBytes`.
      return new FabricBytes(value as Uint8Array);
    }

    default: {
      return undefined;
    }
  }
}

/**
 * Performs shallow conversion from JS values to `FabricValue`. If the value is
 * already a frozen `FabricValue`, returns it as-is (identity optimization).
 *
 * @param value - The value to convert.
 * @param freeze - When `true` (default), freezes the result if it is an
 *   object or array. When `false`, wrapping and validation still occur but
 *   the result is left mutable.
 */
export function shallowFabricFromConvertibleJsValue(
  value: unknown,
  freeze = true,
): FabricValueLayer {
  const minted = shallowFabricFromConvertibleJsObjectElseUndefined(value);

  if (minted !== undefined) {
    // A mint is born frozen, so a caller that asked for a mutable result gets
    // a thawed copy. Only a `FabricError` is thawable at all: a
    // `FabricPrimitive` is frozen by its own contract and comes back as
    // itself.
    return freeze
      ? minted
      : cloneHelper(minted as FabricValue, false, false, false, null);
  }

  // Nothing was minted, so the value has to be usable as it stands; this
  // refuses it if it is not.
  assertValidFabricValueLayer(value);

  // Delegate frozenness handling to `cloneHelper()`, including its identity
  // optimization, which hands back an already-correctly-frozen value
  // untouched. A primitive and a `FabricPrimitive` alike come back as
  // themselves, both being immutable whatever was asked for.
  return cloneHelper(value as FabricValue, freeze, false, false, null);
}

// Sentinel value used to indicate an object is currently being processed
// (ancestor in the tree). If we encounter this while recursing, we have a
// circular reference.
const PROCESSING = Symbol("PROCESSING");

/**
 * Performs recursive conversion from JS values to `FabricValue`. If the input
 * is already a deep-frozen `FabricValue`, returns it as-is (identity
 * optimization).
 *
 * @param value - The value to convert. Declared `unknown` for caller
 *   convenience, but the call _throws_ unless it is in fact a
 *   `FabricConvertibleJsValue`; `isValidFabricConvertibleJsValue()` reports in
 *   advance whether it is.
 * @param freeze - When `true` (default), deep-freezes the result tree.
 *   When `false`, wrapping and validation still occur but the result is
 *   left mutable.
 */
export function fabricFromConvertibleJsValue(
  value: unknown,
  freeze = true,
): FabricValue {
  // Identity optimization: if the value is already a deep-frozen
  // `FabricValue`, return it without copying.
  if (freeze && isValidDeepFrozenFabricValue(value)) {
    return value;
  }
  return fabricFromConvertibleJsValueInternal(
    value,
    new Map(),
    freeze,
  );
}

/**
 * Helper for `fabricFromConvertibleJsValue()`, which performs the recursive
 * conversion.
 */
function fabricFromConvertibleJsValueInternal(
  original: unknown,
  converted: Map<object, FabricValue>,
  freeze: boolean,
): FabricValue {
  const isOriginalRecord = isObjectOrArray(original);

  if (isOriginalRecord && converted.has(original)) {
    const cached = converted.get(original);
    if (cached === PROCESSING) {
      throw new Error(
        "Conversion refuses a circular reference",
      );
    }
    return cached;
  }

  if (isOriginalRecord) {
    converted.set(original, PROCESSING);
  }

  // Try to convert the top level via the shallow converter. Pass
  // `freeze=false`: the deep path handles freezing its own newly-built results;
  // the shallow converter should not freeze anything.
  let value: FabricValueLayer;
  try {
    value = shallowFabricFromConvertibleJsValue(original, false);
  } catch (e) {
    if (isOriginalRecord) {
      converted.delete(original);
    }
    throw e;
  }

  // Primitives, `null`, and `undefined` don't need recursion or freezing.
  // Written as a `typeof` test rather than `!isObjectOrArray()` so the
  // non-object arms of `FabricValueLayer` narrow: every non-object layer
  // value is already a `FabricValue`.
  //
  // Nothing is recorded in `converted` here. Reaching this means `original`
  // was not a record: every record the shallow conversion accepts returns an
  // object, so a record cannot arrive at this branch, and a non-record is
  // not a key the map holds.
  if (typeof value !== "object" || value === null) {
    return value;
  }

  // `FabricError` has `FabricValue`-typed state slots (`cause`, `extra`) by
  // type contract, but the shallow conversion above copied them through from
  // the JS `Error` as-is (where they may be raw `Error`, `Map`, etc.).
  // Rebuild via the deep recursion so the resulting `FabricError`'s slots
  // really are `FabricValue`.
  if (value instanceof FabricError) {
    const result = rebuildFabricErrorDeep(value, converted, freeze);
    if (freeze) Object.freeze(result);
    if (isOriginalRecord) {
      converted.set(original, result);
    }
    return result;
  }

  // `FabricSpecialObject` (primitives and protocol types) -- pass through
  // as-is. Primitives are always frozen; protocol types are managed by the
  // caller.
  if (isFabricSpecialObject(value)) {
    if (isOriginalRecord) {
      converted.set(original, value);
    }
    return value;
  }

  let result: FabricValue;

  if (Array.isArray(value)) {
    // Recurse into array elements. Preserve `undefined` elements as-is.
    const resultArray: FabricValue[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        // Sparse hole -- preserve it by setting length without assigning.
        // This keeps the hole distinct from `undefined`.
        resultArray.length = i + 1;
      } else {
        resultArray[i] = fabricFromConvertibleJsValueInternal(
          value[i],
          converted,
          freeze,
        );
      }
    }
    if (freeze) Object.freeze(resultArray);
    result = resultArray;
  } else {
    // Recurse into object properties. Preserve `undefined`-valued properties.
    // The result is `Object.prototype`-rooted, which is the shape a fabric
    // record has and the only one an accepted input can carry.
    const obj = {} as Record<string, FabricValue>;
    for (const [key, val] of Object.entries(value)) {
      obj[key] = fabricFromConvertibleJsValueInternal(
        val,
        converted,
        freeze,
      );
    }
    if (freeze) Object.freeze(obj);
    result = obj;
  }

  if (isOriginalRecord) {
    converted.set(original, result);
  }

  return result;
}

/**
 * Creates a new `Error` with the same class and properties as the original,
 * but with `.cause` and custom enumerable properties recursively converted
 * to `FabricValue`. This ensures that when `FabricError`'s `[CODEC]` encodes
 * at encode time, all nested values are already `FabricValue`.
 *
 * We create a new `Error` rather than mutating the original because the
 * caller's `Error` should not be modified as a side effect of converting it.
 */
function rebuildFabricErrorDeep(
  shallow: FabricError,
  converted: Map<object, FabricValue>,
  freeze: boolean,
): FabricError {
  // Recursively convert `.cause` -- it could be a raw `Error`, `Map`, etc.
  const cause = shallow.cause !== undefined
    ? fabricFromConvertibleJsValueInternal(shallow.cause, converted, freeze)
    : undefined;

  // Recursively convert custom enumerable properties.
  const extras: Array<[string, FabricValue]> = [];
  for (const [key, value] of shallow.extraEntries()) {
    extras.push([
      key,
      fabricFromConvertibleJsValueInternal(value, converted, freeze),
    ]);
  }

  return new FabricError({
    type: shallow.type,
    name: shallow.name,
    message: shallow.message,
    stack: shallow.stack,
    cause,
    extras,
  });
}

/**
 * Returns `true` if `fabricFromConvertibleJsValue()` would succeed on the
 * value, that is, if the value is a `FabricValue`, a
 * `FabricConvertibleJsObject`, or a deep tree thereof.
 *
 * The distinction from `isValidFabricValueLayer()`:
 * - `isValidFabricValueLayer(x)`: "is x already a `FabricValue`?" but only a
 *   shallow check.
 * - `isValidFabricConvertibleJsValue(x)`: "could x be converted to a
 *   `FabricValue` via `fabricFromConvertibleJsValue()`?"
 *
 * `isValidFabricConvertibleJsValue()` additionally accepts
 * `FabricConvertibleJsObject` types. It checks recursively, so all nested
 * values in arrays and objects must also be fabric-convertible.
 *
 * This function is a TypeScript type guard for `FabricConvertibleJsValue`,
 * which names the recursive shape described above.
 */
export function isValidFabricConvertibleJsValue(
  value: unknown,
): value is FabricConvertibleJsValue {
  return isValidFabricConvertibleJsValueInternal(value, new Set());
}

function isValidFabricConvertibleJsValueInternal(
  value: unknown,
  seen: Set<object>,
): boolean {
  // Primitives: `null`, `boolean`, `string`, `number`, `bigint`, `undefined`.
  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "symbol": {
      // Registry-interned symbols are fabric-convertible; unique ones are not.
      return Symbol.keyFor(value) !== undefined;
    }

    case "function": {
      // A function is live code, and has no fabric representation.
      return false;
    }

    case "object": {
      // `FabricSpecialObject` -- already a valid `FabricValue`.
      if (isFabricSpecialObject(value)) return true;

      // `FabricConvertibleJsObject` types would be wrapped by
      // `fabricFromConvertibleJsValue()`.
      if (isValidFabricConvertibleJsObject(value)) {
        return true;
      }

      // Cycle detection for arrays and objects.
      if (seen.has(value)) return false;
      seen.add(value);

      if (Array.isArray(value)) {
        // Check array structure (a direct `Array` instance, no non-index
        // properties, no accessor-backed indices).
        if (!isInertArray(value)) {
          seen.delete(value);
          return false;
        }
        // Check all elements recursively.
        for (let i = 0; i < value.length; i++) {
          if (
            i in value &&
            !isValidFabricConvertibleJsValueInternal(value[i], seen)
          ) {
            seen.delete(value);
            return false;
          }
        }
        seen.delete(value);
        return true;
      }

      // Class instances are not fabric-convertible.
      if (isInstance(value)) {
        seen.delete(value);
        return false;
      }

      // Plain objects -- check the key shape, then all property values
      // recursively. A symbol key or a non-enumerable string key has no fabric
      // representation, just as an array's non-index properties do not.
      if (
        !isInertPlainObject(value) ||
        (unsafeObjectKeyIn(value) !== undefined)
      ) {
        seen.delete(value);
        return false;
      }
      for (const val of Object.values(value)) {
        if (!isValidFabricConvertibleJsValueInternal(val, seen)) {
          seen.delete(value);
          return false;
        }
      }
      seen.delete(value);
      return true;
    }

    default: {
      return false;
    }
  }
}

/**
 * Recursively walks a `FabricValue` tree, unwrapping any `FabricNativeWrapper`
 * values to their underlying JS types via `toNativeValue()`. Non-native
 * `FabricInstance` values (e.g., `UnknownValue`) pass through as-is.
 *
 * The freeze-state contract: the output's freeze state matches `frozen`, except
 * that instances of classes that are defined to always be frozen are in fact
 * returned as frozen, no matter the value of `frozen`.
 */
export function convertibleJsFromFabricValue(
  value: FabricValue,
  frozen = true,
): FabricConvertibleJsValue {
  if (value instanceof FabricError) {
    return deepUnwrapFabricError(value, frozen);
  }

  if (value instanceof FabricNativeWrapper) {
    return value.toNativeValue(frozen);
  }

  // Remaining `FabricSpecialObject` values (not `FabricNativeWrapper`) pass
  // through unchanged.
  if (isFabricSpecialObject(value)) return value;

  if (!isObjectOrArray(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const result: FabricConvertibleJsValue[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        result.length = i + 1;
      } else {
        result[i] = convertibleJsFromFabricValue(
          value[i],
          frozen,
        );
      }
    }
    if (frozen) Object.freeze(result);
    return result;
  }

  const result: Record<string, FabricConvertibleJsValue> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!isUnsafeObjectKey(key)) {
      result[key] = convertibleJsFromFabricValue(val, frozen);
    }
  }
  if (frozen) Object.freeze(result);
  return result;
}

function deepUnwrapFabricError(fe: FabricError, frozen: boolean): Error {
  const type = fe.type;
  const name = fe.name ?? type;
  const ErrorClass = errorClassFromType(type);
  const copy = new ErrorClass(fe.message);
  if (copy.name !== name) copy.name = name;
  if (fe.stack !== undefined) copy.stack = fe.stack;

  if (fe.cause !== undefined) {
    copy.cause = convertibleJsFromFabricValue(fe.cause, frozen);
  }

  for (const [key, value] of fe.extraEntries()) {
    (copy as unknown as Record<string, unknown>)[key] =
      convertibleJsFromFabricValue(
        value,
        frozen,
      );
  }

  if (frozen) Object.freeze(copy);
  return copy;
}
