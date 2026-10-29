import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";
import { REQUEST_SCHEMA_CAS_REF_PREFIX } from "./schema-table-links.ts";

export const SYNC_SCHEMA_REF_PREFIX = "schema-ref@2:";

const isReservedSchemaRef = (value: string): boolean =>
  value.startsWith(SYNC_SCHEMA_REF_PREFIX) ||
  value.startsWith(REQUEST_SCHEMA_CAS_REF_PREFIX);

/**
 * Whether serialized text contains a reserved reference prefix anywhere.
 * Serializations of documents and patches embed every string value they
 * carry verbatim — see the note on `encodeMemoryBoundary` in ../v2.ts, which
 * names this gate as a dependent — so a negative answer proves the
 * serialized value cannot introduce a reserved reference. This is the cheap
 * gate in front of the deep walks below.
 */
export const containsReservedSchemaRefSubstring = (value: string): boolean =>
  value.includes(SYNC_SCHEMA_REF_PREFIX) ||
  value.includes(REQUEST_SCHEMA_CAS_REF_PREFIX);

const payloadSchemaRef = (
  payload: Record<string, unknown>,
): string | undefined => {
  const schema = payload.schema;
  return typeof schema === "string" && isReservedSchemaRef(schema)
    ? schema
    : undefined;
};

/**
 * Finds a reserved wire reference in a schema position, or undefined.
 *
 * Visits a SUPERSET of the schema positions {@link mapLinkSchemas}
 * interprets:
 *
 * - Link payloads (via cell-rep, both `modernCellRep` regimes), with the
 *   mapper's blindness — link schema subtrees are opaque, and non-link
 *   `FabricInstance` contents are not walked.
 * - Legacy `$alias` schema positions, which the mapper no longer
 *   interprets. Clients shipped before that removal still expand refs
 *   there, so stored data must not be able to deliver one to them; this
 *   stays until pre-removal clients are out of circulation. Unlike a link
 *   payload's, an alias's `schema` value is also walked as ordinary data,
 *   because that is how the mapper now sees it — link positions inside it
 *   are live.
 *
 * The traversal engine is deliberately ITERATIVE (explicit stack) so
 * adversarially deep documents cannot overflow the call stack. The
 * superset relationship with the recursive mapper — equal on link
 * positions, wider by exactly the legacy alias positions — is enforced
 * mechanically by the walker-agreement test in
 * test/v2-sync-schema-table.test.ts; teach both (and
 * `containsSyncSchemaRefString`) in the same change or that test fails.
 */
export const findSyncSchemaRef = (value: unknown): string | undefined => {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push(current[index]);
      }
      continue;
    }

    if (isLinkRef(current)) {
      const payload = linkRefPayload(current);
      if (isPlainObject(payload)) {
        const ref = payloadSchemaRef(payload);
        if (ref !== undefined) {
          return ref;
        }
        for (const key in payload) {
          if (key !== "schema" && Object.hasOwn(payload, key)) {
            pending.push(payload[key]);
          }
        }
        continue;
      }
      // Envelope-shaped but the payload is not a record: not a usable link.
      // Fall through to the ordinary record walk, mirroring the mapper.
    }

    if (!isPlainObject(current)) {
      continue;
    }

    const legacyAlias = current.$alias;
    const hasLegacyAlias = isPlainObject(legacyAlias);
    if (hasLegacyAlias) {
      const ref = payloadSchemaRef(legacyAlias);
      if (ref !== undefined) {
        return ref;
      }
      // Every alias child — the schema value included — is walked as data,
      // mirroring the mapper's view of the alias record.
      for (const key in legacyAlias) {
        if (Object.hasOwn(legacyAlias, key)) {
          pending.push(legacyAlias[key]);
        }
      }
    }

    for (const key in current) {
      if (!Object.hasOwn(current, key)) {
        continue;
      }
      if (key === "$alias" && hasLegacyAlias) {
        continue;
      }
      pending.push(current[key]);
    }
  }

  return undefined;
};

/**
 * Checks plain containers (arrays, plain records) and link payloads for a
 * string that could introduce a wire reference. The logical contents of
 * non-link `FabricInstance`s are NOT walked — they live in private slots,
 * not enumerable own-properties. That blindness is sound because the
 * compressor, expander, and {@link findSyncSchemaRef} share it (a reference
 * inside an instance can be neither produced nor interpreted), and the
 * engine's serialized substring gate sees instance contents verbatim. If
 * {@link mapLinkSchemas} ever learns to descend into an instance type, this
 * scanner must be taught in the same change.
 */
export const containsSyncSchemaRefString = (value: unknown): boolean => {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (isReservedSchemaRef(current)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        pending.push(current[index]);
      }
      continue;
    }
    if (isLinkRef(current) && !isPlainObject(current)) {
      // A FabricLink's payload is not reachable by plain-record iteration.
      // The legacy envelope IS a plain record and takes the ordinary walk
      // below, which reaches its payload — malformed or not — and any
      // sibling entries without trusting the payload extraction.
      pending.push(linkRefPayload(current));
      continue;
    }
    if (!isPlainObject(current)) {
      continue;
    }
    for (const key in current) {
      if (Object.hasOwn(current, key)) {
        pending.push(current[key]);
      }
    }
  }

  return false;
};
