/**
 * What a schema declares about the handle at its root, read the one way
 * every reader reads it. A stream's document stores nothing that says what
 * it is: the declaration is on the schema of a link that names the stream —
 * the manifest link its owner keeps for it among them — so a reader that
 * has to tell a stream from a value reads a schema, and this module is that
 * reading. It carries none of the runtime, so a reader holding stored
 * documents and no live cells can take it as it is; the one thing that
 * differs between the two, how an external schema reference is resolved,
 * arrives as a function.
 */

import type {
  AsCellEntry,
  CellKind,
  JSONSchema,
  JSONSchemaObj,
} from "@commonfabric/api";
import {
  isExternalSchemaRef,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { decodeJsonPointer } from "@commonfabric/utils/json-pointer";
import { isObjectOrArray } from "@commonfabric/utils/types";

/** The handle kind `schema` declares by its own root `asCell`, if any. */
function rootAsCellKind(schema: JSONSchema | undefined): CellKind | undefined {
  if (!isObjectOrArray(schema) || !Array.isArray(schema.asCell)) {
    return undefined;
  }
  const front = schema.asCell[0] as AsCellEntry | undefined;
  return typeof front === "string" ? front : front?.kind;
}

/**
 * The definition name a `#/$defs/<name>` reference names, or `undefined` for
 * any other reference.
 */
export function localDefinitionName(ref: string): string | undefined {
  if (!ref.startsWith("#")) return undefined;
  const path = decodeJsonPointer(ref);
  return path.length === 3 && path[0] === "#" && path[1] === "$defs" &&
      path[2] !== ""
    ? path[2]
    : undefined;
}

/**
 * The definition `root` carries under `name` in its `$defs`, or `undefined`
 * where it carries none, or carries something there that is not a schema.
 */
export function definitionNamed(
  root: JSONSchema | undefined,
  name: string,
): JSONSchema | undefined {
  if (!isObjectOrArray(root)) return undefined;
  const defs = root.$defs;
  if (!isObjectOrArray(defs) || !Object.hasOwn(defs, name)) return undefined;
  const definition = (defs as Record<string, unknown>)[name];
  return isObjectOrArray(definition) || typeof definition === "boolean"
    ? definition as JSONSchema
    : undefined;
}

/**
 * The definition a `#/$defs/<name>` reference names in `root`, or `undefined`
 * for any other reference or a name `root` does not define. A miss is quiet:
 * this is asked of every position a read passes, and most carry no `$defs`
 * closure at all.
 */
export function localDefinition(
  root: JSONSchema | undefined,
  ref: string,
): JSONSchema | undefined {
  const name = localDefinitionName(ref);
  return name === undefined ? undefined : definitionNamed(root, name);
}

/**
 * What an external schema reference resolved to: the schema it names, and
 * the document the local references inside that schema resolve against —
 * the referenced document itself, whose `$defs` those references name.
 */
export interface ResolvedExternalReference {
  readonly schema: JSONSchema;

  /** The document a local `$ref` in `schema` names a definition of. */
  readonly root: JSONSchema;
}

/**
 * Resolves a schema whose root `$ref` is an external (`cid:`) reference,
 * given the schema carrying it. `undefined` where the reference names
 * nothing the reader can supply, and where the reader refuses the schema's
 * form; either way the position declares nothing. The runtime answers this
 * from its schema registry, and a reader over stored documents from the
 * documents it holds, through {@link externalReferenceResolverOver}.
 */
export type ExternalReferenceResolver = (
  schema: JSONSchemaObj,
) => ResolvedExternalReference | undefined;

/**
 * An {@link ExternalReferenceResolver} over `readSchemaDocument`, which
 * supplies a schema document's value by its tagged hash. A reference resolves
 * to the document it names, or to the `#/$defs/<name>` member of it where the
 * fragment names one, with the keywords written beside the `$ref` read over
 * what it resolved to: that is how the runtime reads a reference with
 * siblings, and the document is what the local references inside it name
 * definitions of. A reference naming no document the reader supplies, or a
 * member the document does not carry, resolves to nothing.
 *
 * A keyword beside the reference is read over the target as written. The
 * runtime goes further for one carrying a local reference of its own, whose
 * definitions belong to the referring document rather than the referenced one;
 * a declaration is a root keyword, so that case does not reach the reading
 * this serves.
 */
export function externalReferenceResolverOver(
  readSchemaDocument: (taggedHash: string) => JSONSchema | undefined,
): ExternalReferenceResolver {
  return (schema) => {
    const { $ref, ...siblings } = schema;
    const parsed = parseExternalSchemaRef($ref as string);
    if (parsed === undefined) return undefined;
    const root = readSchemaDocument(parsed.taggedHash);
    if (root === undefined) return undefined;
    const target = parsed.defName === undefined
      ? root
      : definitionNamed(root, parsed.defName);
    if (target === undefined) return undefined;
    const schemaRead = isObjectOrArray(target) && Object.keys(siblings).length
      ? { ...target, ...siblings } as JSONSchema
      : target;
    return { schema: schemaRead, root };
  };
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
