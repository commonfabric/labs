import {
  emptySchemaObject,
  internSchema,
  schemaForValueType,
  schemaWithProperties,
} from "@commonfabric/data-model-schema";
import type { JSONSchema, JSONValue } from "./types.ts";
import { Runtime } from "../runtime.ts";
import { isCellLink, parseLink } from "../link-utils.ts";

/**
 * Creates a schema based on an `example` piece of data. The result is always an
 * interned schema. Note that interned schemas are necessarily frozen.
 *
 * **Note:** Though the intention is to treat `undefined` as an acceptable
 * value, this function doesn't in fact represent it as a proper schema.
 */
export function createJsonSchema(
  example: any,
  addDefaults: boolean = false,
  runtime?: Runtime,
): JSONSchema {
  const state = {
    addDefaults,
    runtime,
    seen: new Map<string, JSONSchema>(),
  };

  return analyzeType(example, state);
}

type AnalyzeTypeState = {
  addDefaults: boolean;
  runtime: Runtime | undefined;
  seen: Map<string, JSONSchema>;
};

/**
 * Helper for `createJsonSchema()` which analyzes a value, calling itself
 * recursively on subcomponents of the value (if any). The return value is
 * always an interned schema.
 */
function analyzeType(value: any, state: AnalyzeTypeState): JSONSchema {
  if (isCellLink(value)) {
    const seen = state.seen;
    const link = parseLink(value);
    const linkAsStr = JSON.stringify(link);

    const found = seen.get(linkAsStr);
    if (found !== undefined) {
      return found;
    }

    const cell = state.runtime?.getCellFromLink(link);
    if (!cell) {
      // Shouldn't happen: We have a cell link but its link doesn't correspond
      // to a cell.

      // Returning `true` (the JSON Schema "accept anything" literal) is now
      // type-legal here: `analyzeType()` returns `JSONSchema`, which is
      // `JSONSchemaObj | boolean`. The obstacle is no longer the type, it is
      // schema IDENTITY -- `analyzeType()` results are interned, so `{}` and
      // `true` are distinct interned schemas with distinct hashes. Swapping
      // them changes generated schemas that reach storage, which makes it a
      // migration rather than a cleanup.
      //
      // TODO(danfuzz): Decide whether this branch should `throw` instead. It is
      // reached only when a cell link resolves to no cell, which is a
      // "shouldn't happen" -- returning an accept-anything schema hides it.
      return emptySchemaObject();
    }

    let schema = cell.schema;
    if (schema === undefined) {
      // The `seen.set()` here provides a safe default which prevents the call
      // to `analyzeType()` (immediately below) from ending up recursing back
      // into this block (i.e., runaway recursion). Typically, `analyzeType()`
      // promptly overwrites the backstop.
      // TODO(seefeld): This should create `$ref: "#/.."`.
      seen.set(linkAsStr, emptySchemaObject());
      schema = analyzeType(cell.getRaw(), state);
    } else {
      // This needs to be interned for deduping during array analysis. (See
      // comments below.)
      schema = internSchema(schema);
    }
    seen.set(linkAsStr, schema);
    return schema;
  }

  // Adds the `default` when appropriate and does the necessary final result
  // processing. The result needs to be interned for deduping during array
  // analysis. (See comment below.)
  const finishResult = (schema: JSONSchema, addDefault = true): JSONSchema => {
    const result = (addDefault && state.addDefaults)
      ? schemaWithProperties(schema, { default: value })
      : schema;
    return internSchema(result);
  };

  const basicSchema = schemaForValueType(value);
  if (basicSchema === undefined) {
    // Unrecognized type. Treat it as "any." (`true` would say the same thing
    // and is type-legal; see the interning note above for why it is not a
    // drop-in swap.)
    return finishResult(emptySchemaObject());
  }

  switch (basicSchema.type) {
    case "array": {
      // The call here deduplicates the individual array element schemas using
      // object-identity-based uniquing. In order for it to work, all of the
      // schemas have to be interned. See comments above on the `internSchema()`
      // use sites that enable this.
      const items = itemsSchemaFromArray(value, state);
      const result = schemaWithProperties(basicSchema, { items });
      return finishResult(result);
    }

    case "object": {
      const entries: [string, JSONSchema][] = Object.entries(value).map(
        ([key, subValue]) => {
          return [key, analyzeType(subValue, state)];
        },
      );
      const properties = Object.fromEntries(entries);
      const result = schemaWithProperties(basicSchema, { properties });
      // `addDefault = false` because sub-properties will get defaults, if
      // any.
      return finishResult(result, false);
    }

    default: {
      return finishResult(basicSchema);
    }
  }
}

/**
 * Helper for `analyzeType()` which derives an `items` schema property from an
 * array value. The result is always an interned schema.
 */
function itemsSchemaFromArray(
  value: JSONValue[],
  state: AnalyzeTypeState,
): JSONSchema {
  // No need for any fanciness for empty or single-element arrays.
  switch (value.length) {
    case 0: {
      // An empty array constrains nothing, so `items` accepts anything. (`true`
      // would say the same thing and is type-legal; see the interning note above
      // for why it is not a drop-in swap.)
      return emptySchemaObject();
    }
    case 1: {
      return analyzeType(value[0], state);
    }
  }

  // This `Set` constructor call achieves schema uniquing, exactly because all
  // the `schemas` are guaranteed to be interned. That is if `schema1 !==
  // schema2` (not the same actual object), then we know that they also aren't
  // equivalent (same-content objects).
  const schemas = value.map((v) => analyzeType(v, state));
  const uniqueSchemas = [...new Set(schemas)];
  return (uniqueSchemas.length === 1)
    ? uniqueSchemas[0]
    : internSchema({ anyOf: uniqueSchemas });
}
