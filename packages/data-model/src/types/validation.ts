/**
 * The predicates deciding whether a value belongs to the `FabricValue` type.
 * The single-level predicate has a throwing form beside it, which decides
 * exactly what the predicate decides and exists to say why the answer was no.
 *
 * Membership turns on inertness: a `FabricValue` is data, so anything that is
 * live code is refused -- a function, an accessor-backed property, the
 * prototype of an `Array` subclass, a symbol that was never registry-interned.
 * Frozen-ness is a separate question and deliberately not asked here, so a
 * structurally-valid unfrozen value is a member.
 *
 * Each of these takes an `unknown`, that being what a caller holds before
 * membership is settled. The narrowings that ask a shape question of a value
 * already typed as a `FabricValue` are in `narrowing.ts`, and are looser than
 * membership on purpose.
 */

import { isInertArray } from "@commonfabric/utils/arrays";
import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  constructorOfObject,
  isInertPlainObject,
} from "@commonfabric/utils/objects";
import {
  isObjectOrArray,
  isPlainObject,
  unsafeObjectKeyIn,
} from "@commonfabric/utils/types";

import { BaseFabricInstance } from "@/fabric-bases/BaseFabricInstance.ts";
import { BaseFabricPrimitive } from "@/fabric-bases/BaseFabricPrimitive.ts";
import {
  type FabricConvertibleJsObject,
  type FabricPlainObject,
  type FabricValue,
  type FabricValueLayer,
} from "@/interface.ts";
import { isFabricPlainObject, isFabricSpecialObject } from "./narrowing.ts";
import { tagOfConvertibleJsValueElseNull } from "./tag-of.ts";
import { VALUE_TAGS } from "./tags.ts";

/**
 * Indicates whether the value is a `FabricValue`, accepting
 * `FabricSpecialObject`s (both `FabricInstance` and `FabricPrimitive`),
 * `undefined`, and arrays with `undefined` elements or sparse holes -- in
 * addition to the base fabric types (`null`, `boolean`, `number`, `string`,
 * plain objects, dense arrays). An array must be a direct `Array` instance; a
 * subclass instance is not a `FabricValue`.
 *
 * This function is a TypeScript type guard for `FabricValueLayer`.
 */
export function isValidFabricValueLayer(
  value: unknown,
): value is FabricValueLayer {
  switch (typeof value) {
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "undefined": {
      return true;
    }

    case "object": {
      if (value === null) {
        return true;
      }
      // `FabricSpecialObject` -- already a valid `FabricValue`.
      if (isFabricSpecialObject(value)) {
        return true;
      }
      if (Array.isArray(value)) {
        // Arrays with `undefined` elements and sparse holes are accepted, but
        // not arrays carrying named or symbol-keyed properties, nor an
        // accessor-backed index, nor an indirect instance such as an `Array`
        // subclass (all live code rather than inert data).
        return isInertArray(value);
      }
      // Plain objects are accepted; class instances are not (except
      // `FabricSpecialObject`, handled above). `FabricPlainObject` is keyed by
      // `string`, so a symbol key has no representation either, and neither
      // does a non-enumerable string key; an accessor-backed property is live
      // code rather than inert data. The names this runtime reserves are a
      // separate question from inertness -- see `unsafeObjectKeyIn()`.
      return isInertPlainObject(value) &&
        (unsafeObjectKeyIn(value) === undefined);
    }

    case "symbol": {
      // Registry-interned symbols are valid `FabricValue`s; unique ones are
      // not.
      return Symbol.keyFor(value) !== undefined;
    }

    case "function":
    default: {
      // A note about functions: Values of type `function` are very
      // intentionally _never_ considered to possibly be `FabricValue`s:
      // `FabricValue` contractually represents that its contents are inert, and
      // `function` is about as "ert" as a value can get.
      return false;
    }
  }
}

/**
 * Reads a value's constructor, or `undefined` where there is none to read.
 *
 * The class is read from the prototype rather than from the value, for the
 * reason the dispatch reads it there: an own `constructor` property is
 * ordinary data, so a value could otherwise choose the name it is refused
 * under.
 *
 * Nothing here is allowed to throw, because every caller is already on its way
 * to reporting a different problem and an error raised here would replace it.
 * A `constructor` accessor on the prototype that throws is the reachable way
 * that happens.
 */
function constructorElseUndefined(
  value: object,
): { name?: unknown } | undefined {
  try {
    return constructorOfObject(value) as { name?: unknown } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Helper for `assertValidFabricValueLayer()`, which names the class of a value
 * being refused, given the constructor already read from it. A `name` that is
 * not a string is treated as no name at all.
 */
function classNameOf(
  ctor: { name?: unknown } | undefined,
  value: unknown,
): string {
  let name: unknown;
  try {
    name = ctor?.name;
  } catch {
    // `name` can be an accessor too, and this runs while a refusal is being
    // explained. A class that will not say what it is called has no name here.
    return typeof value;
  }
  return (typeof name === "string" && name !== "") ? name : typeof value;
}

/**
 * Throws unless the value is usable as a `FabricValueLayer`, naming what is
 * wrong with it when it is not. This is `isValidFabricValueLayer()` asked so
 * that the answer carries a reason: that predicate decides the outcome and
 * this adds nothing to it, everything past the decision existing to say why it
 * went the way it did.
 *
 * A `FabricConvertibleJsObject` gets a reason of its own: a `Date` and a `Map`
 * alike are values conversion has a say over, which is a different position
 * from a class instance that has no fabric form at all. The message says which,
 * and sends the caller to ask.
 *
 * @param value The value to check.
 */
export function assertValidFabricValueLayer(
  value: unknown,
): asserts value is FabricValueLayer {
  if (isValidFabricValueLayer(value)) {
    return;
  }

  // Past here the value is refused, and all that is left is to say why. Each
  // test below distinguishes two reasons from each other; none of them decides
  // the outcome, which the call above already did.

  // Read once, and let every arm below share it. A `constructor` accessor is
  // ordinary code and may answer differently each time it is asked, so asking
  // it repeatedly would let one refusal name two different classes.
  const ctor = isObjectOrArray(value)
    ? constructorElseUndefined(value)
    : undefined;
  // Compared with `Array` itself rather than asked of the tag lookup, which
  // reads `.prototype` -- a read a callable `Proxy` can trap, and this is the
  // refusal path. `Array` is the only constructor that lookup calls an array,
  // so the two ask the same question.
  const classIsArray = ctor === Array;

  if (Array.isArray(value) || classIsArray) {
    // An array in this system is _inert_: a direct `Array` instance, which may
    // only carry numeric index properties, each a data property. A named or
    // symbol-keyed property has no fabric representation, and an
    // accessor-backed index is live code rather than inert data -- as is the
    // prototype of an `Array` subclass instance, which can make iteration
    // yield differently than the indices say.
    //
    // A value whose class is `Array` without being one gets this reason too.
    // It is not an array, so the rule that decides arrays never reached it,
    // but `Array` is what it presents itself as and so what a reader is owed
    // an answer about -- and it is the reason the conversion gives.
    throw new Error(
      "Not representable as a `FabricValue`: array that is not an inert array",
    );
  }

  switch (typeof value) {
    case "function": {
      throw new Error("Not representable as a `FabricValue`: function");
    }
    case "symbol": {
      // Registry-interned symbols are valid `FabricValue`s; unique ones have
      // no portable representation.
      throw new Error(
        "Not representable as a `FabricValue`: unique (uninterned) symbol",
      );
    }
  }

  // The outcome is already settled; this only picks which reason to give, so a
  // value that makes the probe fail gets the generic reason rather than the
  // probe's error in place of a refusal. A `constructor` accessor on the
  // prototype that throws is the reachable way that happens.
  let isNativeObject: boolean;
  try {
    isNativeObject = isValidFabricConvertibleJsObject(value);
  } catch {
    isNativeObject = false;
  }

  if (isNativeObject) {
    throw new Error(
      `Not already a \`FabricValue\`: ${
        backtickQuote(classNameOf(ctor, value))
      } (a \`FabricConvertibleJsObject\`, so conversion is what decides it)`,
    );
  }

  if (isPlainObject(value)) {
    // A reserved property name is a restriction of this implementation rather
    // than of the model, so it says so rather than blaming inertness: such an
    // object _is_ inert, and a runtime that does not route property assignment
    // through a prototype chain reserves no names at all.
    const unsafeKey = isInertPlainObject(value)
      ? unsafeObjectKeyIn(value)
      : undefined;
    if (unsafeKey !== undefined) {
      throw new Error(
        "Not representable as a `FabricValue`: object with a property name " +
          `this runtime reserves (\`${unsafeKey}\`)`,
      );
    }
    // A plain object is _inert_ for the same reasons an array is:
    // `FabricPlainObject` is keyed by `string`, so a symbol key has no fabric
    // representation, and neither does a non-enumerable string key; an
    // accessor-backed property is live code rather than inert data. A
    // null-prototype object is refused here too: a record has one shape in
    // this system, and a prototype is not part of what a value says as data.
    throw new Error(
      "Not representable as a `FabricValue`: object that is not an inert " +
        "plain object",
    );
  }

  // No recognized shape at all -- an ordinary class instance, most commonly.
  // Death before confusion!
  throw new Error(
    `Not representable as a \`FabricValue\`: ${
      backtickQuote(classNameOf(ctor, value))
    } (not a recognized fabric type)`,
  );
}

/**
 * Indicates whether the value is a `FabricValue` -- a recursive check of exact
 * structural membership in the `FabricValue` type, independent of frozen-ness.
 *
 * Returns `true` for any scalar (`null`, `undefined`, `boolean`, `number` --
 * including `-0`, `NaN`, and `±Infinity` -- `string`, `bigint`, and
 * registry-interned (`Symbol.for(...)`) symbols), any `FabricInstance` or
 * `FabricPrimitive`, a direct `Array` instance holding `FabricValue`s with no
 * named or symbol-keyed properties, `length` aside (sparse holes allowed), or a
 * plain object whose values are all `FabricValue`s. Returns `false` for a
 * `function` or a unique (uninterned) symbol -- whether the value itself or
 * reached anywhere within it -- for an accessor-backed (getter/setter) property
 * anywhere, plain-object keyed or array-indexed alike, which makes its
 * container non-inert, for an `Array` subclass instance or other
 * indirectly-rooted array, whose prototype is live code the same way an
 * accessor is, and for any other class instance (`Date`, `Map`, ...) not
 * representable as a `FabricValue`. Handles circular references.
 *
 * This is a *membership* check, not a frozen-ness check: a structurally-valid
 * but unfrozen object or array is still a `FabricValue`. For the deep-frozen
 * question, see `isValidDeepFrozenFabricValue()`. A `FabricInstance` is a
 * member by type (it is a `FabricSpecialObject`); this does not recurse into
 * its private interior, whose contents are `FabricValue`s by the instance's
 * construction contract and are reachable only via frozen-semantic protocols
 * that a membership check must not invoke.
 *
 * Contrast the shallow, single-level sibling `isValidFabricValueLayer()` and
 * `isValidFabricConvertibleJsValue()` (which additionally accepts JS values
 * *convertible* to fabric form).
 *
 * This is the admission test the encoding path's input contract is written
 * against: a value this accepts is one that path takes, and one it does not
 * gets whatever best-effort handling costs correct input nothing. What an
 * accepted value encodes to is `BaseCodecEngine.encode()`'s to say -- given
 * one, a format writes its serialized form or throws for a reason it names,
 * a cycle among them.
 */
export function isValidFabricValue(value: unknown): value is FabricValue {
  // Fast leaf paths first, so a function or a primitive returns without
  // allocating the cycle-tracking set or the recursion closure below.
  if (typeof value === "function") {
    return false;
  } else if (typeof value === "symbol") {
    // Only registry-interned symbols are `FabricValue`s; unique (uninterned)
    // symbols are not portable across realms and are rejected, matching
    // `isValidFabricValueLayer()`.
    return Symbol.keyFor(value) !== undefined;
  } else if (!isObjectOrArray(value)) {
    // A non-function, non-symbol primitive -- a direct `FabricValue` member.
    return true;
  }

  // We have object structure to walk. Allocate the cycle-tracking set and build
  // the recursion callback once here, reusing the same closure at every layer.
  const seen = new Set<object>();
  const check = (item: unknown): boolean => {
    if (typeof item === "function") return false;
    if (typeof item === "symbol") return Symbol.keyFor(item) !== undefined;
    if (!isObjectOrArray(item)) {
      // A non-function, non-symbol primitive.
      return true;
    } else if (seen.has(item)) {
      // Already being validated higher in the recursion; treat as a member for
      // the rest of this walk (a cycle back to an in-progress value).
      return true;
    }

    seen.add(item);

    if (BaseFabricPrimitive.isInstance(item)) {
      // A `FabricPrimitive` is a `FabricValue` with no outbound references.
      return true;
    } else if (BaseFabricInstance.isInstance(item)) {
      // A `FabricInstance` is a `FabricValue` by type. Its logical contents
      // are private and reachable only through the frozen-semantic
      // `[IS_DEEP_FROZEN]`/`[DEEP_FREEZE]` protocols, which a pure membership
      // check must not invoke; the instance's construction contract already
      // guarantees its interior holds `FabricValue`s. So membership trusts the
      // type and does not recurse.
      return true;
    } else if (Array.isArray(item)) {
      // Arrays with named (non-index) or symbol-keyed properties have no
      // fabric representation; an accessor-backed index is live code rather
      // than inert data, as is the prototype of an indirect instance such as
      // an `Array` subclass.
      if (!isInertArray(item)) return false;
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) continue; // sparse hole
        if (!check(item[i])) return false;
      }
      return true;
    } else if (isPlainObject(item)) {
      // Symbol-keyed and non-enumerable string-keyed properties have no fabric
      // representation, the same as an array's non-index properties; an
      // accessor-backed property is live code rather than inert data. The
      // names this runtime reserves are a separate question from inertness --
      // see `unsafeObjectKeyIn()`.
      if (!isInertPlainObject(item)) return false;
      if (unsafeObjectKeyIn(item) !== undefined) return false;
      for (const key of Object.keys(item)) {
        if (!check(item[key])) return false;
      }
      return true;
    } else {
      // An instance of a class not covered by the `FabricValue` type.
      return false;
    }
  };

  return check(value);
}

/**
 * Indicates whether the value is a `FabricPlainObject`: both a `FabricValue`
 * (`isValidFabricValue()`) and a plain object, meaning its prototype is
 * `Object.prototype` and its every property value is a `FabricValue` in turn.
 *
 * This is a *membership* check asked of an `unknown`, which makes it strictly
 * narrower at runtime than the narrowing `isFabricPlainObject()`: that one is
 * asked of a value already typed as a `FabricValue`, and accepts a
 * null-prototype object, which membership refuses.
 */
export function isValidFabricPlainObject(
  value: unknown,
): value is FabricPlainObject {
  return isValidFabricValue(value) && isFabricPlainObject(value);
}

/**
 * Returns `true` if the value is a `FabricConvertibleJsObject`: one of the
 * "wild-west" convertible JS objects that the conversion layer wraps into a
 * `FabricNativeWrapper` subclass, a `FabricPrimitive`, or a `FabricInstance`.
 *
 * Arrays, plain objects, and system-defined `FabricPrimitive`s are _not_
 * `FabricConvertibleJsObject`s -- they have their own handling paths in the
 * conversion layer.
 *
 * Membership is not convertibility: a `Map` and a `Set` are members whose
 * fabric form has yet to be built.
 *
 * This function is a TypeScript type guard for `FabricConvertibleJsObject`.
 */
export function isValidFabricConvertibleJsObject(
  value: unknown,
): value is FabricConvertibleJsObject {
  switch (tagOfConvertibleJsValueElseNull(value)) {
    case VALUE_TAGS.JsError:
    case VALUE_TAGS.JsMap:
    case VALUE_TAGS.JsSet:
    case VALUE_TAGS.JsDate:
    case VALUE_TAGS.JsUint8Array:
    case VALUE_TAGS.JsRegExp: {
      return true;
    }

    default: {
      return false;
    }
  }
}
