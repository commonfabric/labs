import { isObjectNotArray } from "@commonfabric/utils/types";

const OMIT_SCHEMA = Symbol("omit-schema");

// The keywords whose value is a schema, a list of schemas, or a map of names to
// schemas. Only these are walked. Every other keyword's value is data (a
// `const`, an `enum` entry, a `default`) and passes through as written, however
// much it looks like a schema. `anyOf`, `properties`, and `required` are
// handled on their own.
const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
]);

function normalizeSchemaList(schemas: readonly unknown[]): unknown[] {
  return schemas
    .map((item) => normalizeSchemaNode(item))
    .filter((item) => item !== OMIT_SCHEMA);
}

function normalizeKeywordValue(key: string, value: unknown): unknown {
  // Drafts before 2020-12 also give `items` a list of schemas.
  if (SCHEMA_LIST_KEYWORDS.has(key) || key === "items") {
    if (Array.isArray(value)) return normalizeSchemaList(value);
  }
  if (SCHEMA_KEYWORDS.has(key)) return normalizeSchemaNode(value);
  if (SCHEMA_MAP_KEYWORDS.has(key) && isObjectNotArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(value)) {
      const normalized = normalizeSchemaNode(schema);
      if (normalized !== OMIT_SCHEMA) out[name] = normalized;
    }
    return out;
  }
  return value;
}

function normalizeSchemaNode(schema: unknown): unknown {
  if (!isObjectNotArray(schema)) return schema;
  if (schema.type === "undefined") return OMIT_SCHEMA;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "type" || key === "anyOf" || key === "properties" ||
      key === "required"
    ) {
      continue;
    }
    const normalized = normalizeKeywordValue(key, value);
    if (normalized !== OMIT_SCHEMA) {
      out[key] = normalized;
    }
  }

  // The runtime adds two types JSON Schema does not have. `"undefined"` has no
  // JSON value. `"unknown"` marks a position the runtime reads as a reference
  // rather than descending into, so the model may put any JSON value there.
  // Both are left out; a concrete type beside them is what the reader asks
  // for, and it stays.
  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    const jsonTypes = typeValue.filter((item) =>
      item !== "undefined" && item !== "unknown"
    );
    if (jsonTypes.length === 1) {
      out.type = jsonTypes[0];
    } else if (jsonTypes.length > 1) {
      out.type = jsonTypes;
    }
  } else if (typeValue !== undefined && typeValue !== "unknown") {
    out.type = typeValue;
  }

  let droppedPropertyNames = new Set<string>();
  if (isObjectNotArray(schema.properties)) {
    const properties: Record<string, unknown> = {};
    droppedPropertyNames = new Set<string>();
    for (const [key, value] of Object.entries(schema.properties)) {
      const normalized = normalizeSchemaNode(value);
      if (normalized === OMIT_SCHEMA) {
        droppedPropertyNames.add(key);
        continue;
      }
      properties[key] = normalized;
    }
    out.properties = properties;
  }

  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((name) =>
      !droppedPropertyNames.has(String(name))
    );
    if (required.length > 0) {
      out.required = required;
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const anyOf = normalizeSchemaList(schema.anyOf);
    if (anyOf.length === 1 && isObjectNotArray(anyOf[0])) {
      return {
        ...anyOf[0],
        ...out,
      };
    }
    if (anyOf.length > 1) {
      out.anyOf = anyOf;
    }
  }

  return out;
}

export function normalizeSchemaForProvider(schema: unknown): unknown {
  const normalized = normalizeSchemaNode(schema);
  if (normalized === OMIT_SCHEMA) return {};
  // A top-level `false` schema rejects all values, which providers typically
  // can't represent in tool input shapes. Map to `{}` (empty schema) at the
  // outer surface only — recursive `false` values inside the schema (notably
  // `additionalProperties: false`) keep their JSON-Schema-spec semantics.
  if (normalized === false) return {};
  return normalized;
}
