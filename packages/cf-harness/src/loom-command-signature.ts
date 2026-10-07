/**
 * A host command's argument schema read two ways: as the one-line signature
 * `list_commands` shows the model, and as the check `run_command` makes of a
 * call's args before anything is sent. Both read the same `inputSchema`, so
 * the signature a refused call is answered with is the one the listing
 * showed. Every function here is pure.
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
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
import {
  validateSchemaDefinition,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { LoomCommandEntry } from "./loom-commands.ts";

/** Longest signature line, past which trailing parameters read `…`. */
export const LOOM_COMMAND_SIGNATURE_MAX_LENGTH = 400;

/** Longest rendering of a default, an enum member, or a given value. */
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

/** Helper for stripping, which strips each subschema in a list. */
const stripEach = (value: JSONValue): JSONValue =>
  Array.isArray(value) ? value.map(stripSubschema) : value;

/** Helper for stripping, which strips each subschema a record names. */
const stripValues = (value: JSONValue): JSONValue =>
  isObjectNotArray(value)
    ? Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, stripSubschema(child)]),
    )
    : value;

/** Helper for stripping, which strips a value in a subschema position. */
const stripSubschema = (value: JSONValue): JSONValue =>
  isObjectNotArray(value) ? withoutSchemaExtensions(value) : value;

/**
 * `schema` without its `x-*` extension keywords, at every subschema position.
 * A property *named* `x-…` is a parameter, not an extension, and is kept, as
 * is everything under `enum`, `const`, `default`, and `examples`, which are
 * values rather than schemas.
 */
export const withoutSchemaExtensions = (schema: JSONObject): JSONObject =>
  Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !key.startsWith("x-"))
      .map(([key, value]) => [
        key,
        SINGLE_SUBSCHEMA_KEYWORDS.has(key)
          ? stripSubschema(value)
          : LIST_SUBSCHEMA_KEYWORDS.has(key)
          ? stripEach(value)
          : RECORD_SUBSCHEMA_KEYWORDS.has(key)
          ? stripValues(value)
          : value,
      ]),
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
 * group in the schema's order. `["..."]` for a schema that names none and
 * leaves its arguments open; `[]` for one that names none and closes them.
 */
export const parametersOf = (schema: JSONObject | true): string[] => {
  if (schema === true) return ["..."];
  const properties = isObjectNotArray(schema.properties)
    ? schema.properties
    : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name === "string")
      : [],
  );
  const names = [
    ...new Set([...Object.keys(properties), ...required]),
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
    "name" | "inputSchema" | "outputs" | "effect" | "target"
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
  for (const parameter of parametersOf(entry.inputSchema)) {
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

/** What is wrong with a call's args, as `invalid_args` reports it. */
export interface CommandArgsProblem {
  /** Where in the args: `args`, `args.limit`, `args.tags[0]`. */
  path: string;

  /** What that position accepts, as the signature writes types. */
  expected: string;

  /** What the call passed there, as JSON cut short, or `absent`. */
  given: string;

  /** The validator's own account of the mismatch. */
  problem: string;
}

/** Helper for checking, which steps one key into a schema position. */
const childSchemaOf = (
  schema: JSONValue | undefined,
  key: string,
  index: number | undefined,
): JSONValue | undefined => {
  if (!isObjectNotArray(schema)) return undefined;
  if (index !== undefined) {
    return Array.isArray(schema.prefixItems) &&
        index < schema.prefixItems.length
      ? schema.prefixItems[index]
      : schema.items;
  }
  return isObjectNotArray(schema.properties) &&
      Object.hasOwn(schema.properties, key)
    ? schema.properties[key]
    : schema.additionalProperties;
};

/** Helper for checking, which shows where a path reaches. */
const pathText = (path: readonly (string | number)[]): string =>
  path.reduce<string>(
    (text, key) =>
      typeof key === "number"
        ? `${text}[${key}]`
        : /^[A-Za-z_$][\w$-]*$/.test(key)
        ? `${text}.${key}`
        : `${text}[${JSON.stringify(key)}]`,
    "args",
  );

/** Helper for checking, which shows what a call passed at a position. */
const givenOf = (value: JSONValue | undefined): string =>
  value === undefined ? "absent" : literalOf(value);

/** Helper for checking, which steps one key into the args, where it leads. */
const stepInto = (
  value: JSONValue | undefined,
  part: string,
): { value: JSONValue; index?: number } | undefined => {
  if (Array.isArray(value)) {
    const index = /^\d+$/.test(part) ? Number(part) : value.length;
    return index < value.length ? { value: value[index], index } : undefined;
  }
  return isObjectNotArray(value) && Object.hasOwn(value, part)
    ? { value: value[part] }
    : undefined;
};

/**
 * Reads a validator failure back to the position it names. The validator
 * writes a failure as the keys it descended through, each followed by `: `,
 * then what it found there; this walks the args along those keys for as long
 * as they name what the args hold, so a key that itself contains `: ` ends
 * the walk early rather than misplacing it.
 */
const problemAt = (
  schema: JSONObject,
  args: JSONObject,
  failure: string,
): CommandArgsProblem => {
  const parts = failure.split(": ");
  const path: (string | number)[] = [];
  let value: JSONValue | undefined = args;
  let position: JSONValue | undefined = schema;
  let consumed = 0;
  for (const part of parts.slice(0, -1)) {
    const step = stepInto(value, part);
    if (step === undefined) break;
    position = childSchemaOf(position, part, step.index);
    value = step.value;
    path.push(step.index ?? part);
    consumed += 1;
  }
  const problem = parts.slice(consumed).join(": ");
  const missing = /^missing required property (.+)$/.exec(problem);
  if (missing !== null && isObjectNotArray(value)) {
    const name = missing[1];
    return {
      path: pathText([...path, name]),
      expected: typeOfSchema(childSchemaOf(position, name, undefined)),
      given: "absent",
      problem,
    };
  }
  const extra = /^additional property (.+)$/.exec(problem);
  if (extra !== null && isObjectNotArray(value)) {
    const name = extra[1];
    return {
      path: pathText([...path, name]),
      expected: "no such parameter",
      given: givenOf(value[name]),
      problem,
    };
  }
  return {
    path: pathText(path),
    expected: position === undefined ? problem : typeOfSchema(position),
    given: givenOf(value),
    problem,
  };
};

/**
 * What is wrong with `args` under a command's argument schema, or
 * `undefined` when nothing is. A schema this validator cannot itself read —
 * a format or keyword it does not support — yields `undefined` for every
 * call: the host's command layer validates every call it is sent, so a
 * schema only it can judge is left to it rather than refusing calls it
 * would run.
 */
export const findCommandArgsProblem = (
  schema: JSONObject | true,
  args: JSONObject,
): CommandArgsProblem | undefined => {
  if (schema === true || !isSubschema(schema)) return undefined;
  if (validateSchemaDefinition(schema) !== undefined) return undefined;
  const failure = validateSchemaValue(schema, args);
  return failure === undefined ? undefined : problemAt(schema, args, failure);
};
