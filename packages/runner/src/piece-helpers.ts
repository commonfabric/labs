import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";

import { getLogger } from "../../utils/src/logger.ts";
// Relative import (not "@commonfabric/utils/types") for the same rollup
// reason as traverse.ts.
import { isObjectOrArray } from "../../utils/src/types.ts";
import type { JSONSchema, Pattern } from "./builder/types.ts";
import { type Cell, cellRuntime, cellTx, isCell } from "./cell.ts";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "./cfc.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./cfc/schema-refs.ts";
import { isEmbeddedCfcSchemaRef } from "./embedded-schemas.ts";
import type { RuntimeProgram } from "./harness/types.ts";
import { resolveLink } from "./link-resolution.ts";
import { isSigilLink, linkPathSegmentToCellPathSegment } from "./link-types.ts";
import { parseLink } from "./link-utils.ts";
import { readResultSchemaMeta } from "./result-schema-meta.ts";
import type { Runtime } from "./runtime.ts";
import { DEFAULT_CELL_SCOPE, scopeRank } from "./scope.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";

const logger = getLogger("piece-helpers");

export type CellPath = (string | number)[];

/**
 * Splits a slash-separated cell path into its segments, converting each one
 * through {@link linkPathSegmentToCellPathSegment} so that a path written on
 * the command line addresses the same cells as the same path embedded in a
 * reference. An empty path is no segments at all.
 */
export function parseCellPath(path: string): CellPath {
  if (!path || path.trim() === "") {
    return [];
  }
  return path.split("/").map(linkPathSegmentToCellPathSegment);
}

/** Reads a path through the root projection, preserving ancestor branch choices. */
export function resolveCellPath<T>(
  cell: Cell<T>,
  path: CellPath,
  options: { requireProjection?: boolean } = {},
): unknown {
  let currentCell: Cell<unknown> = cell;
  let value: unknown = cell.get();
  for (const [index, segment] of path.entries()) {
    if (isCell(value)) {
      currentCell = value;
      value = value.get();
    }
    currentCell = currentCell.key(segment);
    if (value === undefined && !options.requireProjection) {
      // A sparse root can fail to materialize while a selected child is
      // readable. Correlated schemas require a matching root projection.
      value = currentCell.get();
      if (value !== undefined || index < path.length - 1) continue;
    }
    if (value != null && typeof value !== "object") {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered non-object at "${segment}"`,
      );
    }
    if (value == null || !Object.hasOwn(value, segment)) {
      const availableKeys = isObjectOrArray(value)
        ? Object.keys(value).filter((key) => !key.startsWith("$")).sort()
        : [];
      const hint = availableKeys.length > 0
        ? `. Available keys: ${availableKeys.join(", ")}`
        : "";
      throw new Error(
        `Cannot access path "${path.join("/")}" - property "${
          String(segment)
        }" not found${hint}`,
      );
    }
    // Descend the materialized parent. Narrowing the original cell again
    // would discard the branch selected by that parent's current value.
    value = (value as Record<string | number, unknown>)[segment];
  }
  return isCell(value) ? value.get() : value;
}

export function cellEntityIdString(cell: Cell<unknown>): string | undefined {
  const id = cell.entityId;
  return isEntityRef(id) ? entityRefToString(id) : undefined;
}

/**
 * Derive a read-time projection schema in which `required` no longer claims
 * properties whose STORED value is a link into a narrower-than-space scope
 * (user/session).
 *
 * Why: pattern result schemas mark every output property `required`, but an
 * output derived from a scoped cell lives in a session/user-scoped doc that
 * only the owning session can materialize. For every other session the strict
 * schema projection finds the required property unresolvable and voids the
 * ENTIRE object (`traverseObjectWithSchema`'s required check) — so a path-less
 * piece read returns `undefined` while every child-path read works. Per the
 * #4746 contract, partial visibility must be expressed in the schema rather
 * than special-cased in the traverser; piece reads apply this helper at both
 * the root and a selected subtree boundary, driven by the stored links' own
 * declared scopes.
 *
 * Also relaxed: a property whose chain resolution is SCOPE-BLOCKED (a schema
 * scope cap forbade following a narrower link, CT-1642) — the member is just
 * as unreachable for this read as a plainly narrow terminal.
 *
 * Deliberately NOT relaxed: plain (non-link) missing properties, properties
 * whose links resolve entirely within space scope, and anything inside
 * arrays (#4746 restored strict required semantics for array elements;
 * nothing here reopens that). Recurses only through inline records — links
 * are boundaries.
 *
 * Known structural limits (both degrade to the pre-existing strict void, and
 * both are properly fixed by the schema-generator emitting honest
 * optionality for scoped-derived outputs): (1) a space-scoped link to a doc
 * whose OWN schema requires a scoped member still voids that doc's read —
 * the traverser combines schemas across link hops and `required` survives
 * from either side, so a boundary-derived relaxation cannot reach it;
 * (2) a result doc whose root value is itself a link is left unrelaxed for
 * the same combine reason.
 *
 * Returns the input schema by reference when there is nothing to relax, so
 * schema identity (and downstream hash caching) is preserved.
 */
export function schemaWithScopedLinkRequiredsRelaxed(
  schema: JSONSchema | undefined,
  rawValue: unknown,
  base: Cell<unknown>,
  tx?: IExtendedStorageTransaction,
  root?: JSONSchema,
): JSONSchema | undefined {
  if (
    !isObjectOrArray(schema) || !isObjectOrArray(rawValue) ||
    isSigilLink(rawValue) ||
    Array.isArray(rawValue)
  ) {
    return schema;
  }

  // A schema at rest can be a content-addressed reference
  // (`docs/specs/content-addressed-schemas.md`), which carries no structure
  // to walk. Judge the relaxation on the resolved document; a reference
  // whose closure has not arrived stays a reference, which the walk below
  // finds nothing to relax in — the same conservative fallback as a chain
  // the resolver cannot complete. A member of a recursive group arrives as
  // a LOCAL pointer whose definitions live on the owning document the
  // recursion carries as `root`; resolving against it is what lets the
  // relaxation see `properties` and `required` inside a nested definition.
  // Either miss keeps the strict pre-existing behavior.
  let structural = resolveExternalRootRefForStructure(schema);
  let structuralRoot: JSONSchema;
  if (structural !== schema) {
    structuralRoot = structural;
  } else {
    // A local reference resolves against the document root, the rule every
    // CFC schema walker applies; a `$defs` below that root is inert. An
    // embedded reference (the renderer's vnode schema among them) is a
    // document of its own, and the root moves into it.
    structuralRoot = root ?? structural;
    const ref = (structural as { $ref?: unknown }).$ref;
    if (
      typeof ref === "string" &&
      (ref.startsWith("#") || isEmbeddedCfcSchemaRef(ref))
    ) {
      const resolved = ContextualFlowControl.resolveSchemaRefs(
        structural as Parameters<
          typeof ContextualFlowControl.resolveSchemaRefs
        >[0],
        structuralRoot,
      );
      if (!isObjectOrArray(resolved)) return schema;
      structuralRoot = cfcSchemaResolvedRoot(
        resolved,
        resolveCfcSchemaRefRoot(structural, structuralRoot),
      );
      structural = resolved;
    }
  }

  // One read tx per derivation, honoring the cell's own bound transaction so
  // the chain walk sees the same (possibly uncommitted) state getRaw() does.
  // Recursion into inline records threads it through.
  tx ??= cellRuntime(base).readTx(cellTx(base));

  // A scoped output does not carry its scope on the first link: the result
  // doc's property links (scope "space") redirect to an intermediate doc
  // whose value is the actual `{scope: "session"|"user"}` redirect into the
  // scoped instance. Resolve the stored link to its terminal target with the
  // standard resolver (real cycle detection, and the same fresh-replica pull
  // kick every read path uses) and inspect the terminal. Narrow means either
  // a terminal in a narrower-than-space scope, or a resolution the resolver
  // scope-blocked (a schema scope cap forbade following a narrower link,
  // CT-1642) — in both cases the member is unreachable for this read, which
  // is exactly what the relaxation expresses. (The blocked branch warns once
  // inside resolveLink during this derivation and again during the real
  // read; the duplication is accepted noise for a rare, already-loud case.)
  // A chain the resolver cannot complete (cycle, iteration limit) counts as
  // "not narrow" — the conservative fallback is the pre-existing strict
  // behavior.
  const isNarrowScopedLink = (value: unknown): boolean => {
    if (!isSigilLink(value)) return false;
    // Parsing against the containing cell resolves "inherit" to the
    // containing scope, so the normalized scope is always concrete.
    const first = parseLink(value, base);
    if (first === undefined) return false;
    if (
      scopeRank(first.scope ?? DEFAULT_CELL_SCOPE) >
        scopeRank(DEFAULT_CELL_SCOPE)
    ) {
      return true;
    }
    try {
      let blocked = false;
      const terminal = resolveLink(cellRuntime(base), tx!, first, "value", {
        onScopeBlocked: () => {
          blocked = true;
        },
      });
      return blocked ||
        scopeRank(terminal.scope ?? DEFAULT_CELL_SCOPE) >
          scopeRank(DEFAULT_CELL_SCOPE);
    } catch (error) {
      logger.debug("scoped-link-relax-chain", () => [
        "chain resolution failed; keeping strict required",
        first,
        error,
      ]);
      return false;
    }
  };

  let changed = false;

  let required = structural.required;
  if (Array.isArray(required)) {
    const kept = required.filter(
      (prop) =>
        typeof prop !== "string" ||
        !isNarrowScopedLink((rawValue as Record<string, unknown>)[prop]),
    );
    if (kept.length !== required.length) {
      required = kept;
      changed = true;
    }
  }

  let properties = structural.properties;
  if (isObjectOrArray(properties)) {
    let newProperties: Record<string, JSONSchema> | undefined;
    for (const [key, propSchema] of Object.entries(properties)) {
      const propValue = (rawValue as Record<string, unknown>)[key];
      // Links are boundaries: a linked doc's own read applies its own schema.
      if (isSigilLink(propValue)) continue;
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        propSchema as JSONSchema,
        propValue,
        base,
        tx,
        structuralRoot,
      );
      if (relaxed !== propSchema) {
        newProperties ??= { ...(properties as Record<string, JSONSchema>) };
        newProperties[key] = relaxed as JSONSchema;
      }
    }
    if (newProperties !== undefined) {
      properties = newProperties;
      changed = true;
    }
  }

  if (!changed) return schema;
  return {
    ...structural,
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
  } as JSONSchema;
}

/**
 * Return `cell` re-schema'd for a terminal object read, whether it is the piece
 * root or a selected subtree: `required` entries that point at
 * narrower-scoped stored links are relaxed via
 * {@link schemaWithScopedLinkRequiredsRelaxed}. Returns the cell unchanged when
 * it carries no schema, the raw value is unreadable, or nothing needed
 * relaxing.
 */
export function cellWithScopedLinkRequiredsRelaxed<T>(
  cell: Cell<T>,
): Cell<T> {
  const schema = cell.schema;
  if (schema === undefined) return cell;
  let raw: unknown;
  try {
    raw = cell.getRaw();
  } catch (error) {
    logger.debug("scoped-link-relax-raw", () => [
      "raw read failed; keeping strict schema",
      error,
    ]);
    return cell;
  }
  const relaxed = schemaWithScopedLinkRequiredsRelaxed(
    schema,
    raw,
    cell as Cell<unknown>,
  );
  return relaxed === schema ? cell : cell.asSchema<T>(relaxed);
}

/**
 * `cell` typed by its document's durable `schema` metadata (the result
 * schema its piece's setup wrote, in the inline form
 * `readResultSchemaMeta` supplies), narrowed to the cell's path. A cell
 * that already carries a schema keeps it.
 */
export function getResultCellWithSourceSchema<T = unknown>(
  cell: Cell<T>,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.schema === undefined) {
    const resultSchema = readResultSchemaMeta(cell);
    if (resultSchema !== undefined) {
      const schema = ContextualFlowControl.schemaAtPath(
        resultSchema,
        link.path,
      );
      return cell.asSchema<T>(schema);
    }
  }
  return cell;
}

/**
 * Compile a pattern into `space` and persist its content-addressed source +
 * compiled documents there (the awaited write-back inside `compilePattern`).
 * The compiled pattern carries its `{ identity, symbol }` entry ref, the single
 * durable pattern pointer; no separate meta-cell save is needed. (Formerly
 * `compileAndSavePattern`, which additionally wrote a now-deleted meta cell.)
 */
export async function compileAndSavePattern(
  runtime: Runtime,
  patternSrc: string | RuntimeProgram,
  options: {
    space: MemorySpace;
  },
): Promise<Pattern> {
  if (typeof patternSrc === "string") {
    patternSrc = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: patternSrc }],
    };
  }
  // Route through the content-addressed cell cache in the target space so the
  // compiled module set + source docs are written back (awaited) and reused on
  // subsequent loads (CT-1623).
  const pattern = await runtime.patternManager.compilePattern(patternSrc, {
    space: options.space,
  });
  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }

  return pattern;
}
