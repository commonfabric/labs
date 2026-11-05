/**
 * Runtime utilities for factory-bearing JSON Schema values.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isPlainObject } from "@commonfabric/js-values/types";
import { utf8Compare } from "@commonfabric/text/utf8";

const SCHEMA_NORMALIZATION_FAILED = Symbol("schema normalization failed");

type NormalizedSchemaValue =
  | null
  | boolean
  | number
  | string
  | NormalizedSchemaArray
  | NormalizedSchemaObject;

interface NormalizedSchemaArray extends ReadonlyArray<NormalizedSchemaValue> {}

interface NormalizedSchemaObject {
  readonly [key: string]: NormalizedSchemaValue;
}

type SchemaNormalizationResult =
  | NormalizedSchemaValue
  | typeof SCHEMA_NORMALIZATION_FAILED;

interface SchemaNormalizationContext {
  readonly root: JSONSchema;
  readonly activeObjects: Set<object>;
  /**
   * Non-alias schema nodes on the current normalization path. A `$ref` may
   * point back to one of these nodes; its de Bruijn-style distance is the
   * canonical cycle marker. Ref-only aliases use their own stack so inserting
   * an alias cannot change the normalized recursive structure.
   */
  readonly activeSchemaNodes: object[];
  /**
   * Ref-only nodes followed on the current path, used to terminate pure alias
   * cycles.
   */
  readonly activeRefAliases: object[];
}

const SINGLE_SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const SCHEMA_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const FACTORY_SCHEMA_FIELDS = new Set([
  "argumentSchema",
  "contextSchema",
  "eventSchema",
  "resultSchema",
]);

function decodeJsonPointerSegment(segment: string): string | undefined {
  if (/~(?:[^01]|$)/.test(segment)) return undefined;
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function resolveLocalSchemaRef(
  ref: string,
  root: JSONSchema,
): JSONSchema | undefined {
  if (ref === "" || ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const encodedSegment of ref.slice(2).split("/")) {
    let pointerSegment: string;
    try {
      // Split the URI-fragment JSON Pointer before percent-decoding. `%2F`
      // belongs to one property name; decoding the whole fragment first would
      // incorrectly turn it into another path separator.
      pointerSegment = decodeURIComponent(encodedSegment);
    } catch {
      return undefined;
    }
    const segment = decodeJsonPointerSegment(pointerSegment);
    if (
      segment === undefined || current === null ||
      (typeof current !== "object" && typeof current !== "function") ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "boolean" || isPlainObject(current)
    ? current as JSONSchema
    : undefined;
}

/**
 * Add required object-property paths to a schema without weakening any schema
 * already present at those paths. Missing leaves are admitted by `true`;
 * callers retain separate authority over what supplies their values.
 */
export function addRequiredSchemaPaths(
  schema: JSONSchema,
  paths: readonly (readonly string[])[],
): JSONSchema {
  let result = schema;
  for (const path of paths) result = addRequiredSchemaPath(result, path);
  return result;
}

function addRequiredSchemaPath(
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema {
  const [head, ...tail] = path;
  if (!head) return schema;
  if (schema === false) return false;
  const base: Record<string, unknown> = isPlainObject(schema)
    ? { ...(schema as JSONSchemaObj) }
    : { type: "object" };
  const declaredType = base.type;
  const admitsObject = declaredType === undefined ||
    declaredType === "object" ||
    (Array.isArray(declaredType) && declaredType.includes("object"));
  if (!admitsObject) {
    return {
      allOf: [schema, addRequiredSchemaPath(true, path)],
    } as JSONSchema;
  }
  const oldProperties: Record<string, unknown> = isPlainObject(base.properties)
    ? base.properties as Record<string, unknown>
    : {};
  const child = Object.hasOwn(oldProperties, head)
    ? oldProperties[head] as JSONSchema | undefined
    : undefined;
  const nextChild = tail.length === 0
    ? child ?? true
    : addRequiredSchemaPath(child ?? true, tail);
  const required = Array.isArray(base.required) ? [...base.required] : [];
  if (!required.includes(head)) required.push(head);
  return {
    ...base,
    type: "object",
    properties: { ...oldProperties, [head]: nextChild },
    required,
  } as JSONSchema;
}

function normalizeSchemaData(
  value: unknown,
  context: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (
    value === null || typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : SCHEMA_NORMALIZATION_FAILED;
  }
  if (typeof value !== "object") return SCHEMA_NORMALIZATION_FAILED;
  if (context.activeObjects.has(value)) return SCHEMA_NORMALIZATION_FAILED;

  context.activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: NormalizedSchemaValue[] = [];
      for (const entry of value) {
        const result = normalizeSchemaData(entry, context);
        if (result === SCHEMA_NORMALIZATION_FAILED) return result;
        normalized.push(result);
      }
      return normalized;
    }
    if (!isPlainObject(value)) return SCHEMA_NORMALIZATION_FAILED;

    const record = value as Record<string, unknown>;
    const normalized: Record<string, NormalizedSchemaValue> = Object.create(
      null,
    );
    for (const key of Object.keys(record).sort()) {
      const result = normalizeSchemaData(record[key], context);
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized[key] = result;
    }
    return normalized;
  } finally {
    context.activeObjects.delete(value);
  }
}

function normalizeSchemaMap(
  value: unknown,
  context: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (!isPlainObject(value)) return SCHEMA_NORMALIZATION_FAILED;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, NormalizedSchemaValue> = Object.create(null);
  for (const key of Object.keys(record).sort()) {
    const result = normalizeSchemaNode(record[key] as JSONSchema, context);
    if (result === SCHEMA_NORMALIZATION_FAILED) return result;
    normalized[key] = result;
  }
  return normalized;
}

function normalizeFactoryContract(
  value: unknown,
  context: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (!isPlainObject(value)) return SCHEMA_NORMALIZATION_FAILED;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, NormalizedSchemaValue> = Object.create(null);
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    const result = FACTORY_SCHEMA_FIELDS.has(key)
      ? normalizeFactorySchemaDocument(entry, context)
      : normalizeSchemaData(entry, context);
    if (result === SCHEMA_NORMALIZATION_FAILED) return result;
    normalized[key] = result;
  }
  return normalized;
}

function normalizeFactorySchemaDocument(
  value: unknown,
  parent: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (typeof value !== "boolean" && !isPlainObject(value)) {
    return SCHEMA_NORMALIZATION_FAILED;
  }
  const schema = value as JSONSchema;
  return normalizeSchemaNode(schema, {
    root: schema,
    // Object identity remains shared across document boundaries so malformed
    // JavaScript object cycles fail closed. JSON Pointer activity is local to
    // this public factory schema because every field owns its own `$defs`.
    activeObjects: parent.activeObjects,
    activeSchemaNodes: [],
    activeRefAliases: [],
  });
}

function normalizeSchemaKeyword(
  key: string,
  value: unknown,
  context: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (key === "enum") {
    if (!Array.isArray(value)) return SCHEMA_NORMALIZATION_FAILED;
    const normalized: NormalizedSchemaValue[] = [];
    for (const entry of value) {
      const result = normalizeSchemaData(entry, context);
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized.push(result);
    }
    // JSON Schema defines `enum` as a set. `normalizeSchemaData()` has already
    // sorted object keys, so JSON serialization gives each valid JSON member a
    // deterministic ordering key without weakening equality of its contents.
    normalized.sort((left, right) =>
      utf8Compare(JSON.stringify(left), JSON.stringify(right))
    );
    return normalized;
  }
  if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
    return normalizeSchemaNode(value as JSONSchema, context);
  }
  if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
    if (!Array.isArray(value)) return SCHEMA_NORMALIZATION_FAILED;
    const normalized: NormalizedSchemaValue[] = [];
    for (const entry of value) {
      const result = normalizeSchemaNode(entry as JSONSchema, context);
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized.push(result);
    }
    return normalized;
  }
  if (SCHEMA_MAP_KEYWORDS.has(key)) {
    return normalizeSchemaMap(value, context);
  }
  if (key === "items") {
    if (!Array.isArray(value)) {
      return normalizeSchemaNode(value as JSONSchema, context);
    }
    const normalized: NormalizedSchemaValue[] = [];
    for (const entry of value) {
      const result = normalizeSchemaNode(entry as JSONSchema, context);
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized.push(result);
    }
    return normalized;
  }
  if (key === "dependencies") {
    if (!isPlainObject(value)) return SCHEMA_NORMALIZATION_FAILED;
    const record = value as Record<string, unknown>;
    const normalized: Record<string, NormalizedSchemaValue> = Object.create(
      null,
    );
    for (const dependency of Object.keys(record).sort()) {
      const entry = record[dependency];
      const result = Array.isArray(entry)
        ? normalizeSchemaData(entry, context)
        : normalizeSchemaNode(entry as JSONSchema, context);
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized[dependency] = result;
    }
    return normalized;
  }
  if (key === "asFactory") {
    return normalizeFactoryContract(value, context);
  }
  return normalizeSchemaData(value, context);
}

function mergeResolvedSchemaRef(
  target: NormalizedSchemaValue,
  siblings: Readonly<Record<string, NormalizedSchemaValue>>,
): NormalizedSchemaValue {
  if (Object.keys(siblings).length === 0) return target;
  if (isPlainObject(target)) {
    const targetObject = target as NormalizedSchemaObject;
    const canFlatten = Object.keys(siblings).every((key) =>
      !Object.hasOwn(targetObject, key) ||
      deepEqual(targetObject[key], siblings[key])
    );
    if (!canFlatten) {
      return ["$ref-and-siblings", target, siblings];
    }
    const merged: Record<string, NormalizedSchemaValue> = Object.create(null);
    for (
      const [key, value] of [
        ...Object.entries(targetObject),
        ...Object.entries(siblings),
      ].sort(([left], [right]) => utf8Compare(left, right))
    ) {
      merged[key] = value;
    }
    return merged;
  }
  // Internal normalization marker for a `$ref` whose sibling assertions
  // cannot be losslessly flattened into the resolved object.
  return ["$ref-and-siblings", target, siblings];
}

function normalizeSchemaNode(
  schema: JSONSchema,
  context: SchemaNormalizationContext,
): SchemaNormalizationResult {
  if (typeof schema === "boolean") return schema;
  if (!isPlainObject(schema)) return SCHEMA_NORMALIZATION_FAILED;
  if (context.activeObjects.has(schema)) return SCHEMA_NORMALIZATION_FAILED;

  const hasRef = Object.hasOwn(schema, "$ref");
  const refOnlyAlias = hasRef &&
    Object.keys(schema).every((key) =>
      key === "$ref" || key === "$defs" || key === "definitions"
    );
  const activeNodeStack = refOnlyAlias
    ? context.activeRefAliases
    : context.activeSchemaNodes;
  context.activeObjects.add(schema);
  activeNodeStack.push(schema);
  try {
    let resolved: NormalizedSchemaValue | undefined;
    if (hasRef) {
      if (typeof schema.$ref !== "string") {
        return SCHEMA_NORMALIZATION_FAILED;
      }
      const target = resolveLocalSchemaRef(schema.$ref, context.root);
      if (target === undefined) return SCHEMA_NORMALIZATION_FAILED;
      const activeSchemaTargetIndex = typeof target === "object"
        ? context.activeSchemaNodes.lastIndexOf(target)
        : -1;
      const activeAliasTargetIndex = typeof target === "object"
        ? context.activeRefAliases.lastIndexOf(target)
        : -1;
      if (activeSchemaTargetIndex >= 0) {
        // Definition names and pointer spellings are not semantic. Encode the
        // edge by its distance to the active target so independently allocated
        // and equivalently inlined recursive documents normalize identically.
        resolved = [
          "$recursive-ref",
          context.activeSchemaNodes.length - 1 - activeSchemaTargetIndex,
        ];
      } else if (activeAliasTargetIndex >= 0) {
        // A cycle consisting only of ref aliases has no schema structure to
        // distinguish after reference resolution. Collapse every such cycle to
        // the same terminating marker rather than encoding alias hop count.
        resolved = ["$recursive-ref-alias-cycle"];
      } else {
        const normalized = normalizeSchemaNode(target, context);
        if (normalized === SCHEMA_NORMALIZATION_FAILED) return normalized;
        resolved = normalized;
      }
    }

    const normalized: Record<string, NormalizedSchemaValue> = Object.create(
      null,
    );
    const schemaRecord = schema as unknown as Record<string, unknown>;
    for (const key of Object.keys(schema).sort()) {
      if (key === "$ref" || key === "$defs" || key === "definitions") {
        continue;
      }
      const result = normalizeSchemaKeyword(
        key,
        schemaRecord[key],
        context,
      );
      if (result === SCHEMA_NORMALIZATION_FAILED) return result;
      normalized[key] = result;
    }
    return resolved === undefined
      ? normalized
      : mergeResolvedSchemaRef(resolved, normalized);
  } finally {
    activeNodeStack.pop();
    context.activeObjects.delete(schema);
  }
}

function normalizeFactorySchema(
  schema: JSONSchema,
): SchemaNormalizationResult {
  return normalizeSchemaNode(schema, {
    root: schema,
    activeObjects: new Set(),
    activeSchemaNodes: [],
    activeRefAliases: [],
  });
}

/**
 * Compare factory public schemas after deterministic structural normalization.
 *
 * Each top-level schema, and each public schema field inside a nested
 * `asFactory`, resolves JSON Pointer `$ref`s only against its own document
 * root. Definition containers are removed after resolution; every other
 * keyword, including Common Fabric's `asFactory`, remains part of exact
 * equality. Valid recursive local refs normalize to structural back-edges;
 * external, missing, or malformed refs and direct JavaScript object cycles fail
 * closed (`false`). Missing schemas remain distinct from the JSON Schema `true`
 * value.
 */
export function factorySchemasEqual(
  left: JSONSchema | undefined,
  right: JSONSchema | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    const normalizedLeft = normalizeFactorySchema(left);
    const normalizedRight = normalizeFactorySchema(right);
    return normalizedLeft !== SCHEMA_NORMALIZATION_FAILED &&
      normalizedRight !== SCHEMA_NORMALIZATION_FAILED &&
      deepEqual(normalizedLeft, normalizedRight);
  } catch {
    return false;
  }
}
