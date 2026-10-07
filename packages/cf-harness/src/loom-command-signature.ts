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

/** What is wrong with a call's args, as `invalid_args` reports it. */
export interface CommandArgsProblem {
  /** Where in the args: `args`, `args.limit`, `args.tags[0]`. */
  path: string;

  /** What that position accepts, as the signature writes types. */
  expected: string;

  /** What the call passed there, as JSON cut short, or `absent`. */
  given: string;

  /** A short account of the mismatch. */
  problem: string;
}

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

/**
 * Whether `value` is of the host's named type, or `undefined` for a name the
 * host does not check. Python's `isinstance` is the reference: a boolean is
 * a `number` there but not an `integer`.
 */
const hostTypeAccepts = (
  name: unknown,
  value: JSONValue,
): boolean | undefined => {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" || typeof value === "boolean";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObjectNotArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return undefined;
  }
};

/**
 * Helper for checking, which compares values as Python's `==` does: a number
 * and a boolean by value (`1 == True`), lists element by element, and dicts
 * by their keys in any order, at every depth.
 */
const hostEquals = (left: JSONValue, right: JSONValue): boolean => {
  if (
    (typeof left === "number" || typeof left === "boolean") &&
    (typeof right === "number" || typeof right === "boolean")
  ) {
    return Number(left) === Number(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((element, index) => hostEquals(element, right[index]));
  }
  if (isObjectNotArray(left) && isObjectNotArray(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key) =>
        Object.hasOwn(right, key) && hostEquals(left[key], right[key])
      );
  }
  return left === right;
};

/** The type names the host checks an array's elements by. */
const HOST_ITEM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "object",
]);

/** Helper for checking, which reads an input's value against its schema. */
const valueProblem = (
  property: JSONObject,
  value: JSONValue,
  path: readonly (string | number)[],
): CommandArgsProblem | undefined => {
  const mismatch = (
    at: readonly (string | number)[],
    schema: JSONValue | undefined,
    given: JSONValue,
    problem: string,
  ): CommandArgsProblem => ({
    path: pathText(at),
    expected: typeOfSchema(schema),
    given: givenOf(given),
    problem,
  });
  if (property.type === undefined && Array.isArray(property.oneOf)) {
    const accepted = property.oneOf.some((branch) =>
      isObjectNotArray(branch) && hostTypeAccepts(branch.type, value) === true
    );
    return accepted
      ? undefined
      : mismatch(path, property, value, "value matches no oneOf branch");
  }
  const type = property.type || "string";
  if (hostTypeAccepts(type, value) === false) {
    return mismatch(path, property, value, `value is not ${String(type)}`);
  }
  const { items } = property;
  if (
    type === "array" && Array.isArray(value) && isObjectNotArray(items) &&
    (items.type !== undefined || items.enum !== undefined)
  ) {
    // The host checks neither the type nor the enum of elements whose type
    // it does not know, or that are arrays themselves.
    const itemType = items.type || "string";
    const checked = typeof itemType === "string" &&
      HOST_ITEM_TYPES.has(itemType);
    for (const [index, element] of checked ? value.entries() : []) {
      if (hostTypeAccepts(itemType, element) === false) {
        return mismatch(
          [...path, index],
          items,
          element,
          `value is not ${String(itemType)}`,
        );
      }
      if (
        Array.isArray(items.enum) &&
        !items.enum.some((member) => hostEquals(member, element))
      ) {
        return mismatch(
          [...path, index],
          items,
          element,
          "value is not in enum",
        );
      }
    }
  }
  if (
    Array.isArray(property.enum) &&
    !property.enum.some((member) => hostEquals(member, value))
  ) {
    return mismatch(path, property, value, "value is not in enum");
  }
  return undefined;
};

/**
 * What is wrong with `args` under a command's argument schema, or
 * `undefined` when nothing is. The check refuses only what the host's
 * command layer refuses, so no call it would run is refused here. The
 * host's rules (`validate_inputs` in Loom's `src/lib/loom_commands.py`):
 *
 * - an input the schema's `properties` does not declare is refused; here
 *   only where the schema closes them (`additionalProperties: false`);
 * - an input passed as `null` is read as left out;
 * - an input without `type` whose `oneOf` is a list must have the type of
 *   one of its branches;
 * - any other input must have its `type`, read as `string` when absent:
 *   `string`, `integer` (a boolean is not one), `number` (a boolean is
 *   one), `boolean`, `object`, or `array`; any other type name, a list of
 *   names included, is not checked;
 * - an `array` input's elements are checked against an `items` that names
 *   a `type` (read as `string` when absent) or an `enum`, by that type and
 *   that enum;
 * - an input with an `enum` must equal one of its members;
 * - a default is given to every input left out, before the host looks for
 *   required inputs left out, which it then fills from the call's context
 *   or asks for.
 *
 * Nothing else is checked: not a nested object's properties, nor
 * `minimum`, `maxLength`, `pattern`, `format`, `$ref`, `anyOf`, or
 * `allOf`. The one place this check refuses more than the host is a
 * required input left out with no default: the host would ask for it,
 * which leaves an agent stuck, so it is refused here with the signature,
 * unless it is named in `hostFilled`, one the host fills from context.
 */
export const findCommandArgsProblem = (
  schema: JSONObject | true,
  args: JSONObject,
  hostFilled: readonly string[] = [],
): CommandArgsProblem | undefined => {
  if (schema === true) return undefined;
  const properties = isObjectNotArray(schema.properties)
    ? schema.properties
    : {};
  for (const [name, value] of Object.entries(args)) {
    if (Object.hasOwn(properties, name)) {
      const property = properties[name];
      if (value === null || !isObjectNotArray(property)) continue;
      const problem = valueProblem(property, value, [name]);
      if (problem !== undefined) return problem;
    } else if (schema.additionalProperties === false) {
      return {
        path: pathText([name]),
        expected: "no such parameter",
        given: givenOf(value),
        problem: `unknown input ${name}`,
      };
    }
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (typeof name !== "string" || hostFilled.includes(name)) continue;
    const property = properties[name];
    const given = args[name];
    if (
      (given === undefined || given === null) &&
      !(isObjectNotArray(property) && property.default !== undefined)
    ) {
      return {
        path: pathText([name]),
        expected: typeOfSchema(property),
        given: "absent",
        problem: `missing required input ${name}`,
      };
    }
  }
  return undefined;
};
