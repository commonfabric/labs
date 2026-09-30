import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import {
  isFabricPlainObject,
  type MutableFabricPlainObjectLayer,
} from "@commonfabric/data-model";
import {
  isLinkRef,
  linkRefFrom,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";

export const REQUEST_SCHEMA_CAS_REF_PREFIX = "schema-cas@1:";

/** Optional request-local accounting for recursive schema-bearing values. */
export type LinkSchemaTraversal = {
  visitNode(depth: number): void;
  visitSchemaPosition(): void;
};

/**
 * Maps schemas only in link-payload schema positions.
 *
 * Link recognition and reconstruction use the cell-rep link API
 * ({@link isLinkRef} / {@link linkRefPayload} / {@link linkRefFrom}), so both
 * `modernCellRep` regimes are handled transparently — legacy envelope or
 * `FabricLink` instance alike.
 *
 * `$alias` records are Pattern-binding vocabulary, not links (#4895):
 * their `schema` field is binding metadata, not a link-schema position, so
 * this walk never interns or expands it, and the sync schema table leaves
 * alias schemas alone. Clients shipped BEFORE this change do interpret
 * alias schema positions, so the reserved-ref validator keeps refusing
 * TABLE refs there — see {@link findSyncSchemaRef} in sync-schema-ref.ts,
 * which deliberately checks a superset of this walk's positions. An alias
 * is a binding only by CONTEXT: to the storage layer an `$alias`-shaped
 * record is plain data, so a `cid:` `$ref` a binding's schema carries
 * (`docs/specs/content-addressed-schemas.md`, Phase 2) is emitted and
 * resolved by the pattern machinery through the realm registry — no
 * storage-layer walk treats alias positions as schema carriers.
 *
 * Schema VALUES are opaque to this walk: after a schema position is mapped,
 * the traversal does not descend into the schema (or its mapped
 * replacement), so link-shaped structures inside a schema — for example in a
 * `default` — are data, never positions. This keeps compression and
 * expansion inverse, and means a table entry delivered under hash
 * verification is never rewritten afterwards.
 *
 * Non-link `FabricInstance`s are not walked: their contents live in private
 * slots, not enumerable own-properties. That is safe because every consumer
 * of these positions — the compressor, the expander, and the reserved-ref
 * validator in sync-schema-ref.ts — skips them the same way, so a reference
 * inside an instance can be neither produced nor interpreted, and the
 * engine's serialized substring check still sees instance contents
 * verbatim. If this walk ever learns to descend into an instance type, the
 * validator and `containsSyncSchemaRefString` must learn it in the same
 * change — the walker-agreement test in v2-sync-schema-table.test.ts fails
 * until they do.
 */
export const mapLinkSchemas = (
  value: FabricValue,
  mapSchema: (schema: FabricValue) => FabricValue,
  traversal?: LinkSchemaTraversal,
  depth = 0,
): FabricValue => {
  traversal?.visitNode(depth);
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = mapLinkSchemas(item, mapSchema, traversal, depth + 1);
      changed ||= !Object.is(next, item);
      return next;
    });
    return changed ? mapped : value;
  }

  if (isLinkRef(value)) {
    const payload = linkRefPayload(value);
    if (isFabricPlainObject(payload)) {
      const mappedPayload = mapPayloadSchemas(
        payload,
        mapSchema,
        traversal,
        depth,
      );
      return mappedPayload === payload ? value : linkRefFrom(mappedPayload);
    }
    // Envelope-shaped but the payload is not a record: cell-rep recognizes
    // the envelope shape only, so stored data can put null, a primitive, or
    // an array here. That is not a usable link — fall through and walk it
    // as ordinary data (the pre-cell-rep walker did the same) instead of
    // throwing mid-sync on the malformed payload.
  }

  if (!isFabricPlainObject(value)) return value;

  return mapRecordChildren(value, mapSchema, traversal, depth);
};

/** Maps the `schema` position of one link payload — without descending
 *  into the schema value — and walks the payload's other entries. */
const mapPayloadSchemas = (
  payload: FabricPlainObject,
  mapSchema: (schema: FabricValue) => FabricValue,
  traversal: LinkSchemaTraversal | undefined,
  depth: number,
): FabricPlainObject => {
  let mappedPayload = payload;
  if (Object.hasOwn(payload, "schema")) {
    traversal?.visitSchemaPosition();
    const schema = mapSchema(payload.schema);
    // Object.is: a NaN-valued leaf returned unchanged must not count as a
    // change (see the data-model Object.is sweep).
    if (!Object.is(schema, payload.schema)) {
      mappedPayload = { ...payload, schema };
    }
  }
  return mapRecordChildren(
    mappedPayload,
    mapSchema,
    traversal,
    depth,
    "schema",
  );
};

/** Walks every own entry of a record except `skippedKey`, allocating a copy
 *  only on change. Plain assignment is safe for every key except
 *  "__proto__", whose assignment would hit the prototype accessor instead of
 *  creating an own property. */
const mapRecordChildren = (
  record: FabricPlainObject,
  mapSchema: (schema: FabricValue) => FabricValue,
  traversal: LinkSchemaTraversal | undefined,
  depth: number,
  skippedKey?: string,
): FabricPlainObject => {
  const entries = Object.entries(record);
  const mappedChildren: FabricValue[] = new Array(entries.length);
  let childChanged = false;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, child] = entries[index];
    if (key === skippedKey) {
      mappedChildren[index] = child;
      continue;
    }
    const next = mapLinkSchemas(child, mapSchema, traversal, depth + 1);
    mappedChildren[index] = next;
    childChanged ||= !Object.is(next, child);
  }
  if (!childChanged) return record;

  const mapped: MutableFabricPlainObjectLayer = {};
  for (let index = 0; index < entries.length; index += 1) {
    const key = entries[index][0];
    const next = mappedChildren[index];
    if (key === "__proto__") {
      Object.defineProperty(mapped, key, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      mapped[key] = next;
    }
  }
  return mapped;
};
