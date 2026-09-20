/**
 * What a schema declares about the handle at its root, read the one way
 * every reader reads it. A stream's document stores nothing that says what
 * it is: the declaration is on the schema of a link that names the stream —
 * the manifest link its owner keeps for it among them — so a reader that
 * has to tell a stream from a value reads a schema, and this module is that
 * reading. It carries none of the runtime, so a reader holding stored
 * documents and no live cells can take it as it is; the one thing that
 * differs between the two, how an external schema reference is resolved,
 * arrives as a function. The readings it is built on — a local definition,
 * an external reference — are `cfc/schema-primitives.ts`.
 */

import type {
  AsCellEntry,
  CellKind,
  JSONSchema,
  JSONSchemaObj,
} from "@commonfabric/api";
import { isExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  type ExternalReferenceResolver,
  localDefinition,
} from "./cfc/schema-primitives.ts";

/** The handle kind `schema` declares by its own root `asCell`, if any. */
function rootAsCellKind(schema: JSONSchema | undefined): CellKind | undefined {
  if (!isObjectOrArray(schema) || !Array.isArray(schema.asCell)) {
    return undefined;
  }
  const front = schema.asCell[0] as AsCellEntry | undefined;
  return typeof front === "string" ? front : front?.kind;
}

/** What a reading of a declaration is given besides the schema. */
export interface DeclarationReading {
  /**
   * The document local `$ref`s resolve against. Defaults to the schema
   * itself, which a link's schema is self-contained enough for, and moves to
   * the resolved document when an external reference is followed.
   */
  readonly root?: JSONSchema;

  /**
   * How an external reference is followed. Without one, a position declared
   * through an external reference declares nothing.
   */
  readonly resolveExternal?: ExternalReferenceResolver;
}

/**
 * What following every external reference from the root of a schema reaches:
 * the schema at the end of the chain, the document its local references
 * resolve against, and the references followed to get there, in order.
 */
export interface FollowedReferences {
  readonly schema: JSONSchema;

  /** The document a local `$ref` in `schema` names a definition of. */
  readonly root: JSONSchema;

  /** Each external `$ref` followed, from the first; none for a schema whose root carries no external reference. */
  readonly followed: readonly string[];
}

/**
 * Follows the external reference at the root of `schema`, and at the root of
 * whatever that resolves to, until a schema with none is reached: a schema
 * document's value can itself be a reference, as one that decomposition left
 * as a wrapper around another is. `undefined` where a reference does not
 * resolve, and where the chain returns to a reference already followed.
 */
export function followExternalReferences(
  schema: JSONSchema | undefined,
  reading: DeclarationReading = {},
): FollowedReferences | undefined {
  let root = reading.root ?? schema;
  let current = schema;
  const followed: string[] = [];
  while (
    isObjectOrArray(current) && typeof current.$ref === "string" &&
    isExternalSchemaRef(current.$ref)
  ) {
    if (followed.includes(current.$ref)) return undefined;
    // The guard established an object carrying a string `$ref`, which is
    // the shape the resolver is typed over.
    const external = reading.resolveExternal?.(current as JSONSchemaObj);
    if (external === undefined) return undefined;
    followed.push(current.$ref);
    current = external.schema;
    root = external.root;
  }
  return current === undefined || root === undefined
    ? undefined
    : { schema: current, root, followed };
}

/**
 * The kind of handle `schema` declares at its root, read through a root
 * `$ref` — external, or into the root's own `$defs` — and through a
 * composition whose branches agree: `allOf` declares what any of its branches
 * declares, and `anyOf`/`oneOf` what every branch declares, since the value
 * may be any of them. `undefined` where nothing is declared, or where the
 * branches disagree, or where a reference does not resolve.
 *
 * `active` is the descent under way. It stops a reference from being followed
 * back into itself; a definition two sibling branches share is read once for
 * each, since the first branch has left it by the time the second arrives.
 */
export function declaredHandleKind(
  schema: JSONSchema | undefined,
  reading: DeclarationReading = {},
  active: Set<object> = new Set(),
): CellKind | undefined {
  if (!isObjectOrArray(schema) || active.has(schema)) return undefined;
  active.add(schema);
  try {
    const reached = followExternalReferences(schema, reading);
    if (reached === undefined) return undefined;
    const { root, schema: resolved } = reached;
    if (!isObjectOrArray(resolved)) return undefined;
    const direct = rootAsCellKind(resolved);
    if (direct !== undefined) return direct;
    const below = (branch: JSONSchema | undefined): CellKind | undefined =>
      declaredHandleKind(
        branch,
        { root, resolveExternal: reading.resolveExternal },
        active,
      );
    if (typeof resolved.$ref === "string") {
      return below(localDefinition(root, resolved.$ref));
    }
    const agreed = (
      branches: unknown,
      every: boolean,
    ): CellKind | undefined => {
      if (!Array.isArray(branches) || branches.length === 0) return undefined;
      let kind: CellKind | undefined;
      for (const branch of branches) {
        const declared = below(branch as JSONSchema);
        if (declared === undefined) {
          if (every) return undefined;
          continue;
        }
        if (kind !== undefined && kind !== declared) return undefined;
        kind = declared;
      }
      return kind;
    };
    return agreed(resolved.allOf, false) ?? agreed(resolved.anyOf, true) ??
      agreed(resolved.oneOf, true);
  } finally {
    active.delete(schema);
  }
}

/**
 * Whether `schema` declares a stream position: the handle kind it declares
 * ({@link declaredHandleKind}) is `stream`. Such a position holds no value,
 * and its handle is minted from the schema alone.
 */
export function declaresStream(
  schema: JSONSchema | undefined,
  resolveExternal?: ExternalReferenceResolver,
): boolean {
  return declaredHandleKind(schema, { resolveExternal }) === "stream";
}
