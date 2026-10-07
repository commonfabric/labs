/**
 * A host command's argument schema read as the one-line signature
 * `list_commands` shows the model, and as the line a call the host refused
 * for its args is answered with. Every function here is pure.
 *
 * A signature reads like a typed call:
 *
 *     people-discovery.dossier(entity_id: string, limit?: integer = 50)
 *       -> {messages, records}  [read, global]
 *
 * on one line. Required parameters come first and carry no `?`; a default
 * follows `=`; an enum reads `a|b|c`, an array `T[]`, an object with declared
 * properties `{...}` and one without `object`. `(...)` is a schema that
 * leaves its arguments open.
 */

import type { JSONObject, JSONValue } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { LoomCommandEntry } from "./loom-commands.ts";

/** Longest signature line, past which trailing parameters read `…`. */
export const LOOM_COMMAND_SIGNATURE_MAX_LENGTH = 400;

/** Longest rendering of a default or an enum member. */
const LITERAL_MAX_LENGTH = 40;

/** Keywords whose value is one subschema. */
const SINGLE_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);

/** Keywords whose value is a list of subschemas. */
const LIST_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

/** Keywords whose value maps names to subschemas. */
const RECORD_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Helper for schema rewrites, which rebuilds every schema node of `schema`,
 * children first, through `rebuild`. Only subschema positions are walked:
 * values under `enum`, `const`, `default`, and `examples`, and the names in
 * `properties`, are left as they are.
 */
const mapSchemaNodes = (
  schema: JSONObject,
  rebuild: (node: JSONObject) => JSONObject,
): JSONObject => {
  const node = (value: JSONValue): JSONValue =>
    isObjectNotArray(value) ? mapSchemaNodes(value, rebuild) : value;
  return rebuild(Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      SINGLE_SUBSCHEMA_KEYWORDS.has(key)
        ? node(value)
        : LIST_SUBSCHEMA_KEYWORDS.has(key) && Array.isArray(value)
        ? value.map(node)
        : RECORD_SUBSCHEMA_KEYWORDS.has(key) && isObjectNotArray(value)
        ? Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, node(child)]),
        )
        : value,
    ]),
  ));
};

/**
 * `schema` without its `x-*` extension keywords, at every subschema position.
 * A property *named* `x-…` is a parameter, not an extension, and is kept, as
 * is everything under `enum`, `const`, `default`, and `examples`, which are
 * values rather than schemas.
 */
export const withoutSchemaExtensions = (schema: JSONObject): JSONObject =>
  mapSchemaNodes(
    schema,
    (node) =>
      Object.fromEntries(
        Object.entries(node).filter(([key]) => !key.startsWith("x-")),
      ),
  );

/** Helper for rendering, which cuts a rendering to `max` characters. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Helper for rendering, which shows a value: JSON, cut to a literal's length. */
const literalOf = (value: JSONValue): string =>
  cut(JSON.stringify(value), LITERAL_MAX_LENGTH);

/** Helper for rendering, which shows an enum member: strings unquoted. */
const memberOf = (value: JSONValue): string =>
  typeof value === "string" ? cut(value, LITERAL_MAX_LENGTH) : literalOf(value);

/** Helper for rendering, which joins alternatives, each shown once. */
const alternatives = (types: readonly string[]): string =>
  [...new Set(types)].join("|");

/** Helper for rendering, which reads an array's element type. */
const arrayTypeOf = (schema: JSONObject): string => {
  const element = typeOfSchema(schema.items);
  return `${element.includes("|") ? `(${element})` : element}[]`;
};

/** Helper for rendering, which reads an object as `{...}` or `object`. */
const objectTypeOf = (schema: JSONObject): string =>
  isObjectNotArray(schema.properties) &&
    Object.keys(schema.properties).length > 0
    ? "{...}"
    : "object";

/** Helper for rendering, which reads one `type` keyword's name. */
const namedTypeOf = (schema: JSONObject, name: JSONValue): string =>
  name === "array"
    ? arrayTypeOf(schema)
    : name === "object"
    ? objectTypeOf(schema)
    : typeof name === "string"
    ? name
    : "any";

/**
 * The type a schema position accepts, as a signature shows it: `any` for an
 * open position or one whose schema says nothing this reads, `never` for a
 * closed one.
 */
export const typeOfSchema = (schema: JSONValue | undefined): string => {
  if (schema === false) return "never";
  if (!isObjectNotArray(schema)) return "any";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return alternatives(schema.enum.map(memberOf));
  }
  if (schema.const !== undefined) return memberOf(schema.const);
  const union = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
    ? schema.oneOf
    : undefined;
  if (union !== undefined && union.length > 0) {
    return alternatives(union.map(typeOfSchema));
  }
  if (typeof schema.$ref === "string") {
    return schema.$ref.split("/").at(-1) || "any";
  }
  if (Array.isArray(schema.type) && schema.type.length > 0) {
    return alternatives(schema.type.map((name) => namedTypeOf(schema, name)));
  }
  if (schema.type !== undefined) return namedTypeOf(schema, schema.type);
  if (isObjectNotArray(schema.properties)) return objectTypeOf(schema);
  if (schema.items !== undefined) return arrayTypeOf(schema);
  return "any";
};

/** One parameter of a signature, as it reads there. */
const parameterOf = (
  name: string,
  schema: JSONValue | undefined,
  required: boolean,
): string => {
  const fallback = isObjectNotArray(schema) && schema.default !== undefined
    ? ` = ${literalOf(schema.default)}`
    : "";
  return `${name}${required ? "" : "?"}: ${typeOfSchema(schema)}${fallback}`;
};

/**
 * The parameters an argument schema declares, required ones first and each
 * group in the schema's order. A required input named in `hostFilled`, one
 * the host fills from a call's context, reads as optional, since a call may
 * leave it out. `["..."]` for a schema that names none and leaves its
 * arguments open; `[]` for one that names none and closes them.
 */
export const parametersOf = (
  schema: JSONObject | true,
  hostFilled: readonly string[] = [],
): string[] => {
  if (schema === true) return ["..."];
  const properties = isObjectNotArray(schema.properties)
    ? schema.properties
    : {};
  const declared = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === "string")
    : [];
  const required = new Set(
    declared.filter((name) => !hostFilled.includes(name)),
  );
  const names = [
    ...new Set([...Object.keys(properties), ...declared]),
  ];
  if (names.length === 0) {
    return schema.additionalProperties === false ? [] : ["..."];
  }
  return [
    ...names.filter((name) => required.has(name)),
    ...names.filter((name) => !required.has(name)),
  ].map((name) => parameterOf(name, properties[name], required.has(name)));
};

/**
 * The one-line signature `list_commands` shows for a command: its name and
 * parameters, the field names its answer declares, then its declared effect
 * (left out where the host declares none) and its target. A line longer than
 * {@link LOOM_COMMAND_SIGNATURE_MAX_LENGTH} keeps the parameters that fit and
 * ends the list with `…`.
 */
export const renderCommandSignature = (
  entry: Pick<
    LoomCommandEntry,
    "name" | "inputSchema" | "outputs" | "effect" | "target" | "hostFilled"
  >,
): string => {
  const returns = entry.outputs !== undefined && entry.outputs.length > 0
    ? ` -> {${entry.outputs.join(", ")}}`
    : "";
  const tags = [
    ...(entry.effect !== undefined ? [entry.effect] : []),
    entry.target,
  ];
  const tail = `)${returns}  [${tags.join(", ")}]`;
  // Room is kept for the `, …` that marks the parameters left out.
  const room = LOOM_COMMAND_SIGNATURE_MAX_LENGTH - entry.name.length - 1 -
    tail.length - 3;
  const shown: string[] = [];
  let used = 0;
  for (const parameter of parametersOf(entry.inputSchema, entry.hostFilled)) {
    const width = parameter.length + (shown.length > 0 ? 2 : 0);
    if (used + width > room) {
      shown.push("…");
      break;
    }
    shown.push(parameter);
    used += width;
  }
  // A tail too long for the line on its own, from many long output names,
  // is cut with the rest.
  return cut(
    `${entry.name}(${shown.join(", ")}${tail}`,
    LOOM_COMMAND_SIGNATURE_MAX_LENGTH,
  );
};
