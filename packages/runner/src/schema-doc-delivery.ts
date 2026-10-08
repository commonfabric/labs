/**
 * The writer's half of the write-side delivery guarantee of content-addressed
 * schemas (`docs/specs/content-addressed-schemas.md`): every schema document a
 * written link references travels with the reference, into the space that will
 * hold it. These are the two steps every writer shares, finding what a value
 * references and finding the documents behind that, so that a transaction and
 * an event append discharge the same obligation the same way. Writing what
 * they find is left to the writer, since each commits through its own path.
 */

import type { FabricValue, JSONSchema } from "@commonfabric/api";
import {
  type SchemaClosureResult,
  walkSchemaDocumentClosure,
} from "@commonfabric/data-model-schema/schema-closure";
import { collectExternalSchemaRefHashes } from "@commonfabric/data-model-schema/schema-refs";
import { mapLinkSchemas } from "@commonfabric/memory/v2/schema-table-links";
import { lookupSchemaDocument } from "./schema-registry.ts";

/**
 * Returns the hashes of the schema documents the link schemas in `value`
 * reference, in link positions only. The commit boundary scans the same
 * positions, so a reference found nowhere here is one it does not demand
 * either. An `$alias` record is plain data at this layer, and its schema is
 * not a link position.
 */
export function linkSchemaRefHashes(value: FabricValue): Set<string> {
  const hashes = new Set<string>();
  mapLinkSchemas(value, (schema) => {
    for (const hash of collectExternalSchemaRefHashes(schema as JSONSchema)) {
      hashes.add(hash);
    }
    return schema;
  });
  return hashes;
}

/**
 * Hands `deliver` each schema document in the closure behind `roots`, taken
 * from the realm registry, once per hash. A hash for which `isSettled()`
 * returns `true` is neither delivered nor followed, which is how a caller
 * elides what its space already holds or what it has already delivered. A
 * hash the registry cannot supply is skipped and named in the result's
 * `.missing`; the commit boundary refuses a commit that still needs one,
 * unless the space already stores it.
 */
export function deliverSchemaDocumentClosure(
  roots: Iterable<string>,
  isSettled: (hash: string) => boolean,
  deliver: (hash: string, schema: JSONSchema) => void,
): SchemaClosureResult {
  return walkSchemaDocumentClosure({
    roots,
    load: (hash) => {
      if (isSettled(hash)) return { kind: "settled" };
      const document = lookupSchemaDocument(hash);
      return document === undefined
        ? undefined
        : { kind: "verified", schema: document };
    },
    onVerified: deliver,
  });
}
