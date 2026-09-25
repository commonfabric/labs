import { isObjectNotArray } from "@commonfabric/utils/types";

const OMIT_SCHEMA = Symbol("omit-schema");

function normalizeSchemaNode(schema: unknown): unknown {
  if (schema === true || schema === false) return schema;
  if (Array.isArray(schema)) {
    return schema
      .map((item) => normalizeSchemaNode(item))
      .filter((item) => item !== OMIT_SCHEMA);
  }
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
    const normalized = normalizeSchemaNode(value);
    if (normalized !== OMIT_SCHEMA) {
      out[key] = normalized;
    }
  }

  // The runtime's `"unknown"` type marks a position it reads as a reference
  // rather than descending into. The model may put any JSON value there, so a
  // type that includes it constrains nothing and is left out.
  const typeValue = schema.type;
  if (Array.isArray(typeValue)) {
    const filteredTypes = typeValue.filter((item) => item !== "undefined");
    if (!filteredTypes.includes("unknown")) {
      if (filteredTypes.length === 1) {
        out.type = filteredTypes[0];
      } else if (filteredTypes.length > 1) {
        out.type = filteredTypes;
      }
    }
  } else if (
    typeValue !== undefined && typeValue !== "undefined" &&
    typeValue !== "unknown"
  ) {
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
    const anyOf = schema.anyOf
      .map((branch) => normalizeSchemaNode(branch))
      .filter((branch) => branch !== OMIT_SCHEMA);
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
