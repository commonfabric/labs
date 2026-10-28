import type { FabricValue, JSONSchema } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { isPlainObject } from "@commonfabric/utils/types";

import type {
  ServerMessage,
  SessionEffectMessage,
  SessionSync,
  SyncCrossing,
} from "../v2.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  findSyncSchemaRef,
  SYNC_SCHEMA_REF_PREFIX,
} from "./sync-schema-ref.ts";

type SchemaTable = Record<string, JSONSchema>;

export type SchemaTableSessionSync = SessionSync & {
  schemaTable?: SchemaTable;
};

type RewriteState = {
  schemas: Map<string, JSONSchema>;
  changed: boolean;
  onSchema?: (schema: JSONSchema) => void;
};

/**
 * A reference-only schema position: `{ "$ref": "cid:…" }` and nothing else,
 * pointing at a content-addressed schema document
 * (`docs/specs/content-addressed-schemas.md`). Already smaller than a table
 * ref, so compressing it would grow the frame; the schema body travels once
 * as the referenced document itself.
 */
const isSchemaDocumentRefOnly = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "$ref" &&
    typeof value.$ref === "string" && value.$ref.startsWith("cid:");
};

const isCompressibleSchema = (value: unknown): value is JSONSchema =>
  (value === true || value === false || isPlainObject(value)) &&
  !isSchemaDocumentRefOnly(value);

const schemaRefFor = (
  schema: JSONSchema,
  state: RewriteState,
): string => {
  const schemaAndHash = internSchema(schema, true);
  const hash = schemaAndHash.taggedHashString;
  if (!state.schemas.has(hash)) {
    state.schemas.set(hash, schemaAndHash.schema);
    state.onSchema?.(schemaAndHash.schema);
  }
  return `${SYNC_SCHEMA_REF_PREFIX}${hash}`;
};

const expandSchemaRef = (
  value: unknown,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): JSONSchema | undefined => {
  if (
    typeof value !== "string" ||
    !value.startsWith(SYNC_SCHEMA_REF_PREFIX)
  ) {
    return undefined;
  }
  const hash = value.slice(SYNC_SCHEMA_REF_PREFIX.length);
  if (
    hash.length === 0 || schemas === undefined ||
    !Object.hasOwn(schemas, hash)
  ) {
    throw new Error(`Invalid sync schema table reference: ${value}`);
  }
  const schema = schemas[hash];
  const schemaAndHash = internSchema(schema, true);
  if (schemaAndHash.taggedHashString !== hash) {
    throw new Error(
      `Invalid sync schema table content for reference: ${value}`,
    );
  }
  onSchema?.(schemaAndHash.schema);
  return schemaAndHash.schema;
};

const rewriteSchemaValue = (
  value: FabricValue,
  state: RewriteState,
): FabricValue => {
  if (isCompressibleSchema(value)) {
    state.changed = true;
    return schemaRefFor(value, state);
  }
  return value;
};

const expandSchemaValue = (
  value: FabricValue,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): FabricValue => expandSchemaRef(value, schemas, onSchema) ?? value;

const rewriteValue = (value: FabricValue, state: RewriteState): FabricValue =>
  mapLinkSchemas(value, (schema) => rewriteSchemaValue(schema, state));

const expandValue = (
  value: FabricValue,
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): FabricValue =>
  mapLinkSchemas(
    value,
    (schema) => expandSchemaValue(schema, schemas, onSchema),
  );

export const compressSessionSyncSchemas = (
  sync: SessionSync,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync | SchemaTableSessionSync => {
  const state: RewriteState = {
    schemas: new Map(),
    changed: false,
    onSchema,
  };
  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = rewriteValue(upsert.doc, state);
    return doc === upsert.doc ? upsert : {
      ...upsert,
      doc: doc as typeof upsert.doc,
    };
  });
  // A crossing's schema is a schema position of its own, interned like a
  // link's: the walk reports the selector a read needed, which is as often
  // as not the same schema the frame's documents carry inline.
  const crossings = sync.crossings?.map((crossing) =>
    isCompressibleSchema(crossing.schema)
      ? {
        ...crossing,
        schema: rewriteSchemaValue(crossing.schema, state) as JSONSchema,
      }
      : crossing
  );

  if (!state.changed) {
    return sync;
  }

  return {
    ...sync,
    upserts,
    ...(crossings === undefined ? {} : { crossings }),
    schemaTable: Object.fromEntries(state.schemas),
  };
};

/** Expands the table references a frame's crossings carry in their schema
 * position, throwing on one the table cannot resolve. */
const expandCrossingSchemas = (
  crossings: readonly SyncCrossing[],
  schemas: SchemaTable | undefined,
  onSchema?: (schema: JSONSchema) => void,
): SyncCrossing[] =>
  crossings.map((crossing) => {
    const expanded = expandSchemaRef(crossing.schema, schemas, onSchema);
    return expanded === undefined
      ? crossing
      : { ...crossing, schema: expanded };
  });

export const expandSessionSyncSchemas = (
  sync: SessionSync | SchemaTableSessionSync,
  onSchema?: (schema: JSONSchema) => void,
): SessionSync => {
  const schemas = (sync as SchemaTableSessionSync).schemaTable;
  if (schemas === undefined || Object.keys(schemas).length === 0) {
    for (const upsert of sync.upserts) {
      const ref = findSyncSchemaRef(upsert.doc);
      if (ref !== undefined) {
        expandSchemaRef(ref, schemas, onSchema);
      }
    }
    // A reference in a crossing's schema position with no table to resolve
    // it against fails the frame the same way.
    if (sync.crossings !== undefined) {
      expandCrossingSchemas(sync.crossings, schemas, onSchema);
    }
    return sync;
  }

  const upserts = sync.upserts.map((upsert) => {
    if (upsert.doc === undefined) {
      return upsert;
    }
    const doc = expandValue(upsert.doc, schemas, onSchema);
    // A ref surviving expansion sits at a position this expander does not
    // interpret — e.g. a legacy `$alias` schema position interned by an
    // older server. Delivering it would hand the session cache a ref
    // string as data; fail loudly instead.
    const leftover = findSyncSchemaRef(doc);
    if (leftover !== undefined) {
      throw new Error(`Unexpanded sync schema table reference: ${leftover}`);
    }
    return doc === upsert.doc ? upsert : {
      ...upsert,
      doc: doc as typeof upsert.doc,
    };
  });

  const withExpandedUpserts: SchemaTableSessionSync = {
    ...sync,
    upserts,
    ...(sync.crossings === undefined ? {} : {
      crossings: expandCrossingSchemas(sync.crossings, schemas, onSchema),
    }),
  };
  const { schemaTable: _schemaTable, ...expanded } = withExpandedUpserts;
  return deepFreeze(expanded as SessionSync);
};

const compressResponseSync = (
  message: ServerMessage,
  onSchema?: (schema: JSONSchema) => void,
): ServerMessage => {
  if (message.type !== "response" || message.ok === undefined) {
    return message;
  }
  if (!isPlainObject(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainObject(sync) || sync.type !== "sync") {
    return message;
  }

  return {
    ...message,
    ok: {
      ...message.ok,
      sync: compressSessionSyncSchemas(
        sync as unknown as SessionSync,
        onSchema,
      ),
    },
  };
};

const expandResponseSync = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
  if (!isPlainObject(message) || message.type !== "response") {
    return message;
  }
  if (!isPlainObject(message.ok)) {
    return message;
  }
  const sync = message.ok.sync;
  if (!isPlainObject(sync) || sync.type !== "sync") {
    return message;
  }

  return {
    ...message,
    ok: {
      ...message.ok,
      sync: expandSessionSyncSchemas(
        sync as unknown as SchemaTableSessionSync,
        onSchema,
      ),
    },
  };
};

export const compressServerMessageSchemas = (
  message: ServerMessage,
  onSchema?: (schema: JSONSchema) => void,
): ServerMessage => {
  if (message.type === "session/effect") {
    return {
      ...message,
      effect: compressSessionSyncSchemas(message.effect, onSchema),
    } as SessionEffectMessage;
  }
  return compressResponseSync(message, onSchema);
};

export const expandServerMessageSchemas = (
  message: unknown,
  onSchema?: (schema: JSONSchema) => void,
): unknown => {
  if (isPlainObject(message) && message.type === "session/effect") {
    return {
      ...message,
      effect: expandSessionSyncSchemas(
        message.effect as SchemaTableSessionSync,
        onSchema,
      ),
    };
  }
  return expandResponseSync(message, onSchema);
};
