import {
  debugStr,
  deepFreeze,
  type FabricValue,
  isDeepFrozen,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  deepFrozenCloneAndInternSchema,
  internSchema,
  isNontrivialSchema,
} from "@commonfabric/data-model-schema";
import {
  containsExternalSchemaRef,
  isExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import type { JSONSchemaObj } from "@commonfabric/api";
import {
  decomposeSchema,
  recomposeSchema,
  SchemaNotDecomposableError,
} from "./schema-decompose.ts";
import { mapLinkSchemas } from "@commonfabric/memory/v2/schema-table-links";
import {
  externalResolutionMissCount,
  lookupSchemaDocument,
  onSchemaRegistryClear,
  registerSchemaDocument,
} from "./schema-registry.ts";
import type { MetaLinkField } from "./meta-seam.ts";
import type { IReadOptions } from "./storage/interface.ts";
import { getContentAddressedSchemasConfig } from "./schema-doc-config.ts";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";

import {
  type AnyCell,
  type DerivedInternalCellDescriptor,
  type JSONSchema,
  type JSONValue,
} from "./builder/types.ts";
import {
  type Cell,
  isAnyCell,
  isCell,
  type MemorySpace,
  type Stream,
} from "./cell.ts";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
import { resolveExternalCfcSchemaRefAsDocument } from "./cfc/schema-refs.ts";
import { createRef } from "./create-ref.ts";
import { resolveLink } from "./link-resolution.ts";
import { ensureExternalSchemaClosure } from "./schema-ifc.ts";
import {
  areNormalizedLinksSame,
  isNormalizedFullLink,
  isNormalizedLink,
  isPrimitiveCellLink,
  NormalizedFullLink,
  NormalizedLink,
  parseLinkPrimitive,
  PrimitiveCellLink,
} from "./link-types.ts";
import {
  CellResultInternals,
  getCellOrThrow,
  isCellResultForDereferencing,
} from "./query-result-proxy.ts";
import type { Runtime } from "./runtime.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { type CellLinkRefPayload, type SigilLink } from "./sigil-types.ts";
import {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "./storage/interface.ts";
import { toURI } from "./uri-utils.ts";

export * from "./link-types.ts";

/**
 * A type reflecting all possible link formats, including cells themselves.
 */
export type CellLink =
  | Cell<any>
  | Stream<any>
  | CellResultInternals
  | PrimitiveCellLink;

/**
 * Check if value is any kind of link or linkable entity
 */
export function isCellLink(
  value: any,
): value is CellLink {
  return (
    isCellResultForDereferencing(value) ||
    isPrimitiveCellLink(value) ||
    isCell(value)
  );
}

/**
 * Parse any link-like value to normalized format
 *
 * Overloads just help make fields non-optional that can be guaranteed to exist
 * in various combinations.
 */
export function parseLink(
  value: AnyCell<any>,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base: AnyCell<any> | NormalizedFullLink | IMemorySpaceAddress,
): NormalizedFullLink;
export function parseLink(
  value: CellLink,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink;
export function parseLink(
  value: any,
  base: AnyCell<any> | NormalizedFullLink | IMemorySpaceAddress,
): NormalizedFullLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink | undefined;
export function parseLink(
  value: any,
  base?: AnyCell<any> | NormalizedLink | IMemorySpaceAddress,
): NormalizedLink | undefined {
  // Has to be first, since below we check for "/" in value and we don't want to
  // see userland "/".
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) return value.getAsNormalizedFullLink();

  if (isPrimitiveCellLink(value)) {
    // A sigil-parsed link is DATA-DERIVED (link-types.ts `viaLinkHop`):
    // it names somebody else's doc, so a later read that dead-ends at
    // that doc missing is an unresolved input, not a known absence.
    const markDerived = <L extends NormalizedLink | undefined>(link: L): L =>
      link === undefined ? link : { ...link, viaLinkHop: true as const };
    if (!base) {
      return markDerived(parseLinkPrimitive(value));
    } else if (isAnyCell(base)) {
      return markDerived(
        parseLinkPrimitive(value, base.getAsNormalizedFullLink()),
      );
    } else if (isNormalizedLink(base)) {
      return markDerived(parseLinkPrimitive(value, base));
    }
    throw new Error(`Unexpected link base: ${base}`);
  }
  return undefined;
}

/**
 * Parse any link-like value to normalized format, throwing on failure
 */
export function parseLinkOrThrow(
  value: any,
  baseCell?: Cell,
): NormalizedLink {
  const result = parseLink(value, baseCell);
  if (!result) {
    throw new Error(
      debugStr`Cannot parse value as link: $quote${value}`,
    );
  }
  return result;
}

/**
 * Compare two link values for equality, supporting all link formats
 */
export function areLinksSame(
  value1: any,
  value2: any,
  base?: Cell | NormalizedLink,
  resolveBeforeComparing?: boolean,
  txForResolving?: IExtendedStorageTransaction,
  runtime?: Runtime,
  markIfcCrossings?: boolean,
): boolean {
  if (value1 === undefined && value2 === undefined) return false;

  // If both are the same object, they're equal
  if (value1 === value2) return true;

  // If either is null/undefined, they're only equal if both are
  if (!value1 || !value2) return value1 === value2;

  // Try parsing both as links
  let link1 = parseLink(value1, base);
  let link2 = parseLink(value2, base);

  // If one parses and the other doesn't, they're not equal
  if (!link1 || !link2) return false;

  if (resolveBeforeComparing) {
    const tx = txForResolving;
    if (!tx) throw new Error("Provide tx to resolve before comparing");
    if (!runtime) {
      throw new Error("Provide runtime to resolve before comparing");
    }
    // Content-reading callers (a candidate comparison reads through the
    // links it resolves) opt into the ifc crossing seam; identity-only
    // callers leave it off.
    const options = markIfcCrossings ? { markIfcCrossings: true } : {};
    link1 = isNormalizedFullLink(link1)
      ? resolveLink(runtime, tx, link1, "value", options)
      : link1;
    link2 = isNormalizedFullLink(link2)
      ? resolveLink(runtime, tx, link2, "value", options)
      : link2;
  }

  // Compare normalized links
  return areNormalizedLinksSame(link1, link2);
}

export function areMaybeLinkAndNormalizedLinkSame(
  link: any,
  normalizedLink: NormalizedLink,
  base?: Cell | NormalizedLink,
): boolean {
  const normalizedLink2 = parseLink(link, base);
  if (!normalizedLink2) return false;
  return areNormalizedLinksSame(normalizedLink, normalizedLink2);
}

// Link identity (`areNormalizedLinksSame` and neighbors) lives in
// ./link-types.ts — one canonical implementation — and reaches importers of
// this module through the `export *` above.

// Successful externalization depends on schema documents registered during
// the current lease epoch. Frozen source schemas keep stable identity, so the
// external reference can be reused until that registry clears.
let externalizedLinkSchemaCache = new WeakMap<
  object,
  Map<KeepAsCell, JSONSchema>
>();
// Only complete closures produce cached values. The registry's retention
// lease bounds their reuse, and every lookup still checks closure availability.
let recomposedLinkSchemaCache = new WeakMap<JSONSchemaObj, JSONSchema>();
const schemaClosureLogger = getLogger("schema-closure");
onSchemaRegistryClear(() => {
  externalizedLinkSchemaCache = new WeakMap();
  recomposedLinkSchemaCache = new WeakMap();
});

/**
 * Replaces an inline schema with a reference to content-addressed schema
 * documents (`docs/specs/content-addressed-schemas.md`, Phases 1 and 2;
 * `contentAddressedSchemas` flag) — the shared emission for link schemas
 * and `$alias` binding schemas. Decomposition registers the closure in
 * the realm registry — in-session resolution works immediately — and the
 * commit pipeline materializes the documents into the destination space in
 * the same transaction as the write that carries the reference (the
 * write-side delivery guarantee). Input decomposition refuses stays inline,
 * exactly as with the flag off.
 */
export function externalizeSchema(schema: JSONSchemaObj): JSONSchema {
  try {
    const { rootRef, documents } = decomposeSchema(schema, {
      resolveDocument: lookupSchemaDocument,
    });
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }
    return internSchema({ $ref: rootRef });
  } catch (error) {
    if (error instanceof SchemaNotDecomposableError) return schema;
    throw error;
  }
}

/**
 * The self-contained schema a link carries across a space boundary. Its
 * external documents are loaded from the space holding the declaration;
 * the target space need not hold them. An incomplete declaration selects
 * nothing until its missing documents arrive. A declaration rejected by the
 * decomposer logs a warning and selects nothing.
 */
export function schemaForSpaceCrossing(
  tx: IExtendedStorageTransaction,
  sourceSpace: MemorySpace,
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (!containsExternalSchemaRef(schema)) return schema;
  if (!ensureExternalSchemaClosure(tx, sourceSpace, schema)) return false;
  const interned = internSchema(schema as JSONSchemaObj);
  const cached = recomposedLinkSchemaCache.get(interned);
  if (cached !== undefined) return cached;
  try {
    const { rootRef, documents } = decomposeSchema(interned, {
      resolveDocument: lookupSchemaDocument,
    });
    const result = recomposeSchema(rootRef, (hash) => documents.get(hash));
    recomposedLinkSchemaCache.set(interned, result);
    return result;
  } catch (error) {
    if (!(error instanceof SchemaNotDecomposableError)) throw error;
    schemaClosureLogger.warn("schema-closure", () => [
      "Link schema cannot be recomposed; it selects nothing:",
      sourceSpace,
      error.message,
    ]);
    return false;
  }
}

/**
 * Rewrites reference-form link schemas inside `value` back to their inline
 * (recomposed) form. A `data:` document is self-contained by construction —
 * the value lives in the id and no write ever installs anything alongside
 * it — so a link serialized into one carries its schema inline, exactly as
 * with the flag off. A reference whose closure the registry cannot supply
 * stays a reference; the traversal's loader gates that read either way.
 */
export function inlineExternalSchemaRefsInValue<T extends FabricValue>(
  value: T,
): T {
  return mapLinkSchemas(value, (schema) => {
    if (!isObjectNotArray(schema)) return schema;
    const ref = schema.$ref;
    if (typeof ref !== "string" || !isExternalSchemaRef(ref)) return schema;
    try {
      // Recomposition never mints an empty `$defs` (a closure of one
      // document returns the body alone), so the result rides as it is. A
      // schema document is plain JSON, hence a FabricValue.
      return internSchema(
        recomposeSchema(ref, lookupSchemaDocument),
      ) as FabricValue;
    } catch {
      return schema;
    }
  }) as T;
}

/**
 * Creates a sigil link, optionally a write redirect, with shared logic
 */
export function createSigilLinkFromParsedLink(
  link: NormalizedLink,
  options: {
    base?: Cell<any> | NormalizedFullLink;
    baseSpace?: MemorySpace;
    includeSchema?: boolean;
    overwrite?: "redirect" | "this"; // default is "this"
    // Which asCell entries to preserve in the included schema. When omitted,
    // streams are kept (see below) and all other asCell entries are stripped.
    keepAsCell?: KeepAsCell;
  } = {},
): SigilLink {
  // Create the base structure
  const sigil: SigilLink = linkRefFrom<CellLinkRefPayload>({
    path: link.path.map((p) => p.toString()),
  });

  const reference = linkRefPayload(sigil);

  // Handle base cell for relative references
  if (options.base) {
    const baseLink = isCell(options.base)
      ? options.base.getAsNormalizedFullLink()
      : options.base;

    // Only include id if it's different from base
    if (link.id !== baseLink.id) reference.id = toURI(link.id);

    // Only include space if it's different from base
    if (link.space && link.space !== baseLink.space) {
      reference.space = link.space;
    }
    if (link.scope && link.scope !== baseLink.scope) {
      reference.scope = link.scope;
    }
  } else {
    reference.id = link.id;

    // Handle baseSpace option - only include space if different from baseSpace
    if (link.space !== options.baseSpace) reference.space = link.space;
    if (link.scope) reference.scope = link.scope;
  }

  // Include schema if requested. Empty `{}` and JSON Schema `true` are
  // permissive and should not turn links into schema-bearing links.
  if (options.includeSchema && link.schema !== undefined) {
    // Default to keeping streams unless a broader mode was requested.
    const keepAsCell = options.keepAsCell ?? KeepAsCell.OnlyStream;
    const schema = getContentAddressedSchemasConfig()
      ? externalizeLinkSchema(link.schema, keepAsCell)
      : sanitizeSchemaForLinks(link.schema, keepAsCell);
    if (isNontrivialSchema(schema)) {
      reference.schema = schema;
    }
  }

  // Option overrides link value
  if (options.overwrite) {
    if (options.overwrite === "redirect") reference.overwrite = "redirect";
    // else: "this" is the default
  } else if (link.overwrite === "redirect") {
    reference.overwrite = "redirect";
  }

  return sigil;
}

/**
 * Returns `schema` stamped as a stream position: a `stream` entry at the
 * front of its `asCell` list, over the event schema the stream accepts. An
 * `asCell` entry the event schema already carries describes the event and
 * stays behind the stamp, which is the order the runtime reads a list of
 * kinds in. A schema whose front entry is already `stream` is returned as it
 * is; one that declares the stream only through a reference or a union is
 * stamped like any other, since the readers that mint a handle from a link's
 * schema look at its root alone. This is the declaration every link to a
 * stream carries, since the document behind a stream holds nothing that says
 * what the position is.
 *
 * The result is interned and remembered per input schema, so a stream
 * serialized again and again hands link serialization the same frozen
 * schema each time, which is what its own caches key on.
 */
export function declareStreamSchema(
  schema: JSONSchema | undefined,
): JSONSchema {
  if (schema === undefined || schema === true) {
    return UNTYPED_STREAM_SCHEMA;
  }
  if (schema === false) {
    return EVENTLESS_STREAM_SCHEMA;
  }
  if (
    ContextualFlowControl.getAsCellKind(
      ContextualFlowControl.getAsCellValues(
        resolveExternalRootRefForStructure(schema),
      ).at(0),
    ) === "stream"
  ) return schema;
  const remembered = declaredStreamSchemas.get(schema);
  if (remembered !== undefined) return remembered;
  const entries = Array.isArray(schema.asCell) ? schema.asCell : [];
  const declared = internSchema({
    ...schema,
    asCell: ["stream", ...entries],
  });
  declaredStreamSchemas.set(schema, declared);
  return declared;
}

const UNTYPED_STREAM_SCHEMA = internSchema({ asCell: ["stream"] });
const EVENTLESS_STREAM_SCHEMA = internSchema({
  not: true,
  asCell: ["stream"],
});
const declaredStreamSchemas = new WeakMap<object, JSONSchema>();

/**
 * Controls which `asCell` schema entries survive {@link sanitizeSchemaForLinks}.
 */
export enum KeepAsCell {
  // Strip all asCell entries (cell, opaque, and stream).
  None = "None",
  // Keep the asCell entry only when it's a stream.
  OnlyStream = "OnlyStream",
  // Keep the entire asCell entry (preserves cell, opaque, and stream).
  All = "All",
}

// Identity-keyed memo for `sanitizeSchemaForLinks` (see the function body).
// Values are always deep-frozen OBJECT schemas: boolean/undefined inputs take
// the early return and never reach the memo, and outputs are frozen before
// caching (their sub-trees are shared across callers).
//
// Dropped on the registry-clear transition, per the registry's rule for
// resolution-success memos: a sanitized result can EMBED references the
// strip minted (re-externalized sanitized documents), and those documents
// live in the epoch's registry. A result cached in one epoch would keep
// stamping references the next epoch's writer cannot stage — the link
// would ship without its closure, and the stored schema would go cold.
let _sanitizeCache = new WeakMap<
  object,
  Map<KeepAsCell, JSONSchema & object>
>();
onSchemaRegistryClear(() => {
  _sanitizeCache = new WeakMap();
});

/**
 * Traverse schema and remove all asCell flags.
 * Also handles circular references by using JSON Schema $ref.
 *
 * When circular references are detected, they are extracted to a $defs
 * section and replaced with $ref pointers. This ensures the output can
 * be safely serialized with JSON.stringify without exponential growth
 * or circular reference errors.
 */
export function sanitizeSchemaForLinks(
  schema: JSONSchema,
  keepAsCell?: KeepAsCell,
): JSONSchema;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell?: KeepAsCell,
): JSONSchema | undefined;
export function sanitizeSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell: KeepAsCell = KeepAsCell.None,
): JSONSchema | undefined {
  return sanitizeSchemaForLinksInternal(schema, keepAsCell, false);
}

/**
 * Sanitize a link schema and return its canonical frozen instance. Binding
 * callers already intern their result; reuse the cached frozen strip instead
 * of cloning its root and hashing that clone on every binding.
 */
export function sanitizeAndInternSchemaForLinks(
  schema: JSONSchema,
  keepAsCell?: KeepAsCell,
): JSONSchema;
export function sanitizeAndInternSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell?: KeepAsCell,
): JSONSchema | undefined;
export function sanitizeAndInternSchemaForLinks(
  schema: JSONSchema | undefined,
  keepAsCell: KeepAsCell = KeepAsCell.None,
): JSONSchema | undefined {
  return sanitizeSchemaForLinksInternal(schema, keepAsCell, true);
}

function sanitizeSchemaForLinksInternal(
  schema: JSONSchema | undefined,
  keepAsCell: KeepAsCell,
  canonical: boolean,
): JSONSchema | undefined {
  if (schema === undefined || typeof schema === "boolean") {
    return schema;
  }
  // A reference-form schema sanitizes as its resolved document: the strip is
  // a structural operation, and letting a reference pass through unstripped
  // would carry `asCell` entries into stored link schemas the flag-off
  // sanitize removed — a reader would mint handles where values are
  // expected. The sanitized (inline) result re-externalizes at the emission
  // site as usual; an unresolvable reference passes through unchanged (the
  // helper returns it as it is, and a reference has nothing to strip).
  const missesBefore = externalResolutionMissCount();
  schema = resolveExternalRootRefForStructure(schema);

  // Memoize complete resolutions by input identity and stripping mode within
  // a registry epoch. At pattern-build time the same interned/frozen
  // schema is sanitized repeatedly — measured ~46% of calls repeat a frozen
  // input, carrying ~half of the total strip time. Only deep-frozen inputs are
  // memoized (a mutable input's identity could go stale), matching the
  // identity-keyed-memo guard `traverse.ts` uses; `isDeepFrozen` is O(1) for the
  // already-frozen/cached inputs we hit here. The cache holds a deep-frozen
  // result. The mutable API returns a fresh shallow clone because reactive
  // callers can depend on its top-level identity. Binding callers request the
  // canonical result and can reuse both its identity and its cached hash.
  // A missing external document can change the result when it arrives, so
  // only complete resolutions enter the cache.
  const memoizable = isDeepFrozen(schema);
  if (memoizable) {
    const hit = _sanitizeCache.get(schema)?.get(keepAsCell);
    if (hit !== undefined) return canonical ? internSchema(hit) : { ...hit };
  }

  // Collect existing $defs names to avoid collisions
  const existingDefNames = new Set<string>();
  if ("$defs" in schema) {
    const existingDefs = schema.$defs;
    if (existingDefs && typeof existingDefs === "object") {
      for (const name of Object.keys(existingDefs)) {
        existingDefNames.add(name);
      }
    }
  }

  // Context for tracking circular references and generating $defs
  const context: SanitizeContext = {
    seen: new Map(),
    inProgress: new Set(),
    defs: {},
    defCounter: 0,
    reservedNames: existingDefNames,
    keepAsCell,
  };

  const stripped = recursiveStripAsCellFromSchema(schema, context, 0);

  // If we generated any $defs, add them to the root schema (merging existing).
  const output = Object.keys(context.defs).length > 0
    ? {
      ...stripped,
      $defs: { ...(stripped?.$defs || {}), ...context.defs },
    }
    : stripped;

  if (memoizable && externalResolutionMissCount() === missesBefore) {
    let byMode = _sanitizeCache.get(schema);
    if (byMode === undefined) {
      byMode = new Map();
      _sanitizeCache.set(schema, byMode);
    }
    // Deep-freeze the cached result: both APIs share this sub-tree across
    // callers, so a consumer mutating a nested node
    // would otherwise silently poison every later same-schema build — frozen,
    // such a mutation throws loudly instead. Freezing only touches objects this
    // call built: the strip rebuilds every node, and its depth-capped bail
    // returns sub-trees of the input, which is deep-frozen on this path.
    const frozen = deepFreeze(output) as JSONSchema & object;
    byMode.set(keepAsCell, frozen);
    return canonical ? internSchema(frozen) : { ...frozen };
  }

  return canonical ? deepFrozenCloneAndInternSchema(output) : output;
}

/** Sanitizes and externalizes a link schema, memoizing frozen inputs. */
function externalizeLinkSchema(
  schema: JSONSchema,
  keepAsCell: KeepAsCell,
): JSONSchema {
  const cacheable = isObjectOrArray(schema) && isDeepFrozen(schema);
  const cached = cacheable
    ? externalizedLinkSchemaCache.get(schema)?.get(keepAsCell)
    : undefined;
  if (cached !== undefined) return cached;
  const missesBefore = externalResolutionMissCount();
  const sanitized = sanitizeSchemaForLinks(schema, keepAsCell);
  if (!isObjectNotArray(sanitized) || !isNontrivialSchema(sanitized)) {
    return sanitized;
  }
  const externalized = externalizeSchema(sanitized);
  if (
    cacheable && externalResolutionMissCount() === missesBefore &&
    isObjectNotArray(externalized) &&
    typeof externalized.$ref === "string" &&
    isExternalSchemaRef(externalized.$ref)
  ) {
    let byMode = externalizedLinkSchemaCache.get(schema);
    if (byMode === undefined) {
      byMode = new Map();
      externalizedLinkSchemaCache.set(schema, byMode);
    }
    byMode.set(keepAsCell, externalized);
  }
  return externalized;
}

interface SanitizeContext {
  // Maps original schema objects to their processed results
  seen: Map<any, any>;
  // Tracks schemas currently being processed (for cycle detection)
  inProgress: Set<any>;
  // Accumulated $defs for circular schemas
  defs: Record<string, any>;
  // Counter for generating unique def names
  defCounter: number;
  // Reserved def names (from existing $defs in input schema)
  reservedNames: Set<string>;
  // Which asCell entries to preserve while stripping.
  keepAsCell: KeepAsCell;
}

/**
 * Recursively strips asCell flags from a JSON schema.
 * This also ensures there are no circular references in the output schema
 * by using $ref and $defs.
 *
 * @param schema
 * @param context
 * @param depth
 * @returns
 */
function recursiveStripAsCellFromSchema(
  schema: any,
  context: SanitizeContext,
  depth: number,
): any {
  // Handle null/undefined/boolean schemas
  if (
    !isObjectOrArray(schema) ||
    typeof schema === "boolean"
  ) {
    return schema;
  }

  // Prevent infinite recursion from proxy objects or very deep schemas
  // JSON Schema shouldn't need more than ~50 levels of nesting in practice
  if (depth > 100) return schema;

  // A NESTED reference-form schema stays a reference, but the strip must
  // reach THROUGH it: the referenced closure may carry `asCell`, and a
  // reference left unexamined would reintroduce it the moment a reader
  // resolves it — visibly clean, actually not. The referenced document
  // sanitizes through the whole pipeline (its own cycles, its own memo); a
  // document the strip leaves untouched keeps the reference verbatim, and
  // one it changes re-externalizes to the sanitized closure, so only the
  // target moves. Siblings stay on the node and strip in the walk below.
  // A member of a cyclic group sanitizes as its body carrying the group's
  // `$defs`, so the group's cycles are local refs the walk below handles and
  // the whole group re-externalizes with it. External references are
  // hash-based, so document-to-document recursion cannot cycle; an
  // unresolvable reference passes through unchanged, as at the root.
  const nestedRef = (schema as { $ref?: unknown }).$ref;
  if (typeof nestedRef === "string" && isExternalSchemaRef(nestedRef)) {
    const bare = internSchema({ $ref: nestedRef }) as JSONSchemaObj;
    const resolved = resolveExternalCfcSchemaRefAsDocument(nestedRef);
    if (resolved !== undefined && isObjectNotArray(resolved)) {
      const sanitizedDoc = sanitizeSchemaForLinks(
        resolved,
        context.keepAsCell,
      );
      const target =
        internSchema(sanitizedDoc as JSONSchemaObj) === internSchema(resolved)
          ? bare
          : externalizeSchema(internSchema(sanitizedDoc as JSONSchemaObj));
      const { $ref: _nested, ...siblings } = schema as Record<string, unknown>;
      schema = Object.keys(siblings).length > 0 && isObjectNotArray(target)
        ? { ...siblings, ...target }
        : target;
    }
  }

  // If we've already fully processed this schema, return the result
  if (context.seen.has(schema) && !context.inProgress.has(schema)) {
    return context.seen.get(schema);
  }

  // Cycle detection: if we're currently processing this schema, we have a cycle
  if (context.inProgress.has(schema)) {
    // Generate a unique name for this circular schema, avoiding collisions
    let defName: string;
    do {
      defName = `CircularSchema_${context.defCounter++}`;
    } while (context.reservedNames.has(defName) || defName in context.defs);

    // Create a $ref to the definition we'll create
    const ref = { $ref: `#/$defs/${defName}` };

    // Store the ref as the result for this schema
    // The actual definition will be added when we finish processing
    context.seen.set(schema, ref);

    return ref;
  }

  // Mark as in-progress
  context.inProgress.add(schema);

  let result;
  // Shallow copy — only top-level keys are deleted/replaced; children are
  // handled by recursive calls that create their own copies.
  if (context.keepAsCell === KeepAsCell.All) {
    result = { ...schema };
  } else {
    const { asCell: _c, ...restSchema } = schema;
    const asCellValues = ContextualFlowControl.getAsCellValues(schema);
    // If we're keeping streams and the outermost is a stream, keep it
    if (
      context.keepAsCell === KeepAsCell.OnlyStream &&
      ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
    ) {
      result = { asCell: asCellValues, ...restSchema };
    } else {
      result = restSchema;
    }
    // Do NOT promote the stripped asCell entry's scope onto the resulting
    // schema's top-level `scope`. The scope of an asCell value belongs to the
    // link to its target (which carries its own scope) and acts as a follow cap;
    // promoting it here makes it look like an authored container scope, which is
    // then stamped onto the *container* link on reads, addressing the wrong
    // scoped instance (the read lands on an empty narrower instance). See
    // CT-1623.
  }

  // Recursively process all object properties
  //
  // TODO(danfuzz): this loop filters by key name only, so it also descends
  // into `default` and `examples` VALUES, and rewrites whatever schema
  // keywords it finds spelled inside one. Value-bearing keys want to be
  // carried by reference, the way `simplifySchemaForContext` preserves them.
  for (const [key, value] of Object.entries(result)) {
    // Skip $ref - it's just a string pointer, not a schema to process
    if (key === "$ref") continue;

    // A fabric value is carried by reference: the rebuild below reads it by
    // property name and would return `{}`, so a fabric-valued default (which
    // `Cell.of()` embeds into schemas) would be lost from the sanitized
    // schema that rides on links.
    if (isWalkableObjectOrArray(value)) {
      if (key === "$defs") {
        // Process each definition in $defs (they contain schemas that may have asCell/asStream)
        const processedDefs: Record<string, any> = {};
        for (
          const [defName, defSchema] of Object.entries(
            value as Record<string, any>,
          )
        ) {
          if (isWalkableObjectOrArray(defSchema)) {
            processedDefs[defName] = recursiveStripAsCellFromSchema(
              defSchema,
              context,
              depth + 1,
            );
          } else {
            processedDefs[defName] = defSchema;
          }
        }
        result[key] = processedDefs;
      } else if (Array.isArray(value)) {
        // Handle arrays
        result[key] = value.map((item) =>
          isWalkableObjectOrArray(item)
            ? recursiveStripAsCellFromSchema(
              item,
              context,
              depth + 1,
            )
            : item
        );
      } else {
        // Handle objects
        result[key] = recursiveStripAsCellFromSchema(
          value,
          context,
          depth + 1,
        );
      }
    }
  }

  // Stream properties will be removed if didn't keep streams, so we need to
  // remove them from required if present.
  if (context.keepAsCell === KeepAsCell.None) {
    removeStrippedStreamPropertiesFromRequired(schema, result, context);
  }

  // Check if this schema was marked as circular while processing
  const existingRef = context.seen.get(schema);
  if (existingRef && existingRef.$ref) {
    // This schema is part of a cycle - add it to $defs
    const defName = existingRef.$ref.replace("#/$defs/", "");
    context.defs[defName] = result;
  }

  // Mark as done and store result
  context.inProgress.delete(schema);
  context.seen.set(schema, result);

  return result;
}

function schemaLosesStreamCellMarker(
  schema: unknown,
  context: SanitizeContext,
): boolean {
  if (context.keepAsCell === KeepAsCell.All || !isObjectOrArray(schema)) {
    return false;
  }

  const asCellValues = ContextualFlowControl.getAsCellValues(schema);
  const hasStreamMarker = asCellValues.some((entry) =>
    ContextualFlowControl.getAsCellKind(entry) === "stream"
  );
  if (!hasStreamMarker) return false;

  return !(
    context.keepAsCell === KeepAsCell.OnlyStream &&
    ContextualFlowControl.getAsCellKind(asCellValues.at(0)) === "stream"
  );
}

function removeStrippedStreamPropertiesFromRequired(
  originalSchema: unknown,
  result: unknown,
  context: SanitizeContext,
): void {
  if (!isObjectOrArray(originalSchema) || !isObjectOrArray(result)) return;
  const properties = originalSchema.properties;
  if (!isObjectOrArray(properties)) return;
  if (!Array.isArray(result.required)) return;

  const required = result.required.filter((property) =>
    typeof property !== "string" ||
    !schemaLosesStreamCellMarker(
      properties[property],
      context,
    )
  );

  if (required.length === 0) {
    delete result.required;
  } else {
    result.required = required;
  }
}

/** Get or create a cell using the resultCell as the cause. */
export function getMetaCell(
  resultCell: AnyCell<unknown>,
  type: "internal" | "argument",
  tx: IExtendedStorageTransaction,
  schema?: JSONSchema,
): Cell {
  const metaCause = { type, parent: resultCell };
  const resultCellLink = resultCell.getAsNormalizedFullLink();
  const metaLink = {
    space: resultCellLink.space,
    id: toURI(createRef({}, metaCause)),
    path: [],
    ...(resultCellLink.scope !== undefined && { scope: resultCellLink.scope }),
    ...(schema !== undefined && { schema }),
  };
  return resultCell.runtime.getCellFromLink(metaLink, undefined, tx);
}

export function getDerivedInternalCellLink(
  resultCell: AnyCell<unknown>,
  descriptor: DerivedInternalCellDescriptor,
): NormalizedFullLink {
  const resultCellLink = resultCell.getAsNormalizedFullLink();
  const parent = resultCell.entityId ?? resultCell;
  return {
    space: resultCellLink.space,
    // The kind's ONLY representation is the URI scheme applied here by
    // toURI; the hash preimage is kind-free, so this mint site is the single
    // place a computed identity is established.
    id: toURI(
      createRef(
        {},
        {
          parent,
          type: "internal",
          cause: descriptor.partialCause,
        },
      ),
      descriptor.kind,
    ),
    path: [],
    scope: descriptor.scope ?? resultCellLink.scope,
    ...(descriptor.schema !== undefined && { schema: descriptor.schema }),
  };
}

export function getStableInternalPathSegment(
  cause: unknown,
): PropertyKey | undefined {
  if (
    typeof cause === "string" ||
    typeof cause === "number" ||
    typeof cause === "symbol"
  ) {
    return cause;
  }

  if (cause !== undefined) {
    if (isObjectOrArray(cause) && "stream" in cause) {
      return `stream:${formatStableCauseSegment(cause.stream as JSONValue)}`;
    }
    return formatStableCauseSegment(cause as JSONValue);
  }

  return undefined;
}

function formatStableCauseSegment(cause: JSONValue): string {
  if (typeof cause === "string") return cause;
  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    cause === null
  ) {
    return String(cause);
  }

  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

export function getDerivedInternalCell(
  resultCell: Cell,
  descriptor: DerivedInternalCellDescriptor,
  tx?: IExtendedStorageTransaction,
): Cell {
  return resultCell.runtime.getCellFromLink(
    getDerivedInternalCellLink(resultCell, descriptor),
    descriptor.schema,
    tx,
  );
}

const META_READ_OPTIONS = {
  meta: ignoreReadForScheduling,
} as const;

/**
 * Our internal and argument cells are linked to by the result cell.
 * This gets those links from the meta fields, and returns a link if present.
 *
 * By default, the meta reads are ignored for scheduling, and the schema
 * will be frozen.
 */
export function getMetaLink(
  resultCell: Cell<unknown>,
  field: MetaLinkField,
  options: IReadOptions = META_READ_OPTIONS,
): NormalizedFullLink | undefined {
  const linkObj = resultCell.getMetaRaw(field, options);
  if (linkObj === undefined) return undefined;
  const link = parseLink(linkObj, resultCell);
  return link;
}

/**
 * The schema under which the owner of the document `cell` names declares it
 * a stream, or `undefined` when no owner does.
 *
 * A stream's document holds only the `result` back-link setup writes onto
 * it, so an address that names the document alone says nothing about it:
 * there is no stored link hop to carry a declaration, and the caller brought
 * no schema. The declaration is on the owner, in the manifest link its result
 * document keeps for each derived internal cell, and this follows the
 * back-link to read it there. A cell below a document's root, or one whose
 * document names no owner, is declared by no one. The schema returned is the
 * manifest link's own, so it carries the event schema the stream was declared
 * with beside the declaration.
 */
export function ownerStreamSchema(
  cell: Cell<unknown>,
): JSONSchema | undefined {
  const target = cell.getAsNormalizedFullLink();
  if (target.path.length > 0) return undefined;
  const ownerLink = getMetaLink(cell, "result");
  if (ownerLink === undefined) return undefined;
  const owner = cell.runtime.getCellFromLink(
    { ...ownerLink, path: [], schema: undefined },
    undefined,
    cell.tx,
  );
  const manifest = owner.getMetaRaw("internal", META_READ_OPTIONS);
  if (!Array.isArray(manifest)) return undefined;
  for (const entry of manifest) {
    if (!isObjectNotArray(entry)) continue;
    const link = parseLink(entry.link, owner);
    if (
      link !== undefined && areNormalizedLinksSame(link, target) &&
      ContextualFlowControl.declaresStream(link.schema)
    ) return link.schema;
  }
  return undefined;
}
