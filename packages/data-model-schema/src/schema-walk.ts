/**
 * Central JSON-Schema structural traversal.
 *
 * Many places in the codebase recurse into a schema's subschemas, and each has
 * historically re-encoded the set of subschema-bearing keywords (`properties`,
 * `items`, `allOf`, ...). That duplication has caused real gaps: several
 * hand-rolled walkers silently skip `prefixItems` (see the `TODO(@ubik2)`
 * comments in `runner/src/traverse.ts` and `runner/src/schema.ts`). This module
 * is the single source of truth for that keyword vocabulary and the traversal
 * over it.
 *
 * ## Two keyword tiers
 *
 * The DEFAULT walk covers only the keywords our schemas actually emit — the
 * value-semantics walkers (ifc detection, the LLM stamp, ...) act on those and
 * would only waste work on the rest. These keywords are excluded by default:
 *
 *   `patternProperties`, `contains`, `if`, `then`, `else`, `propertyNames`,
 *   `dependentSchemas`, `contentSchema`, `unevaluatedProperties`,
 *   `unevaluatedItems` (and `definitions`, the pre-2019 alias for `$defs`,
 *   which we never emit at all).
 *
 * A structural walk that must be COMPLETE regardless of what we emit — notably
 * `$ref` discovery in `cfc/schema-refs.ts`, a fail-closed guard: a ref that
 * isn't found is a schema doc that doesn't replicate — passes `includeUnused`
 * to also visit the excluded keywords (see `UNUSED_SINGLE_SUBSCHEMA_KEYS` /
 * `UNUSED_RECORD_SUBSCHEMA_KEYS`). `definitions` stays out even then; use
 * `includeDefs` for `$defs` bodies.
 *
 * `$ref` resolution is opt-in per walk (see `SchemaWalkOptions.resolveRef`):
 * following a ref needs a definition scope, which is caller/runtime specific.
 *
 * ## Values that are not schemas
 *
 * A schema reaching the runtime has not necessarily come from the schema
 * generator — it may have been written into a space by anything — so a keyword
 * here can hold a value that is not a schema at all (see {@link isSubschema}),
 * and a keyword taking several subschemas can hold something that is not the
 * array or the object it needs. Such a value has no subschemas and cannot be
 * rewritten into one, so the walk treats the edge as leading nowhere: the value
 * is not visited, not descended into, and not rewritten, and it stays in place
 * in a mapped result. Each one is reported once per walk that reaches it, at
 * warn level, naming the keyword, the value, and the schema holding it.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  isBoolean,
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { debugStr } from "@commonfabric/data-model";

const logger = getLogger("schema-walk", { level: "warn" });

// The supported subschema-bearing keywords, grouped by how each keyword holds
// its subschema(s). See the module docstring for the keywords we deliberately
// omit. `$defs` is kept separate: it holds dormant definitions reached only
// through `$ref`, so a structural walk skips it unless `includeDefs` is set.

/** Keywords whose value is a single subschema. */
export const SINGLE_SUBSCHEMA_KEYS = [
  "not",
  "items",
  "additionalProperties",
] as const;

/** Keywords whose value is an array of subschemas. */
export const ARRAY_SUBSCHEMA_KEYS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
] as const;

/** Keywords whose value is a record of named subschemas. */
export const RECORD_SUBSCHEMA_KEYS = [
  "properties",
] as const;

/** Keywords holding dormant definitions reached only via `$ref`. */
export const DEFS_KEYS = ["$defs"] as const;

/**
 * Single-subschema keywords we never emit — walked only when a caller sets
 * `includeUnused` (e.g. `$ref` discovery, which must be complete). See the
 * module docstring.
 */
export const UNUSED_SINGLE_SUBSCHEMA_KEYS = [
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "contentSchema",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

/** Record-subschema keywords we never emit — walked only with `includeUnused`. */
export const UNUSED_RECORD_SUBSCHEMA_KEYS = [
  "patternProperties",
  "dependentSchemas",
] as const;

export type SubschemaKeyword =
  | (typeof SINGLE_SUBSCHEMA_KEYS)[number]
  | (typeof ARRAY_SUBSCHEMA_KEYS)[number]
  | (typeof RECORD_SUBSCHEMA_KEYS)[number]
  | (typeof DEFS_KEYS)[number]
  | (typeof UNUSED_SINGLE_SUBSCHEMA_KEYS)[number]
  | (typeof UNUSED_RECORD_SUBSCHEMA_KEYS)[number];

/**
 * Everything a schema can be: `true`, `false`, or an object that is not an
 * array. Rejecting the array rejects the pre-2019 tuple spelling of `items`
 * along with everything else an array could mean in a subschema position. See
 * the module docstring for how the walk treats a value that fails this.
 *
 * `validateSchemaDefinition` gates an authored schema on the same question and
 * calls this to ask it, so what the two admit cannot drift apart.
 */
export function isSubschema(value: unknown): value is JSONSchema {
  return isBoolean(value) || isObjectNotArray(value);
}

export interface SchemaWalkOptions {
  /** Also descend into `$defs` bodies. Default false. */
  readonly includeDefs?: boolean;

  /**
   * Also visit subschemas under the keywords we never emit
   * (`UNUSED_SINGLE_SUBSCHEMA_KEYS` / `UNUSED_RECORD_SUBSCHEMA_KEYS`). Default
   * false. Set it for structural walks that must be complete regardless of what
   * we emit — chiefly `$ref` discovery, where a missed ref is a fail-open bug.
   */
  readonly includeUnused?: boolean;

  /**
   * Also invoke the visitor for boolean subschemas (`true` / `false`). Default
   * false — most callers only care about object schemas.
   */
  readonly visitBooleans?: boolean;

  /**
   * Resolve `$ref` while walking. Honored by {@link walkSchema} only
   * (`forEachSubschema` is shallow). At a node carrying a string `$ref`, the
   * walker calls this with that node; a returned schema is walked in place (same
   * path, `viaRef: true`), so a label/annotation on the ref *target* is seen.
   * Return `undefined` to leave the `$ref` a leaf.
   *
   * The resolver owns definition-scope: for a schema whose refs all resolve
   * against one root `$defs`, a closure over that root suffices; nested
   * definition scopes are the resolver's responsibility. Ref cycles are broken
   * by the walk's own on-path guard.
   */
  readonly resolveRef?: (schema: JSONSchemaObj) => JSONSchema | undefined;
}

/**
 * Called for one immediate subschema. The edge that reached it (its `keyword`,
 * and the property `key` or array `index`) is passed as separate args so the
 * common callback — one that only reads `child` — allocates nothing per node.
 * Return `true` to stop the enclosing {@link forEachSubschema} early.
 */
export type SubschemaVisitor = (
  child: JSONSchema,
  keyword: SubschemaKeyword,
  key: string | undefined,
  index: number | undefined,
) => boolean | void;

type SingleKeyword =
  | (typeof SINGLE_SUBSCHEMA_KEYS)[number]
  | (typeof UNUSED_SINGLE_SUBSCHEMA_KEYS)[number];
type RecordKeyword =
  | (typeof RECORD_SUBSCHEMA_KEYS)[number]
  | (typeof UNUSED_RECORD_SUBSCHEMA_KEYS)[number]
  | (typeof DEFS_KEYS)[number];

/** The single-subschema keywords a walk visits under `opts`. */
const singleKeywordsFor = (
  opts: SchemaWalkOptions,
): readonly SingleKeyword[] =>
  opts.includeUnused
    ? [...SINGLE_SUBSCHEMA_KEYS, ...UNUSED_SINGLE_SUBSCHEMA_KEYS]
    : SINGLE_SUBSCHEMA_KEYS;

/** The record-subschema keywords a walk visits under `opts`. */
const recordKeywordsFor = (
  opts: SchemaWalkOptions,
): readonly RecordKeyword[] => {
  const keys: RecordKeyword[] = [...RECORD_SUBSCHEMA_KEYS];
  if (opts.includeUnused) keys.push(...UNUSED_RECORD_SUBSCHEMA_KEYS);
  if (opts.includeDefs) keys.push(...DEFS_KEYS);
  return keys;
};

/** Report a keyword holding `found` where `expected` belongs. */
const warnNotSchema = (
  expected: string,
  keyword: SubschemaKeyword,
  key: string | number | undefined,
  found: unknown,
  parent: JSONSchema,
): void => {
  logger.warn("non-schema", () => [
    `Ignoring \`${key === undefined ? keyword : `${keyword}/${key}`}\`:`,
    debugStr`expected ${expected}, found $quote,long${found} in schema $quote,long${parent}`,
  ]);
};

/** Whether a subschema position holds a subschema, reporting it when not. */
const holdsSubschema = (
  value: unknown,
  keyword: SubschemaKeyword,
  key: string | number | undefined,
  parent: JSONSchema,
): value is JSONSchema => {
  if (isSubschema(value)) return true;
  warnNotSchema("a schema", keyword, key, value, parent);
  return false;
};

/** Whether an array-valued keyword holds an array, reporting it when not. */
const holdsSubschemaArray = (
  value: unknown,
  keyword: SubschemaKeyword,
  parent: JSONSchema,
): value is readonly JSONSchema[] => {
  if (Array.isArray(value)) return true;
  warnNotSchema("an array of schemas", keyword, undefined, value, parent);
  return false;
};

/**
 * Whether a record-valued keyword holds an object, reporting it when not.
 *
 * An array counts, unlike in a subschema position. `validateSchemaDefinition`
 * refuses one here, but that gate gets its say over an authored schema, not
 * over a stored one, and the validator that reads values enumerates these
 * keywords with `Object.entries` and asks `Object.hasOwn` — both of which read
 * an array's indices as names. A walk answering "no subschemas here" would be
 * answering for keys a read goes on to use.
 */
const holdsSubschemaRecord = (
  value: unknown,
  keyword: SubschemaKeyword,
  parent: JSONSchema,
): value is Readonly<Record<string, unknown>> => {
  if (isObjectOrArray(value)) return true;
  warnNotSchema(
    "an object of named schemas",
    keyword,
    undefined,
    value,
    parent,
  );
  return false;
};

/**
 * Invoke `visit` on each immediate subschema of `schema` (shallow — one level).
 * A boolean schema has no subschemas. `$defs` is visited only when
 * `opts.includeDefs`; the never-emitted keywords only when `opts.includeUnused`.
 * Returns `true` if a visit stopped early (returned `true`), else `false`.
 *
 * This is the low-level, allocation-light primitive — no generator, no per-node
 * object. Hot walkers recurse over it directly; {@link walkSchema} is the
 * ergonomic recursive visitor built on top. (`resolveRef` does not apply here —
 * resolution is a recursive concern; see {@link walkSchema}.)
 */
export function forEachSubschema(
  schema: JSONSchema,
  visit: SubschemaVisitor,
  opts: SchemaWalkOptions = {},
): boolean {
  if (!isObjectOrArray(schema)) return false;
  const node = schema as JSONSchemaObj;
  for (const keyword of singleKeywordsFor(opts)) {
    const child = node[keyword];
    if (child === undefined) continue;
    if (!holdsSubschema(child, keyword, undefined, node)) continue;
    if (visit(child, keyword, undefined, undefined)) return true;
  }
  for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
    const arr = node[keyword];
    if (arr === undefined) continue;
    if (!holdsSubschemaArray(arr, keyword, node)) continue;
    for (let index = 0; index < arr.length; index++) {
      const child = arr[index];
      if (!holdsSubschema(child, keyword, index, node)) continue;
      if (visit(child, keyword, undefined, index)) return true;
    }
  }
  for (const keyword of recordKeywordsFor(opts)) {
    const record = node[keyword];
    if (record === undefined) continue;
    if (!holdsSubschemaRecord(record, keyword, node)) continue;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (!holdsSubschema(child, keyword, key, node)) continue;
      if (visit(child, keyword, key, undefined)) return true;
    }
  }
  return false;
}

/** One immediate subschema of a parent, with the edge that reached it. */
export interface SubschemaEdge {
  readonly schema: JSONSchema;

  /** The keyword this subschema hangs off. */
  readonly keyword: SubschemaKeyword;

  /** For record-valued keywords: the property / definition name. */
  readonly key?: string;

  /** For array-valued keywords: the index. */
  readonly index?: number;
}

/**
 * Generator form of {@link forEachSubschema}: yields each immediate subschema
 * as an edge object, so callers can use `for…of` (and `break`/spread/iterator
 * helpers) instead of the callback + `return true` convention.
 *
 * ```ts
 * for (const { schema, keyword } of subschemaEdges(node)) { ... }
 * ```
 *
 * Simpler to read, but ~2× slower than `forEachSubschema` (a generator
 * allocates an iterator and an edge object per node). Prefer `forEachSubschema`
 * on hot paths; reach for this when clarity matters more than the microseconds.
 * Same tiers apply (`includeDefs`, `includeUnused`).
 */
export function* subschemaEdges(
  schema: JSONSchema,
  opts: SchemaWalkOptions = {},
): Generator<SubschemaEdge> {
  if (!isObjectOrArray(schema)) return;
  const node = schema as JSONSchemaObj;
  for (const keyword of singleKeywordsFor(opts)) {
    const child = node[keyword];
    if (child === undefined) continue;
    if (!holdsSubschema(child, keyword, undefined, node)) continue;
    yield { schema: child, keyword };
  }
  for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
    const arr = node[keyword];
    if (arr === undefined) continue;
    if (!holdsSubschemaArray(arr, keyword, node)) continue;
    for (let index = 0; index < arr.length; index++) {
      const child = arr[index];
      if (!holdsSubschema(child, keyword, index, node)) continue;
      yield { schema: child, keyword, index };
    }
  }
  for (const keyword of recordKeywordsFor(opts)) {
    const record = node[keyword];
    if (record === undefined) continue;
    if (!holdsSubschemaRecord(record, keyword, node)) continue;
    for (const [key, child] of Object.entries(record)) {
      if (!holdsSubschema(child, keyword, key, node)) continue;
      yield { schema: child, keyword, key };
    }
  }
}

/**
 * Rebuild `schema` replacing each immediate subschema with `map(child)`,
 * preserving object identity when nothing changed (returns the same object, and
 * leaves untouched arrays/records untouched). Shallow — `map` decides whether to
 * recurse. `$defs` is rewritten only when `opts.includeDefs`; the never-emitted
 * keywords only when `opts.includeUnused`.
 */
export function mapSubschemas(
  schema: JSONSchemaObj,
  map: (child: JSONSchema) => JSONSchema,
  opts: SchemaWalkOptions = {},
): JSONSchemaObj {
  let result: Record<string, unknown> | undefined;
  const update = (key: string, value: unknown): void => {
    result ??= { ...schema };
    result[key] = value;
  };

  for (const keyword of singleKeywordsFor(opts)) {
    const child = schema[keyword];
    if (child === undefined) continue;
    if (!holdsSubschema(child, keyword, undefined, schema)) continue;
    const mapped = map(child);
    if (mapped !== child) update(keyword, mapped);
  }
  for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
    const children = schema[keyword];
    if (children === undefined) continue;
    if (!holdsSubschemaArray(children, keyword, schema)) continue;
    let mapped: JSONSchema[] | undefined;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!holdsSubschema(child, keyword, index, schema)) continue;
      const next = map(child);
      if (next !== child) {
        mapped ??= [...children];
        mapped[index] = next;
      }
    }
    if (mapped !== undefined) update(keyword, mapped);
  }
  for (const keyword of recordKeywordsFor(opts)) {
    const children = schema[keyword];
    if (children === undefined) continue;
    if (!holdsSubschemaRecord(children, keyword, schema)) continue;
    const entries = Object.entries(children);
    let mapped: [string, unknown][] | undefined;
    for (let index = 0; index < entries.length; index++) {
      const [name, child] = entries[index]!;
      if (!holdsSubschema(child, keyword, name, schema)) continue;
      const next = map(child);
      if (next !== child) {
        mapped ??= entries;
        mapped[index] = [name, next];
      }
    }
    if (mapped !== undefined) update(keyword, Object.fromEntries(mapped));
  }
  return (result ?? schema) as JSONSchemaObj;
}

/** A subschema node visited during a recursive walk. */
export interface SchemaNode {
  /** The subschema at this node. */
  readonly schema: JSONSchema;

  /**
   * Structural path from the walk root: keyword-segmented, e.g.
   * `["properties", "user", "items"]` or `["allOf", 0, "properties", "id"]`.
   * Empty at the root.
   */
  readonly path: ReadonlyArray<string | number>;

  /** The keyword the edge from the parent used; undefined at the root. */
  readonly keyword?: SubschemaKeyword | undefined;

  /** Record edge: the property / definition name. */
  readonly key?: string | undefined;

  /** Array edge: the index. */
  readonly index?: number | undefined;

  /** The parent subschema; undefined at the root. */
  readonly parent?: JSONSchemaObj | undefined;

  /**
   * True when this node is a `$ref` target reached via
   * {@link SchemaWalkOptions.resolveRef}. Its `path` is the ref site's path
   * (the target occupies the same logical position).
   */
  readonly viaRef?: boolean;
}

/**
 * Returned by a {@link SchemaVisitor} to steer the walk. Returning nothing
 * (`undefined`) descends into the node's children — the common case.
 */
export type WalkControl =

  /** Do not descend into this node's children; continue with its siblings. */
  | "skip"
  /** Abort the entire walk immediately. */
  | "stop";

export type SchemaVisitor = (node: SchemaNode) => WalkControl | void;

/**
 * Depth-first pre-order walk over `root` and every structural subschema,
 * invoking `visit` once per node. The visitor steers descent via its return
 * value (see {@link WalkControl}); returning nothing descends.
 *
 * With {@link SchemaWalkOptions.resolveRef} set, a node's `$ref` target is
 * walked too (in addition to any sibling keywords), so labels on the target are
 * seen. Cycles in the object graph — structural or via `$ref` — are broken
 * automatically along the current path, while a subschema shared by sibling
 * positions is still visited at each position.
 */
export function walkSchema(
  root: JSONSchema,
  visit: SchemaVisitor,
  opts: SchemaWalkOptions = {},
): void {
  // Path-scoped guard: added on enter, removed on exit, so it breaks only
  // self-referential cycles — a subschema reused at sibling positions is a DAG
  // edge, not a cycle, and is still walked at each position.
  const onPath = new Set<JSONSchema>();
  let stopped = false;

  const recurse = (
    schema: JSONSchema,
    path: ReadonlyArray<string | number>,
    edge: Pick<SchemaNode, "keyword" | "key" | "index" | "viaRef">,
    parent: JSONSchemaObj | undefined,
  ): void => {
    // The root and a `resolveRef` result come straight from the caller; every
    // other node arrives already filtered by `forEachSubschema`.
    if (!isSubschema(schema)) return;
    const record = isObjectOrArray(schema);
    if (!record && !opts.visitBooleans) return;
    const control = visit({ schema, path, ...edge, parent });
    if (control === "stop") {
      stopped = true;
      return;
    }
    // The node is always visited once; the cycle guard gates only DESCENT, so a
    // self-referential edge is reported (once) without recursing forever, and a
    // subschema shared by sibling positions is fully walked at each position.
    if (control === "skip" || !record || onPath.has(schema)) return;
    onPath.add(schema);
    try {
      forEachSubschema(schema, (child, keyword, key, index) => {
        const step: Array<string | number> = index !== undefined
          ? [keyword, index]
          : key !== undefined
          ? [keyword, key]
          : [keyword];
        recurse(
          child,
          [...path, ...step],
          { keyword, key, index },
          schema as JSONSchemaObj,
        );
        return stopped; // halt the enumeration if the walk aborted
      }, opts);
      if (stopped) return;
      // `$ref` target (opt-in): walked at the ref site's own path so a label on
      // the target counts. The on-path guard above covers ref cycles.
      if (
        opts.resolveRef && typeof (schema as JSONSchemaObj).$ref === "string"
      ) {
        const resolved = opts.resolveRef(schema as JSONSchemaObj);
        if (resolved !== undefined && resolved !== schema) {
          recurse(resolved, path, { viaRef: true }, schema as JSONSchemaObj);
          if (stopped) return;
        }
      }
    } finally {
      onPath.delete(schema);
    }
  };

  recurse(root, [], {}, undefined);
}

/**
 * The first subschema node (root included) for which `predicate` returns true,
 * or `undefined` if none. Short-circuits on the first match.
 */
export function findSchema(
  root: JSONSchema,
  predicate: (node: SchemaNode) => boolean,
  opts: SchemaWalkOptions = {},
): SchemaNode | undefined {
  let found: SchemaNode | undefined;
  walkSchema(root, (node) => {
    if (predicate(node)) {
      found = node;
      return "stop";
    }
    return undefined;
  }, opts);
  return found;
}

/**
 * Whether any subschema node (root included) satisfies `predicate`.
 * Short-circuits on the first match.
 */
export function anySchema(
  root: JSONSchema,
  predicate: (node: SchemaNode) => boolean,
  opts: SchemaWalkOptions = {},
): boolean {
  return findSchema(root, predicate, opts) !== undefined;
}
