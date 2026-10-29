/**
 * The embedded schemas: well-known schema bodies resolvable by URL from a
 * static in-process table on every peer, with no document behind them. The
 * renderer's vdom/vnode schemas are the residents.
 *
 * Each resident enters the table in external form, the way a member of a
 * content-addressed cyclic group is read: its refs into its own `$defs` take
 * the `<url>#/$defs/<name>` form, which the table answers as well, and no
 * entry carries a `$defs` of its own. A resolved embedded schema can then be
 * embedded below any other root — a narrowed schema places it under a
 * property — and its refs still name its own definitions, where a local
 * pointer would name the enclosing root's.
 *
 * Transitional (`docs/specs/content-addressed-schemas.md`): an embedded ref
 * is an allowed leaf inside content-addressed schema documents — every
 * realm resolves it identically without any closure entry — and the
 * expectation is that these refs retire in favor of ordinary `cid:`
 * documents, at which point this table goes with them. Stored documents
 * carrying the URLs keep resolving until then.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  mapSubschemas,
  type SchemaWalkOptions,
} from "@commonfabric/data-model-schema/schema-walk";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { decodeJsonPointer, encodeJsonPointer } from "./link-types.ts";
import { rendererVDOMSchema, vnodeSchema } from "./schemas.ts";

const ALL_SUBSCHEMAS: SchemaWalkOptions = { includeUnused: true };

const localDefinitionName = (ref: string): string | undefined => {
  if (!ref.startsWith("#")) return undefined;
  const pointer = decodeJsonPointer(ref);
  return pointer.length === 3 && pointer[0] === "#" && pointer[1] === "$defs" &&
      pointer[2].length > 0
    ? pointer[2]
    : undefined;
};

/**
 * `document` and each of its definitions, with every ref into the
 * document's `$defs` rewritten to the `<url>#/$defs/<name>` form, keyed the
 * way a ref names them. The `$id` stays off the entries: the URL the table
 * is keyed by is the document's identity, and a resolved body carrying an
 * `$id` would keep a schema built around it from decomposing.
 */
export const externalized = (
  url: string,
  document: JSONSchema,
): Record<string, JSONSchema> => {
  if (!isObjectOrArray(document)) return { [url]: document };
  const rewrite = (fragment: JSONSchema): JSONSchema => {
    if (!isObjectOrArray(fragment)) return fragment;
    let result: JSONSchemaObj = fragment;
    if (typeof fragment.$ref === "string") {
      const name = localDefinitionName(fragment.$ref);
      if (name !== undefined) {
        result = {
          ...result,
          $ref: `${url}${encodeJsonPointer(["#", "$defs", name])}`,
        };
      }
    }
    return mapSubschemas(result, rewrite, ALL_SUBSCHEMAS);
  };
  const { $defs: definitions, $id: _id, ...body } = document;
  const entries: Record<string, JSONSchema> = {
    [url]: internSchema(rewrite(body)),
  };
  if (isObjectNotArray(definitions)) {
    for (const [name, definition] of Object.entries(definitions)) {
      entries[`${url}${encodeJsonPointer(["#", "$defs", name])}`] =
        internSchema(rewrite(definition as JSONSchema));
    }
  }
  return entries;
};

export const embeddedSchemas: Record<string, JSONSchema> = {
  ...externalized(
    "https://commonfabric.org/schemas/vdom.json",
    rendererVDOMSchema,
  ),
  ...externalized(
    "https://commonfabric.org/schemas/vnode.json",
    vnodeSchema,
  ),
};

/** Whether `schemaRef` names an embedded schema, or a definition of one. */
export const isEmbeddedCfcSchemaRef = (schemaRef: string): boolean =>
  Object.hasOwn(embeddedSchemas, schemaRef);
