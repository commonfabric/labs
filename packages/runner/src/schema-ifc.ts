/**
 * Whether a schema tree carries flow-control marking (`ifc`) anywhere.
 *
 * Lives apart from `schema.ts` so the traversal can consult it at link
 * hops: `schema.ts` imports the traversal, and the read entry point and
 * the walk both gate cfc relevance on this predicate.
 */

import { getLogger } from "@commonfabric/utils/logger";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { ContextualFlowControl } from "./cfc.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./cfc/schema-refs.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { walkSchemaDocumentClosure } from "@commonfabric/data-model-schema/schema-closure";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import {
  collectExternalSchemaRefHashes,
  containsExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import type { URI } from "./sigil-types.ts";
import {
  externalResolutionMissCount,
  lookupSchemaDocument,
  onSchemaRegistryClear,
  registerSchemaDocument,
} from "./schema-registry.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

const logger = getLogger("schema-ifc");

// Memo for `schemaHasIfc` top-level calls. Safe **only** because entries
// are populated under an `isDeepFrozen` guard below: the predicate's
// answer depends on the entire subtree's shape, so caching against a
// merely-TS-`readonly` or shallow-frozen input would be unsound — a
// future sub-schema swap would silently invalidate the cached answer.
// A future contributor must not relax the populate guard to accept
// non-deep-frozen inputs. `Object.isFrozen` is **not** sufficient; it
// is shallow-only.
let _hasIfcCache = new WeakMap<JSONSchemaObj, boolean>();
// A verdict computed over registry content must not outlive the lease epoch
// that made the content available; the clear swaps the cache.
onSchemaRegistryClear(() => {
  _hasIfcCache = new WeakMap();
});

interface SchemaHasIfcContext {
  seenByRoot: WeakMap<object, WeakSet<object>>;
}

export function schemaHasIfc(
  schema: JSONSchema | undefined,
  seen: Set<JSONSchema> = new Set(),
  fullSchema: JSONSchema | undefined = schema,
): boolean {
  if (schema === undefined || typeof schema === "boolean") {
    return false;
  }
  // Top-level calls (the default entry from cell.ts / schema.ts) can
  // consult the memo. Recursive calls carry caller-provided `seen` and
  // `fullSchema`, which aren't captured in the cache key, so they must
  // bypass.
  const isTopLevel = seen.size === 0 && fullSchema === schema;
  if (isTopLevel) {
    const cached = _hasIfcCache.get(schema);
    if (cached !== undefined) return cached;
  }
  const context: SchemaHasIfcContext = { seenByRoot: new WeakMap() };
  if (seen.size > 0) {
    const initialRoot = fullSchema ?? schema;
    const rootKey = isObjectOrArray(initialRoot) ? initialRoot : schema;
    const initialSeen = new WeakSet<object>();
    for (const item of seen) {
      if (isObjectOrArray(item)) initialSeen.add(item);
    }
    context.seenByRoot.set(rootKey, initialSeen);
  }
  const missesBefore = externalResolutionMissCount();
  const result = _schemaHasIfcUncached(schema, fullSchema, context);
  // Populate only under a deep-frozen guard (see the invariant comment
  // above `_hasIfcCache`), and only when no `cid:` resolution missed while
  // computing — a verdict computed over an absent schema document must not
  // outlive the document's arrival.
  if (
    isTopLevel && isDeepFrozen(schema) &&
    externalResolutionMissCount() === missesBefore
  ) {
    _hasIfcCache.set(schema, result);
  }
  return result;
}

function _schemaHasIfcUncached(
  schema: JSONSchemaObj,
  fullSchema: JSONSchema | undefined,
  context: SchemaHasIfcContext,
): boolean {
  const schemaRoot = fullSchema ?? schema;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  let seen = context.seenByRoot.get(rootKey);
  if (seen?.has(schema)) return false;
  if (!seen) {
    seen = new WeakSet();
    context.seenByRoot.set(rootKey, seen);
  }
  seen.add(schema);

  const resolved = typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot)
    : schema;
  if (resolved === true || resolved === false || !isObjectOrArray(resolved)) {
    return false;
  }
  const childFullSchema = typeof schema.$ref === "string"
    ? cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    )
    : schemaRoot;
  if (resolved.ifc !== undefined) {
    return true;
  }

  // Descend every structural subschema via the shared vocabulary. Previously
  // this hand-listed only anyOf/oneOf/allOf/properties/additionalProperties/
  // items and silently skipped prefixItems, patternProperties, contains,
  // if/then/else, not, propertyNames, dependentSchemas, and contentSchema — so
  // an `ifc` in a tuple element or pattern property went undetected. `$defs`
  // bodies are reached through `$ref` resolution above, not walked directly.
  return forEachSubschema(
    resolved,
    (child) =>
      isObjectOrArray(child) &&
      _schemaHasIfcUncached(child, childFullSchema, context),
  );
}

/**
 * Loads and registers the external schema-document closure behind
 * `schema`'s `cid:` refs, transaction-level: an unregistered document is
 * read through the transaction, verified, and registered; documents the
 * registry already holds cost one lookup and are recursed for their own
 * refs without a read. The fuller traversal-context loader
 * (`loadExternalSchemaDocs` in traverse.ts) also feeds the schema tracker
 * and availability bookkeeping; this one exists for the crossing seams
 * that have no traversal context (link resolution, handle hops).
 *
 * Closure documents travel WITH the documents that refer to them, so
 * every reachable ref of a well-formed stored schema resolves from the
 * local store. Returns whether they all did: `false` names a corrupt or
 * deliberately malformed declaration — a ref the referrer space holds no
 * value for (absent, or an entry resolving to `undefined` — the hasher
 * does assign `undefined` a hash, but a schema cannot be `undefined` and
 * the registry cannot represent one, so such an entry is unusable
 * whichever hash the ref carries), a document that is not a schema
 * document, or one whose content does not hash to its id — which is
 * logged, after which the declaration
 * SELECTS NOTHING: the traversal narrows it to `false` and a caller about
 * to walk the schema (narrowing among them) skips it instead of throwing
 * on the dangling ref.
 */
export function ensureExternalSchemaClosure(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  schema: JSONSchema | undefined,
  options?: { silentFailures?: boolean },
): boolean {
  if (schema === undefined || !containsExternalSchemaRef(schema)) return true;
  const { missing } = walkSchemaDocumentClosure({
    roots: collectExternalSchemaRefHashes(schema),
    load: (hash) => {
      const registered = lookupSchemaDocument(hash);
      if (registered !== undefined) {
        return { kind: "verified", schema: registered };
      }
      const address = {
        space,
        id: `cid:${hash}` as URI,
        scope: "space",
        path: [],
      } as const;
      const result = tx.read(address);
      const doc = result.error === undefined ? result.ok.value : undefined;
      if (doc === undefined) {
        if (!options?.silentFailures) {
          logger.warn("schema-closure", () => [
            "Stored schema names a cid: document this space holds no value " +
            "for — a corrupt or malformed declaration; ignoring it:",
            address.id,
          ]);
        }
        return undefined;
      }
      // `value === undefined` included: the hasher assigns `undefined` a
      // hash, but the registry cannot represent a registered `undefined`
      // (lookup reads as unregistered), so registering it would report
      // this closure complete while the ref stays unresolvable.
      if (
        !isObjectNotArray(doc) ||
        (doc as { value?: unknown }).value === undefined
      ) {
        if (!options?.silentFailures) {
          logger.warn("schema-closure", () => [
            "cid: document is not a schema document; ignoring it:",
            address.id,
          ]);
        }
        return undefined;
      }
      return { kind: "stored", value: (doc as { value?: unknown }).value };
    },
    onVerified: (hash, document) => {
      registerSchemaDocument(hash, document);
    },
    onMissing: (hash, miss) => {
      // An absent document was logged where its read found nothing. One
      // whose content does not hash to its id is forged: neither
      // registered nor recursed into.
      if (miss !== "mismatch") return;
      if (!options?.silentFailures) {
        logger.warn("schema-closure", () => [
          "cid: document content does not hash to its id; ignoring it:",
          `cid:${hash}`,
        ]);
      }
    },
  });
  return missing.size === 0;
}

/**
 * The shared "actual link crossing" seam: marks `tx` cfc-relevant when the
 * link being crossed carries flow-control marking in its stored schema.
 * Reader precedence keeps a shaped reader's combined schema free of the
 * link's `ifc`, so the marking lives at the crossing rather than on the
 * combination's output. The schema's external closure is loaded first
 * (`ensureExternalSchemaClosure`), so a declaration whose documents the
 * registry has not yet registered from the local store is resolvable when
 * the predicate walks it. The registry is realm-global: a hash registered
 * from any space short-circuits the read, soundly, since equal hashes name
 * equal bytes. A ref the closure cannot resolve names a corrupt or
 * malformed declaration; the loader logs it, and the predicate marks off
 * whatever the schema legibly declares. The predicate is memoized;
 * unlabeled links (the common case) cost one cached lookup.
 */
export function markIfcBearingLinkCrossing(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  linkSchema: JSONSchema | undefined,
  linkId: string,
): void {
  if (linkSchema === undefined) return;
  ensureExternalSchemaClosure(tx, space, linkSchema);
  if (schemaHasIfc(linkSchema)) {
    tx.markCfcRelevant(`schema-ifc-hop:${linkId}`);
  }
}
