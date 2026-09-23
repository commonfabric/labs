/**
 * The dispatches that return a tag from the vocabulary in `tags.ts`, one
 * per kind of value a caller can be holding.
 *
 * Which classes a given dispatch recognizes varies with where it is layered:
 * recognizing a `FabricBytes` means holding the `FabricBytes` class, which not
 * every caller can. The vocabulary does not vary, so it is one constant there
 * rather than one inside each of them.
 */

import { isPlainObject } from "@commonfabric/utils/types";

import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";
import {
  FabricInstance,
  FabricPrimitive,
  type FabricValueLayer,
  type FabricValuePlusLayer,
} from "@/interface.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "@/fabric-primitives/interface.ts";
import { debugStr } from "@/value-debug";

import { type PlusTypePredicate } from "./interface.ts";
import {
  type ConvertibleJsValueTag,
  type FabricValuePlusTag,
  type FabricValueTag,
  VALUE_TAGS,
} from "./tags.ts";

/**
 * Maps a `FabricPrimitive` to its tag. This `throw`s if it determines that the
 * given value is not valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagOfFabricPrimitive(
  value: FabricPrimitive,
): FabricPrimitiveValueTag {
  const result = tagOfFabricPrimitiveElseNull(value);

  if (result !== null) {
    return result;
  }

  throw new Error(debugStr`Not a valid \`FabricPrimitive\`: $quote${value}`);
}

/**
 * Maps a `FabricPrimitive` to its tag. This returns `null` if the given value
 * turns out not to be valid: a type lie, an instance of no primitive class, or
 * one reporting a tag that is not a primitive tag.
 */
export function tagOfFabricPrimitiveElseNull(
  value: FabricPrimitive,
): FabricPrimitiveValueTag | null {
  if (!(value instanceof BaseFabricPrimitive)) {
    return null;
  }

  const tag = value[VALUE_TAG];

  return ((typeof tag === "string") &&
      Object.hasOwn(FABRIC_PRIMITIVE_VALUE_TAGS, tag))
    ? tag
    : null;
}

/**
 * Maps an arbitrary value to a `FabricValueTag`, based on a shallow evaluation
 * of its type as a possibly-valid `FabricValue`, `FabricValueLayer`, or `*Plus`
 * version of same. This returns `null` if it determines that the given value
 * cannot possibly be valid. To get a `PlusType` return value, a corresponding
 * type predicate must be passed as the second argument, and that function is
 * used to make a determination if the value would otherwise be considered
 * invalid.
 *
 * This function is intentionally not `export`ed, as the two cases it covers are
 * better handled by the `export`ed ones. The point of this function is to help
 * keep this file DRY.
 */
function tagOfUnknownElseNull(
  value: unknown,
): FabricValueTag | null;
function tagOfUnknownElseNull<PlusType = never>(
  value: unknown,
  isPlusType: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null;
function tagOfUnknownElseNull<PlusType = never>(
  value: unknown,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null {
  const jsType = typeof value;

  switch (jsType) {
    case "function": {
      // Values of type `function` are _never_ `FabricValue`s: `FabricValue`
      // contractually represents that its contents are inert, and `function` is
      // about as "ert" as a value can get. However, the `PlusType` may accept
      // `function`s, so we check that to make a final determination as to tag.
      return isPlusType?.(value) ? VALUE_TAGS.PlusType : null;
    }

    case "object": {
      if (value === null) {
        return VALUE_TAGS.null;
      }
      break; // ...and handle non-null objects after the `switch`.
    }

    case "symbol": {
      // Only _interned_ symbols are allowed as `FabricValue`. However, the
      // `PlusType` may accept uninterned symbols, so we check that to make a
      // final determination as to tag.
      const isInterned = Symbol.keyFor(value as symbol) !== undefined;
      if (isInterned) {
        return VALUE_TAGS.symbol;
      } else {
        return isPlusType?.(value) ? VALUE_TAGS.PlusType : null;
      }
    }

    default: {
      return jsType;
    }
  }

  if (Array.isArray(value)) {
    return VALUE_TAGS.Array;
  } else if (isPlainObject(value)) {
    return VALUE_TAGS.Object;
  } else if (value instanceof FabricPrimitive) {
    // Note: If `value` turns out to be an invalid `FabricPrimitive`, this will
    // return `null` instead of falling through to an `isPlusType()` check. The
    // reasoning here is that the full class hierarchy under `FabricPrimitive`
    // is meant to be controlled by the `data-model`, and so any invalid
    // `FabricPrimitive` is de facto a bug in the `data-model`, and that makes
    // it _more correct_ to return `null` here compared to blithely calling
    // through to an `isPlusType()` predicate which should never have been
    // called with such a value.
    return tagOfFabricPrimitiveElseNull(value);
  } else if (value instanceof FabricInstance) {
    return VALUE_TAGS.FabricInstance;
  } else if (isPlusType?.(value)) {
    return VALUE_TAGS.PlusType;
  } else {
    return null;
  }
}

/**
 * Maps a presumed valid `FabricValue`, `FabricValueLayer`, or corresponding
 * `*Plus` value to its tag, based on a shallow evaluation of its type. This
 * `throw`s if it determines that the given value cannot possibly be valid. For
 * `*Plus` values, a corresponding type predicate must be passed as the second
 * argument, and that function is used to make a determination if the value
 * would otherwise be considered invalid.
 */
export function tagOfFabricValue(value: FabricValueLayer): FabricValueTag;
export function tagOfFabricValue<PlusType = never>(
  value: NoInfer<FabricValuePlusLayer<PlusType>>,
  isPlusType: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag;
export function tagOfFabricValue<PlusType = never>(
  value: FabricValuePlusLayer<PlusType>,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag {
  // For rationale, see comment on the similar call in
  // `tagOfFabricValueElseNull()`, below.
  const result = tagOfUnknownElseNull(value, isPlusType);

  if (result !== null) {
    return result;
  }

  throw new Error(
    debugStr`Not possibly a valid \`FabricValue\`: $quote${value}`,
  );
}

/**
 * Maps a presumed valid `FabricValue`, `FabricValueLayer`, or corresponding
 * `*Plus` value to its tag, based on a shallow evaluation of its type. This
 * returns `null` if it determines that the given value cannot possibly be
 * valid. For `*Plus` values, a corresponding type predicate must be passed as
 * the second argument, and that function is used to make a determination if the
 * value would otherwise be considered invalid.
 */
export function tagOfFabricValueElseNull(
  value: FabricValueLayer,
): FabricValueTag | null;
export function tagOfFabricValueElseNull<PlusType = never>(
  value: NoInfer<FabricValuePlusLayer<PlusType>>,
  isPlusType: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null;
export function tagOfFabricValueElseNull<PlusType = never>(
  value: FabricValuePlusLayer<PlusType>,
  isPlusType?: PlusTypePredicate<PlusType> | undefined,
): FabricValuePlusTag | null {
  // The point of this arrangement -- instead of having an `unknown` overload on
  // this function -- is so that the `unknown` argument doesn't get
  // inadvertently bound when code is trying to have proper type hygiene.
  return tagOfUnknownElseNull(value, isPlusType);
}

/**
 * Maps a possible `FabricConvertibleJsValue` to its tag, based on a shallow
 * evaluation of its type. This returns `null` if it determines that the given
 * value isn't possibly either a valid `FabricValue` or an instance of one of
 * the members of `FabricConvertibleJsObject`.
 *
 * Note: Instances of `Error` are _only_ detected in this function using
 * `Error.isError()` and _not_ by looking at the prototype chain.
 *
 * Note: The other `FabricConvertibleJsObject` classes are recognized by
 * prototype identity, which is a per-realm question: another realm's `Map`
 * is a different `Map`, and is not this one. Such a value comes back `null`,
 * unrecognized rather than misidentified. The global constructor bindings do
 * not enter into it: SES lockdown replaces the global `Date` and `RegExp` with
 * constructors of its own that keep the original prototypes, so an instance
 * made before lockdown, after it, or inside a compartment is recognized alike.
 */
export function tagOfConvertibleJsValueElseNull(
  value: unknown,
): ConvertibleJsValueTag | null {
  // Note: This function is written to prioritize DRYness over avoiding
  // redundant work, especially in that (a) the redundancy is minimal generally
  // speaking, and (b) in the context of doing value conversion, the redundancy
  // rounds to basically nothing. The one thing worth mentioning is that in the
  // code here _might_ get the prototype of a given value twice, and in the case
  // of a buggy `Proxy`, that answer might not be the same both times. We accept
  // that possibility here, for the usual reason in this codebase: The code's
  // job is to produce correct results in the face of non-buggy input and not to
  // detect all possible bugs.

  if (Error.isError(value)) {
    return VALUE_TAGS.JsError;
  }

  const result = tagOfUnknownElseNull(value);

  if (result !== null) {
    return result;
  }

  switch (typeof value) {
    case "function": {
      // Functions are not allowed as `FabricConvertibleJsValue`s. That said,
      // the `typeof` test here is covering a pretty oddball case, namely when a
      // value of type `function` is observed to have a `prototype` which
      // matches one of the recognized convertible classes. This is in the zone
      // of intentional misbehavior (at worst) or a _very_ surprising bug at
      // best. However, in the context of value conversion, the test is pretty
      // cheap and so reasonably worth doing.
      return null;
    }

    case "symbol": {
      // A unique (uninterned) symbol: `tagOfUnknownElseNull()` refused it, and
      // there is no class to ask about. A registry-interned symbol never gets
      // here, having been tagged above.
      return null;
    }

    case "object": {
      // As of this writing, `value` must be a non-null value of type `object`
      // here due to how `tagOfUnknownElseNull()` works: every other `typeof`
      // is either tagged there or handled by a case above. This is more of a
      // defense-in-depth or separation of concerns.
      if (value === null) {
        // deno-coverage-ignore-start
        return null;
      }
      // deno-coverage-ignore-stop

      // Otherwise handled below.
      break;
    }

    default: {
      // deno-coverage-ignore-start -- See the comment on `object` above.
      return null;
    }
      // deno-coverage-ignore-stop
  }

  switch (Object.getPrototypeOf(value)) {
    case Map.prototype: {
      return VALUE_TAGS.JsMap;
    }

    case Set.prototype: {
      return VALUE_TAGS.JsSet;
    }

    case Date.prototype: {
      return VALUE_TAGS.JsDate;
    }

    case Uint8Array.prototype: {
      return VALUE_TAGS.JsUint8Array;
    }

    case RegExp.prototype: {
      return VALUE_TAGS.JsRegExp;
    }

    default: {
      return null;
    }
  }
}
