/**
 * The tag vocabulary: the names a dispatch returns when asked what a value
 * already is. The dispatches themselves are in `tag-of.ts`. The tags the
 * primitive classes report are defined beside those classes, in
 * `fabric-primitives/interface.ts`, and the tables here that include them take
 * them from there. That module is this one's only import, and it imports
 * nothing, so a class which reports a tag of its own can name its vocabulary
 * without reaching the dispatches, which recognize that class.
 */

import { FABRIC_PRIMITIVE_VALUE_TAGS } from "@/fabric-primitives/interface.ts";

/**
 * The tags of the non-fundamental JS classes (that is, neither plain object nor
 * array) whose instances are recognized as included in the
 * `FabricConvertibleJsObject` type. Each tag is `Js` followed by the name of
 * the global class it stands for, which keeps the tags unambiguous and is what
 * ties each one to its class: `tags-agreement.ts` stops compiling when this
 * table and `FabricConvertibleJsObject` stop agreeing.
 */
export const FABRIC_CONVERTIBLE_JS_OBJECT_TAGS = Object.freeze(
  {
    JsDate: "JsDate",
    JsError: "JsError",
    JsMap: "JsMap",
    JsRegExp: "JsRegExp",
    JsSet: "JsSet",
    JsUint8Array: "JsUint8Array",
  } as const,
);

/** One of the `FabricConvertibleJsObject` tag strings. */
export type FabricConvertibleJsObjectTag =
  typeof FABRIC_CONVERTIBLE_JS_OBJECT_TAGS[
    keyof typeof FABRIC_CONVERTIBLE_JS_OBJECT_TAGS
  ];

/**
 * The tags of the JS primitive types (all of them other than `object` and
 * `function`), plus `null`.
 *
 * **Note:** This is intentionally not `export`ed; it's just a convenience for
 * keeping this file DRY-er.
 */
const JS_PRIMITIVE_TYPE_VALUE_TAGS = Object.freeze(
  {
    bigint: "bigint",
    boolean: "boolean",
    null: "null",
    number: "number",
    string: "string",
    symbol: "symbol",
    undefined: "undefined",
  } as const,
);

/**
 * The tags of all JS types other than `object`, plus `null`: the vocabulary of
 * `typeOfIncludingNull()`, less `object`.
 */
export const JS_TYPE_VALUE_TAGS = Object.freeze(
  {
    function: "function",
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the JS type tag strings. */
export type JsTypeValueTag =
  typeof JS_TYPE_VALUE_TAGS[keyof typeof JS_TYPE_VALUE_TAGS];

/** The tags for all primitive types, either JS-builtin or `FabricPrimitive`. */
export const PRIMITIVE_VALUE_TAGS = Object.freeze(
  {
    ...JS_PRIMITIVE_TYPE_VALUE_TAGS,
    ...FABRIC_PRIMITIVE_VALUE_TAGS,
  } as const,
);

/** Tag for any primitive type, either JS-builtin or `FabricPrimitive`. */
export type PrimitiveValueTag =
  typeof PRIMITIVE_VALUE_TAGS[keyof typeof PRIMITIVE_VALUE_TAGS];

/** The tags for all recognized container types. */
export const FABRIC_CONTAINER_VALUE_TAGS = Object.freeze(
  {
    Array: "Array",
    FabricInstance: "FabricInstance",
    Object: "Object",
  } as const,
);

/** Tag for any recognized container type. */
export type FabricContainerValueTag =
  typeof FABRIC_CONTAINER_VALUE_TAGS[keyof typeof FABRIC_CONTAINER_VALUE_TAGS];

/** Tags for all values that could possibly be valid `FabricValue`s. */
export const FABRIC_VALUE_TAGS = Object.freeze(
  {
    ...PRIMITIVE_VALUE_TAGS,
    ...FABRIC_CONTAINER_VALUE_TAGS,
  } as const,
);

/** Tag for any value that could possibly be a valid `FabricValue`. */
export type FabricValueTag =
  typeof FABRIC_VALUE_TAGS[keyof typeof FABRIC_VALUE_TAGS];

/**
 * Tags for all values that could possibly be either a valid `FabricValue` or
 * the designated `PlusType` of a `FabricValuePlus`.
 */
export const FABRIC_VALUE_PLUS_TAGS = Object.freeze(
  {
    ...FABRIC_VALUE_TAGS,
    PlusType: "PlusType",
  } as const,
);

/**
 * Tag for any value that could possibly be either a valid `FabricValue` or
 * the designated `PlusType` of a `FabricValuePlus`.
 */
export type FabricValuePlusTag =
  typeof FABRIC_VALUE_PLUS_TAGS[keyof typeof FABRIC_VALUE_PLUS_TAGS];

/**
 * Tags identifying the value types that this system recognizes for dispatch.
 * These are distinct from wire-format `TAGS`. Covers all the tags defined by
 * this submodule.
 */
export const VALUE_TAGS = Object.freeze(
  {
    ...FABRIC_CONVERTIBLE_JS_OBJECT_TAGS,
    ...FABRIC_VALUE_PLUS_TAGS,
    ...JS_TYPE_VALUE_TAGS,
  } as const,
);

/** One of the tag strings. */
export type ValueTag = typeof VALUE_TAGS[keyof typeof VALUE_TAGS];

/**
 * Tag for any value that could possibly be a valid `FabricConvertibleJsValue`:
 * every tag but `function` and `PlusType`.
 */
export type ConvertibleJsValueTag = Exclude<
  ValueTag,
  typeof VALUE_TAGS.function | typeof VALUE_TAGS.PlusType
>;
