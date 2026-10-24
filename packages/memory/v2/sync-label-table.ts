/** Lossless, negotiated CFC metadata tables scoped to one server sync. */

import { isPlainObject } from "@commonfabric/utils/types";

import type { ServerMessage, SessionSync } from "../v2.ts";
import {
  compressLabelMetadata,
  expandLabelMetadata,
  hasLabelMetadata,
  type LabelMetadataTables,
  mapLabelMetadataAtPath,
  type MapMetadataValue,
} from "./label-metadata-table.ts";

export {
  MAX_LABEL_METADATA_EXPANSION_BYTES as MAX_SYNC_LABEL_EXPANSION_BYTES,
} from "./label-metadata-table.ts";

/** Sync carrying optional, independent dictionaries of exact labels and paths. */
export type LabelTableSessionSync = SessionSync & LabelMetadataTables;

/** Compresses metadata only when dictionary and reference costs save bytes. */
export function compressSessionSyncLabels(
  sync: SessionSync,
): LabelTableSessionSync;
export function compressSessionSyncLabels(sync: unknown): unknown;
export function compressSessionSyncLabels(sync: unknown): unknown {
  return isPlainObject(sync) && sync.type === "sync"
    ? compressLabelMetadata(sync, mapSyncMetadata)
    : sync;
}

/**
 * Validates references and expands them. A sync that carried a dictionary is
 * returned deeply frozen; one without is returned as it was.
 */
export function expandSessionSyncLabels(sync: SessionSync): SessionSync;
export function expandSessionSyncLabels(sync: unknown): unknown;
export function expandSessionSyncLabels(sync: unknown): unknown {
  return isPlainObject(sync) && sync.type === "sync"
    ? expandLabelMetadata(sync, mapSyncMetadata)
    : sync;
}

/** Compresses syncs in effects and successful response envelopes. */
export function compressServerMessageLabels(
  message: ServerMessage,
): ServerMessage {
  return mapServerSync(message, compressSessionSyncLabels);
}

/** Expands syncs before parsing or delivering their server envelopes. */
export function expandServerMessageLabels(message: unknown): unknown {
  return mapServerSync(message, expandSessionSyncLabels);
}

/** Detects sync dictionaries and numeric refs without interpreting inline CFC. */
export function hasServerMessageLabelMetadata(message: unknown): boolean {
  let found = false;
  mapServerSync(message, (sync) => {
    if (isPlainObject(sync) && sync.type === "sync") {
      found ||= hasLabelMetadata(sync, mapSyncMetadata);
    }
    return sync;
  });
  return found;
}

/** Helper for sync tables, which visits only documents in actual upserts. */
function mapSyncMetadata(
  sync: Record<string, unknown>,
  map: MapMetadataValue,
): Record<string, unknown> {
  if (!Array.isArray(sync.upserts)) throw new Error("Invalid sync `upserts`");
  let changed = false;
  const upserts = sync.upserts.map((upsert: unknown) => {
    if (!isPlainObject(upsert)) throw new Error("Invalid sync upsert");
    if (upsert.doc === undefined) return upsert;
    const doc = mapLabelMetadataAtPath(upsert.doc, [], map);
    if (Object.is(doc, upsert.doc)) return upsert;
    changed = true;
    return { ...upsert, doc };
  });
  return changed ? { ...sync, upserts } : sync;
}

/** Helper for endpoint transforms, which preserves unrelated envelopes. */
function mapServerSync(
  message: ServerMessage,
  transform: (sync: unknown) => unknown,
): ServerMessage;
function mapServerSync(
  message: unknown,
  transform: (sync: unknown) => unknown,
): unknown;
function mapServerSync(
  message: unknown,
  transform: (sync: unknown) => unknown,
): unknown {
  if (!isPlainObject(message)) return message;
  if (message.type === "session/effect") {
    const effect = transform(message.effect);
    return effect === message.effect ? message : { ...message, effect };
  }
  if (message.type === "response" && isPlainObject(message.ok)) {
    const sync = transform(message.ok.sync);
    return sync === message.ok.sync
      ? message
      : { ...message, ok: { ...message.ok, sync } };
  }
  return message;
}
