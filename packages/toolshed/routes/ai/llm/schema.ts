import {
  ARRAY_SUBSCHEMA_KEYS,
  DEFS_KEYS,
  RECORD_SUBSCHEMA_KEYS,
  SINGLE_SUBSCHEMA_KEYS,
  UNUSED_RECORD_SUBSCHEMA_KEYS,
  UNUSED_SINGLE_SUBSCHEMA_KEYS,
} from "@commonfabric/data-model-schema/schema-walk";
import { isObjectNotArray } from "@commonfabric/utils/types";

const OMIT_SCHEMA = Symbol("omit-schema");

// The keywords whose value is a schema, a list of schemas, or a map of names to
// schemas: every keyword in the central registry, emitted or not, and the
// spellings before 2019 that a provider's validator still reads. Only these are
// walked. Every other keyword's value is data (a `const`, an `enum` entry, a
// `default`) and passes through as written, however much it looks like a
// schema. `anyOf`, `properties`, and `required` are handled on their own.
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  ...SINGLE_SUBSCHEMA_KEYS,
  ...UNUSED_SINGLE_SUBSCHEMA_KEYS,
  "additionalItems",
]);
const SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set(
  ARRAY_SUBSCHEMA_KEYS,
);
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  ...RECORD_SUBSCHEMA_KEYS,
  ...UNUSED_RECORD_SUBSCHEMA_KEYS,
  ...DEFS_KEYS,
  "definitions",
  "dependencies",
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
  // JSON value, so it is left out of a type array. `"unknown"` marks a position
  // the runtime reads as a reference rather than descending into, and it
  // admits every value, so a type that includes it constrains nothing and is
  // left out whole: the route validates the model's answer against this
  // schema, and a concrete type kept beside `unknown` would refuse an answer
  // the runtime accepts.
  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    if (!typeValue.includes("unknown")) {
      const jsonTypes = typeValue.filter((item) => item !== "undefined");
      if (jsonTypes.length === 1) {
        out.type = jsonTypes[0];
      } else if (jsonTypes.length > 1) {
        out.type = jsonTypes;
      }
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
