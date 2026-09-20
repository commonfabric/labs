/**
 * The readings of a schema that everything above builds on and that touch no
 * runtime: the two forms a schema comes in and the object each boolean means,
 * the definition a local reference names, and how an external reference is
 * read against the schema documents a reader holds. `schema-refs.ts` builds
 * its resolution over these and re-exports the ones it always exported; a
 * reader that holds stored documents and no runtime — the state inspector —
 * takes them from here.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { parseExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { decodeJsonPointer } from "@commonfabric/utils/json-pointer";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * The object form of `schema`: `true` and an absent schema admit everything,
 * which the empty object also does, and `false` admits nothing, which is the
 * negation of that. An object is itself.
 */
export const cfcSchemaToObject = (schema?: JSONSchema): JSONSchemaObj =>
  (schema === true || schema === undefined)
    ? {}
    : schema === false
    ? { not: true }
    : schema;

/**
 * Whether `key` is a keyword the runtime reads for itself rather than one
 * that constrains a value.
 */
export const cfcSchemaIsInternalKey = (key: string): boolean =>
  key === "ifc" || key === "asCell" || key === "asStream" ||
  key === "scope";

/**
 * Whether `schema` admits every value: `true`, or an object whose every
 * keyword is one the runtime reads for itself, a default, or a definition
 * map, none of which constrains a value.
 */
export const cfcSchemaIsTrue = (schema: JSONSchema): boolean => {
  if (schema === true) {
    return true;
  }
  return isObjectOrArray(schema) &&
    Object.keys(schema).every((key) =>
      cfcSchemaIsInternalKey(key) || key === "default" || key === "$defs"
    );
};

/** Whether `schema` admits no value: `false`, or the negation of a true one. */
export const cfcSchemaIsFalse = (schema: JSONSchema): boolean =>
  schema === false ||
  (isObjectOrArray(schema) && Object.hasOwn(schema, "not") &&
    cfcSchemaIsTrue(schema["not"]!));

/**
 * Whether a decoded JSON pointer names a member of a root `$defs` map:
 * `["#", "$defs", <name>]`, with the name non-empty.
 */
export const isRootDefsSchemaPointer = (
  pathToDef: readonly string[],
): boolean =>
  pathToDef.length === 3 && pathToDef[0] === "#" && pathToDef[1] === "$defs" &&
  pathToDef[2].length > 0;

/**
 * The definition name a `#/$defs/<name>` reference names, or `undefined` for any
 * other reference.
 */
export const localDefinitionName = (schemaRef: string): string | undefined => {
  if (!schemaRef.startsWith("#")) return undefined;
  const path = decodeJsonPointer(schemaRef);
  return isRootDefsSchemaPointer(path) ? path[2] : undefined;
};

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
 * form. The runtime answers this from its schema registry, and a reader over
 * stored documents from the documents it holds, through
 * {@link externalReferenceResolverOver}.
 */
export type ExternalReferenceResolver = (
  schema: JSONSchemaObj,
) => ResolvedExternalReference | undefined;

/**
 * An {@link ExternalReferenceResolver} over `readSchemaDocument`, which
 * supplies a schema document's value by its tagged hash. A reference resolves
 * to the document it names, or to the `#/$defs/<name>` member of it where the
 * fragment names one, and the keywords written beside the `$ref` — an
 * `asCell` declaration among them — are read over what it resolved to, the
 * way the runtime reads a reference with siblings; a boolean target takes
 * them over its object form. The document is what the local references
 * inside the result name definitions of. A reference naming no document the
 * reader supplies, or a member the document does not carry, resolves to
 * nothing.
 *
 * The runtime goes further for a sibling carrying a local reference of its
 * own, whose definitions belong to the referring document rather than the
 * referenced one, and namespaces them apart. A keyword read at a root, as a
 * declaration is, does not reach that case.
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
    if (Object.keys(siblings).length === 0) return { schema: target, root };
    return { schema: { ...cfcSchemaToObject(target), ...siblings }, root };
  };
}
