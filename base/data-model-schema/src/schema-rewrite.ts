/** Rewriting a JSONSchema: adding and removing properties. */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import {
  type FabricValue,
  shallowMutableClone,
} from "@commonfabric/data-model";
import { internSchema, isInternedSchema } from "./schema-intern.ts";
import { toDeepFrozenSchema } from "./schema-copy.ts";

/**
 * Returns a deep-frozen shallow copy of a schema with the given property
 * overrides applied. This function provides "intern contagion:" If the given
 * `schema` is interned, then the result of this function will also be interned.
 *
 * - `undefined` and `true` ("accept everything") are treated as an interned
 *   `{}`.
 * - `false` ("reject everything"), whether in `schema` or `overrides`, results
 *   in a `false` result. That is, adding properties to a "never" schema still
 *   results in "never," and adding "never" to any schema makes it a "never."
 */
export function schemaWithProperties(
  schema: JSONSchema | undefined,
  overrides: JSONSchema,
): JSONSchema {
  schema ??= true;

  if (typeof schema === "boolean") {
    if (schema === false) {
      return false;
    } else if (typeof overrides === "boolean") {
      return overrides;
    } else {
      // Since `schema` is (definitionally) interned, "intern contagion"
      // applies, and the result is to be interned. We need to "manually" call
      // `toDeepFrozenSchema()` to ensure the value can become owned by the
      // intern cache (because an un-frozen argument needs to remain untouched).
      return internSchema(toDeepFrozenSchema(overrides));
    }
  }

  // `schema` is an object.

  if (typeof overrides === "boolean") {
    if (overrides === false) {
      return false;
    } else {
      // Note: This covers the "intern contagion" case, since
      // `toDeepFrozenSchema()` returns the given schema if already deep-frozen,
      // and interned schemas are definitionally deep-frozen.
      return toDeepFrozenSchema(schema);
    }
  }

  // Both `schema` and `overrides` are objects.

  // `shallowMutableClone()` gives a mutable top-level object whose bound
  // children are deep-frozen -- cloning any mutable ones rather than freezing
  // the `schema`/`overrides` inputs in place -- so the subsequent
  // `toDeepFrozenSchema(result, true)` only has to seal the (owned) top.
  const result = shallowMutableClone(
    { ...schema, ...overrides },
  ) as JSONSchemaObj;
  return isInternedSchema(schema)
    ? internSchema(result)
    : toDeepFrozenSchema(result, true);
}

/**
 * Returns a deep-frozen shallow copy of a schema with the named properties
 * removed. This function provides "intern contagion:" If the given
 * `schema` is interned, then the result of this function will also be interned.
 *
 * `undefined` is treated as `true` (JSON Schema "accept everything").
 * Boolean schemas are returned as-is (no properties to remove).
 */
export function schemaWithoutProperties(
  schema: JSONSchema | undefined,
  ...names: string[]
): JSONSchema {
  if (schema === undefined) return true;
  if (typeof schema === "boolean") return schema;

  let copy: Record<string, unknown> | null = null;

  for (const name of names) {
    if (copy) {
      delete copy[name];
    } else if (Object.hasOwn(schema, name)) {
      // First time we've found a `name` in need of deletion.
      copy = { ...schema };
      delete copy[name];
    }
  }

  if (copy) {
    // See `schemaWithProperties()`: deep-freeze the bound children (cloning any
    // mutable ones, leaving the `schema` input untouched) so the subsequent
    // `toDeepFrozenSchema` only has to seal the owned top.
    const result = shallowMutableClone(
      copy as FabricValue,
    ) as JSONSchemaObj;
    return isInternedSchema(schema)
      ? internSchema(result)
      : toDeepFrozenSchema(result, true);
  } else {
    // Note: We still have to deep-freeze in the `!copy` case, though it will be
    // a no-op if `schema` was already deep-frozen (including interned).
    return toDeepFrozenSchema(schema);
  }
}
