/**
 * Schema formatting utilities for LLM consumption.
 *
 * Provides TypeScript-like string representations of JSON schemas that are
 * more compact and readable than raw JSON Schema, making them ideal for
 * including in LLM context/prompts.
 */

import { AsCellType } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { JSONSchema } from "commonfabric";

import { ContextualFlowControl } from "./cfc.ts";

export interface SchemaFormatOptions {
  /** Definitions map for resolving $ref references */
  defs?: Record<string, JSONSchema>;

  /** Current recursion depth (internal use) */
  depth?: number;

  /** Maximum recursion depth before abbreviating (default: 4) */
  maxDepth?: number;

  /** Current indentation level (internal use) */
  indent?: number;
}

/**
 * Converts a JSON Schema to a TypeScript-like string representation.
 *
 * Much more compact and readable than JSON Schema, naturally expresses
 * wrapper types like Stream and Cell using familiar TypeScript syntax.
 *
 * @example
 * // Basic types
 * schemaToTypeString({ type: "string" }) // → "string"
 * schemaToTypeString({ type: "number" }) // → "number"
 *
 * @example
 * // Objects
 * schemaToTypeString({
 *   type: "object",
 *   properties: { name: { type: "string" } }
 * })
 * // → "{ name?: string }"
 *
 * @example
 * // Stream handlers (asCell: ["stream"])
 * schemaToTypeString({
 *   asCell: ["stream"],
 *   properties: { value: { type: "string" } }
 * })
 * // → "({ value?: string }) => void"
 *
 * @example
 * // Cell wrappers (asCell: ["cell"])
 * schemaToTypeString({
 *   asCell: ["cell"],
 *   properties: { count: { type: "number" } }
 * })
 * // → "Cell<{ count?: number }>"
 *
 * @example
 * // Arrays
 * schemaToTypeString({ type: "array", items: { type: "string" } })
 * // → "string[]"
 *
 * @example
 * // Tuples (prefixItems)
 * schemaToTypeString({
 *   type: "array",
 *   prefixItems: [{ type: "string" }, { type: "number" }]
 * })
 * // → "[string, number, ...unknown[]]" (an absent `items` leaves the tail
 * // open; only `items: false` closes the tuple)
 *
 * @example
 * // An `items` schema alongside `prefixItems` becomes a rest element
 * schemaToTypeString({
 *   type: "array",
 *   prefixItems: [{ type: "string" }],
 *   items: { type: "number" }
 * })
 * // → "[string, ...number[]]"
 *
 * @example
 * // Enums as union literals
 * schemaToTypeString({ enum: ["open", "closed"] })
 * // → '"open" | "closed"'
 *
 * @example
 * // const literals and type arrays
 * schemaToTypeString({ type: "string", const: "x" }) // → '"x"'
 * schemaToTypeString({ type: ["string", "null"] })   // → "string | null"
 *
 * @example
 * // A conjunction contributes its members' fields to one object. A
 * // disjunction stays a union: `anyOf` is a choice between shapes, while
 * // `allOf` states shapes that hold at once.
 * schemaToTypeString({
 *   type: "object",
 *   properties: { note: { type: "string" } },
 *   allOf: [{ properties: { count: { type: "number" } } }]
 * })
 * // → "{\n  note?: string,\n  count?: number\n}"
 *
 * @example
 * // Index signatures (object-valued additionalProperties)
 * schemaToTypeString({
 *   type: "object",
 *   additionalProperties: { type: "number" }
 * })
 * // → "Record<string, number>"
 *
 * @example
 * // PatternToolResult schemas (from patternTool())
 * schemaToTypeString({
 *   type: "object",
 *   properties: {
 *     pattern: { type: "object" },
 *     extraParams: { properties: { content: { type: "string" } } }
 *   }
 * })
 * // → "(e: { content?: string }) => void"
 *
 * @example
 * // With $defs resolution
 * schemaToTypeString(
 *   { $ref: "#/$defs/User" },
 *   { defs: { User: { type: "string" } } }
 * )
 * // → "string" (inlined because small)
 */
export function schemaToTypeString(
  schema: JSONSchema,
  options: SchemaFormatOptions = {},
): string {
  const rendered = schemaToTypeStringInner(schema, options);
  return applyScopeWrapper(
    (schema as Record<string, unknown>)?.scope,
    rendered,
  );
}

/** How deep nested `allOf` is followed before a conjunction is left alone. */
const MAX_CONJUNCTION_DEPTH = 8;

/**
 * The schemas a conjunction contributes fields from: the schema itself, then
 * each `allOf` member, depth-first through nested conjunctions, with a
 * `$defs` reference resolved to what it names.
 *
 * Order is what the caller merges by, so it matters: the schema's own
 * properties come first and win, then earlier members beat later ones. That is
 * the order `declaredEventFields` in the CLI reads a conjunction in, and
 * matching it is what keeps a help page's type block and its flag list
 * agreeing about the same schema.
 *
 * A disjunction is not walked. `anyOf` is a union and renders as one; only a
 * conjunction states fields that all hold at once.
 */
function conjunctionSources(
  schema: Record<string, unknown>,
  defs: Record<string, JSONSchema>,
): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  // Keyed by the reference rather than by the object it resolves to: the same
  // `$defs` entry reached twice is the cycle worth stopping, and a schema
  // object's identity is not stable enough to key a guard on.
  const followed = new Set<string>();
  const visit = (entry: unknown, depth: number): void => {
    if (depth > MAX_CONJUNCTION_DEPTH) return;
    if (!isObjectOrArray(entry)) return;
    let current = entry as Record<string, unknown>;
    // A chain, not a hop: a definition is allowed to be an alias for another,
    // and stopping after one would collect the alias — which states no field —
    // instead of what it names. The guard below is what ends a chain that
    // loops back on itself.
    while (typeof current.$ref === "string") {
      const ref = current.$ref;
      const match = ref.match(/^#\/\$defs\/(.+)$/);
      if (!match || followed.has(ref)) return;
      followed.add(ref);
      const def = defs[match[1]];
      if (!def || typeof def !== "object") return;
      current = def as Record<string, unknown>;
    }
    sources.push(current);
    if (Array.isArray(current.allOf)) {
      for (const member of current.allOf) visit(member, depth + 1);
    }
  };
  visit(schema, 0);
  return sources;
}

function schemaToTypeStringInner(
  schema: JSONSchema,
  options: SchemaFormatOptions = {},
): string {
  const { defs = {}, depth = 0, maxDepth = 4, indent = 0 } = options;
  const nextOpts = { defs, depth: depth + 1, maxDepth, indent };

  if (!isObjectOrArray(schema)) {
    return "unknown";
  }

  const s = schema as Record<string, unknown>;

  // A sqlite-branded position renders as the handle type a pattern author
  // writes at it. What the schema there states is the handle's readable
  // descriptor `{ id, tables, rev }`, hoisted into `$defs` under the brand's
  // own name, so both the shape and that name describe something no pattern
  // declares. Decided before the `$ref` hop below, which would resolve the
  // descriptor and never see the brand beside it.
  const sqliteBrand = ContextualFlowControl.getAsCellValues(schema).find(
    (entry) => ContextualFlowControl.getAsCellKind(entry) === "sqlite",
  );
  if (sqliteBrand !== undefined) {
    return applyScopeWrapper(
      ContextualFlowControl.getAsCellScope(sqliteBrand),
      "SqliteDb",
    );
  }

  // Handle $ref - resolve from definitions
  if (schema.$ref && typeof schema.$ref === "string") {
    const refPath = s.$ref as string;
    const match = refPath.match(/^#\/\$defs\/(.+)$/);
    if (match) {
      const defName = match[1];
      const def = defs[defName];
      if (def) {
        // Ref hops recurse BEFORE the depth cap below, so a ref cycle
        // (e.g. `$defs: {A: {$ref: "#/$defs/A"}}`) must bail here — at the
        // cap, fall back to the type name instead of inlining (PR #4969
        // review: `--help` overflowed the stack on recursive $defs).
        if (depth >= maxDepth) return defName;
        // For small definitions, inline them; otherwise use the type name
        const defStr = schemaToTypeString(def, { ...nextOpts, indent: 0 });
        if (defStr.length < 50) {
          return defStr;
        }
        return defName;
      }
      return defName; // Reference to unknown def - just use the name
    }
    return "unknown"; // Can't resolve ref
  }

  // Normalize asCell array for easier handling
  const asCellValues = ContextualFlowControl.getAsCellValues(schema);

  // At max depth, return simplified representation
  if (depth >= maxDepth) {
    if (asCellValues.length > 0) {
      let innerType = "...";
      for (let i = asCellValues.length - 1; i >= 0; i--) {
        innerType = getWrappedTypeString(asCellValues[i], innerType);
      }
      return innerType;
    } else {
      if (schema.type === "object") return "{...}";
      if (schema.type === "array") return "[...]";
      if (Array.isArray(schema.type)) return typeArrayToUnion(schema.type);
      return String(schema.type || "unknown");
    }
  }

  // Normalize asCell/asStream into a single asCellValue array for easier handling
  if (asCellValues.length > 0) {
    const { asCell: _c, scope: _scope, ...restSchema } = schema;
    // Wrapper arrays are ordered outermost-first, so apply them from the end.
    let innerType = schemaToTypeString(restSchema, nextOpts);
    for (let i = asCellValues.length - 1; i >= 0; i--) {
      innerType = getWrappedTypeString(asCellValues[i], innerType);
    }
    return innerType;
  }

  // Handle PatternToolResult - objects with { pattern, extraParams } structure
  // These represent callable handlers created via patternTool()
  // Format as (e: ExtraParamsType) => void for LLM readability
  if (s.type === "object" || s.properties) {
    const props = s.properties as Record<string, JSONSchema> | undefined;
    if (props && "pattern" in props && "extraParams" in props) {
      // This is a PatternToolResult schema - format as a handler
      const extraParamsSchema = props.extraParams;
      if (depth >= maxDepth) return "(e: {...}) => void";
      const paramType = schemaToTypeString(extraParamsSchema, nextOpts);
      return `(e: ${paramType}) => void`;
    }
  }

  // Handle const - show as the literal, matching the enum rendering (the
  // generator's node path emits `const` where its type path emits a
  // single-value `enum`)
  if (s.const !== undefined) {
    return literalToTypeString(s.const);
  }

  // Handle enum - show as union of literals
  if (Array.isArray(s.enum)) {
    const values = s.enum.slice(0, 5).map(literalToTypeString);
    if (s.enum.length > 5) values.push("...");
    return values.join(" | ");
  }

  // Handle anyOf/oneOf as union types
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const variants = (s.anyOf || s.oneOf) as JSONSchema[];
    const types = variants
      .slice(0, 4)
      .map((v) => schemaToTypeString(v, nextOpts));
    if (variants.length > 4) types.push("...");
    return types.join(" | ");
  }

  // Handle basic types
  const type = s.type;

  // A type array (e.g. from the union formatter's anyOf merge) is a union of
  // the named types
  if (Array.isArray(type)) return typeArrayToUnion(type);

  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";

  // Handle arrays; tuples render as TypeScript tuple types, with a uniform
  // `items` schema alongside `prefixItems` becoming a rest element. An
  // absent (or `true`) `items` beside `prefixItems` leaves the tail OPEN in
  // JSON Schema, so it renders `...unknown[]` — only `items: false` closes
  // the tuple (PR #4969 review).
  if (type === "array") {
    if (Array.isArray(s.prefixItems)) {
      const slots = (s.prefixItems as JSONSchema[]).map((slot) =>
        schemaToTypeString(slot, nextOpts)
      );
      if (s.items && typeof s.items === "object") {
        slots.push(
          `...${
            arrayElementType(
              schemaToTypeString(s.items as JSONSchema, nextOpts),
            )
          }[]`,
        );
      } else if (s.items !== false) {
        slots.push("...unknown[]");
      }
      return `[${slots.join(", ")}]`;
    }
    if (s.items && typeof s.items === "object") {
      const itemType = schemaToTypeString(s.items as JSONSchema, nextOpts);
      return `${arrayElementType(itemType)}[]`;
    }
    return "unknown[]";
  }

  // Handle objects
  // A conjunction states its fields across its members, so they are gathered
  // before the object branch decides whether there are any. A schema whose
  // fields live only in `allOf` states no `type` and no `properties` of its
  // own, and would otherwise not reach that branch at all.
  const sources = Array.isArray(s.allOf) ? conjunctionSources(s, defs) : [s];
  // Null-prototype, because the keys are field names out of caller JSON and a
  // schema may legally declare one called `__proto__`. Measured on Deno 2.9.4:
  // such a key survives a plain `{}` accumulator intact. That is a property of
  // the engine rather than of this code, and the accumulator states which it
  // depends on rather than inheriting the question.
  const conjoined: Record<string, JSONSchema> = Object.create(null);
  const conjoinedRequired: string[] = [];
  for (const source of sources) {
    const sourceProps = source.properties as
      | Record<string, JSONSchema>
      | undefined;
    // First declaration wins, matching how the CLI reads the same conjunction.
    if (sourceProps) {
      for (const [name, propSchema] of Object.entries(sourceProps)) {
        if (!Object.hasOwn(conjoined, name)) conjoined[name] = propSchema;
      }
    }
    // Required is a UNION, not first-wins: every member's constraint holds at
    // once, so a field any member requires is required of the whole.
    if (Array.isArray(source.required)) {
      conjoinedRequired.push(...(source.required as string[]));
    }
  }

  // A conjunct saying `type: "object"` makes the whole an object even when it
  // names no field, and `{}` is what that is. Falling through to `unknown`
  // would deny a shape the schema states. A conjunct saying `type: "string"`
  // is a different matter and still falls through: it contributes no field,
  // and rendering it `{}` would invent an object nothing described.
  //
  // For a schema with no `allOf`, `sources` is the schema alone, so this asks
  // exactly what the object branch has always asked.
  if (
    sources.some((source) => source.type === "object" || !!source.properties)
  ) {
    const props = conjoined;
    // An index signature (object-valued additionalProperties) carries a value
    // schema worth showing; a bare `additionalProperties: true` does not
    const indexValueSchema = isObjectOrArray(s.additionalProperties)
      ? s.additionalProperties as JSONSchema
      : undefined;
    if (!props || Object.keys(props).length === 0) {
      if (indexValueSchema) {
        return `Record<string, ${
          schemaToTypeString(indexValueSchema, nextOpts)
        }>`;
      }
      if (s.additionalProperties) return "Record<string, unknown>";
      return "{}";
    }

    const required = new Set(conjoinedRequired);
    const lines: string[] = [];
    const padding = "  ".repeat(indent + 1);

    for (const [key, propSchema] of Object.entries(props)) {
      // Skip $-prefixed internal properties
      if (key.startsWith("$")) continue;

      const optional = required.has(key) ? "" : "?";
      const propType = schemaToTypeString(propSchema, {
        ...nextOpts,
        indent: indent + 1,
      });
      lines.push(`${padding}${key}${optional}: ${propType}`);
    }

    // Named properties alongside an index signature: TypeScript cannot
    // express "every key EXCEPT the named ones" — an inline index signature
    // conflicts with incompatible named properties, and an intersection
    // with Record<string, T> wrongly constrains the named keys too. Render
    // a descriptive comment line instead (PR #4969 review, both rounds).
    if (indexValueSchema && lines.length > 0) {
      const valueType = schemaToTypeString(indexValueSchema, {
        ...nextOpts,
        indent: 0,
      });
      // Comment EVERY line: a multiline value type (e.g. an object) would
      // otherwise escape the comment after its first line and read as outer
      // object syntax (PR #4969 review).
      const [first, ...restLines] = valueType.split("\n");
      lines.push(
        [
          `${padding}// other keys: ${first}`,
          ...restLines.map((line) => `${padding}// ${line}`),
        ].join("\n"),
      );
    }

    if (lines.length === 0) return "{}";

    const closePadding = "  ".repeat(indent);
    return `{\n${lines.join(",\n")}\n${closePadding}}`;
  }

  // Fallback
  return type ? String(type) : "unknown";
}

/**
 * Renders a literal value the way TS spells the literal type. JSON
 * serialization escapes string contents (PR #4969 review: `"a"b"` was
 * emitted for a legal string constant) and renders object/array literals
 * as JSON instead of "[object Object]".
 */
function literalToTypeString(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** Renders a JSON Schema `type` array as a TS union, e.g. "number | string". */
function typeArrayToUnion(types: readonly unknown[]): string {
  const names = types.map((t) => t === "integer" ? "number" : String(t));
  return [...new Set(names)].join(" | ") || "unknown";
}

/**
 * Wraps an array-element type in parens when `[]` would bind tighter than
 * the type expression: unions (`(number | string)[]`), intersections, and
 * function types (`((e: T) => void)[]`) all need grouping — the ungrouped
 * spellings mean something else entirely (PR #4969 review).
 */
function arrayElementType(itemType: string): string {
  return itemType.includes(" | ") || itemType.includes(" & ") ||
      itemType.includes("=>")
    ? `(${itemType})`
    : itemType;
}

function getWrappedTypeString(
  wrapper: AsCellType,
  innerType: string,
): string {
  const kind = typeof wrapper === "string" ? wrapper : wrapper.kind;
  const scoped = (type: string) =>
    typeof wrapper === "string" ? type : applyScopeWrapper(wrapper.scope, type);
  switch (kind) {
    case "cell":
      return scoped(`Cell<${innerType}>`);
    case "readonly":
      return scoped(`ReadonlyCell<${innerType}>`);
    case "writeonly":
      return scoped(`WriteonlyCell<${innerType}>`);
    case "comparable":
      return scoped(`ComparableCell<${innerType}>`);
    case "stream":
      return scoped(`(${innerType}) => void`);
    case "opaque":
      return scoped("FactoryInput");
    default:
      return "UnknownWrapper";
  }
}

function applyScopeWrapper(scope: unknown, innerType: string): string {
  switch (scope) {
    case "space":
      return `PerSpace<${innerType}>`;
    case "user":
      return `PerUser<${innerType}>`;
    case "session":
      return `PerSession<${innerType}>`;
    case "any":
      return `PerAny<${innerType}>`;
    default:
      return innerType;
  }
}
