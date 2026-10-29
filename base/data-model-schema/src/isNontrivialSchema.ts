import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Indicates if the given (nullable) schema is in fact a non-trivial schema. A
 * non-trivial schema is defined as one that is an `object` with at least one
 * property. If it returns `true`, type-narrowing ensures that the schema
 * _object_ can be treated as such.
 *
 * **Note:** Because of TS narrowing rules, when this function returns `false`
 * given `{}` (empty object), TS will mistakenly treat this as type `boolean |
 * undefined | null`. This is technically wrong but, given the meaning of this
 * method, effectively safe in that the point of this method is enabling easy
 * object use in the `true` cases and pretty much saying "don't mess with the
 * value" in `false` cases.
 */
export function isNontrivialSchema(
  schema: JSONSchema | undefined | null,
): schema is JSONSchemaObj {
  if (!isObjectOrArray(schema)) {
    return false;
  }

  return Object.keys(schema).length !== 0;
}
