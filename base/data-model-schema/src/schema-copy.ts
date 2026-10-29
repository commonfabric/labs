/** Copying a JSONSchema, deep-frozen or mutable. */

import type { JSONSchema, MutableJSONSchemaObj } from "@commonfabric/api";

import { cloneIfNecessary, deepFreeze } from "@commonfabric/data-model";

/**
 * Returns a deep-frozen copy of (or reference to) a JSONSchema, returning
 * primitives as-is.
 *
 * - When `canShare` is `true`, the input `schema` is allowed to be modified,
 *   including freezing it in place and returning it directly. Use this when the
 *   caller owns the object referred to by `schema` and no other code will
 *   attempt to mutate it.
 *
 * - When `canShare` is `false`, the `schema` is cloned first if not already
 *   deep-frozen, so that the original is not modified.
 *
 * As with other schema functions, this one accepts `undefined` for use when
 * it's possible for a schema value to be missing or optional.
 *
 * Note: Use `internSchema()` in preference to this function, which can cost a
 * little more to run but which will save both time and memory when the schema
 * in question is reused.
 */
export function toDeepFrozenSchema<T extends JSONSchema | undefined>(
  schema: T,
  canShare: boolean = false,
): T {
  if (canShare) {
    // The caller indicated that we get to freeze the result, so just do that.
    // `deepFreeze()` returns a `boolean` or `undefined` schema untouched, and
    // recognizes an already-deep-frozen object -- an interned schema, notably
    // -- without walking it.
    return deepFreeze(schema);
  }

  // The caller indicated that the original `schema` has to be left alone. A
  // `boolean` or `undefined` schema has nothing to leave alone.
  if (typeof schema !== "object") {
    return schema;
  }

  // `cloneIfNecessary()` identity-passes an already-deep-frozen value, so this
  // allocates only when `schema` is in fact mutable.
  return cloneIfNecessary(schema as Exclude<T, boolean | undefined>) as T;
}

/**
 * Returns a mutable object copy of a JSONSchema. Boolean schemas (`true` and
 * `false`) and `undefined` are converted to their object-form equivalents:
 * `undefined` and `true` become `{}` (accept any value), `false` becomes
 * `{ not: true }` (reject all values).
 *
 * @param deep When `true`, nested objects are recursively cloned (deep copy).
 *   Defaults to `false` (shallow copy). Pass `true` when the caller intends to
 *   mutate nested properties.
 */
export function cloneSchemaMutable(
  schema: JSONSchema | undefined,
  deep: boolean = false,
): MutableJSONSchemaObj {
  if (schema === undefined) return {};
  if (typeof schema === "boolean") return schema ? {} : { not: true };
  return cloneIfNecessary(schema, {
    frozen: false,
    deep,
  }) as MutableJSONSchemaObj;
}
