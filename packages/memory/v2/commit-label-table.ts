/**
 * Lossless CFC metadata dictionaries for negotiated transact requests and results.
 * Positions come from operation kinds and document-rooted patch paths, never from
 * shapes found inside application values. Expansion precedes commit consumption.
 */

import {
  deepFreeze,
  type FabricPlainObject,
  type FabricValue,
} from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/utils/types";

import type { ClientMessage, ServerMessage } from "../v2.ts";
import {
  compressLabelMetadata,
  expandLabelMetadata,
  hasLabelMetadata,
  mapLabelMetadataAtPath,
  type MapMetadataValue,
} from "./label-metadata-table.ts";
import { parsePointer } from "./path.ts";

/**
 * Compresses actual operation metadata into independent commit-local label and
 * path tables when beneficial. Requires negotiated `commitLabelTableV1` support.
 * Inputs retain their values and frozenness. Inline semantic errors remain for
 * CFC readers; invalid transport refs and dictionary contents throw.
 */
export function compressClientMessageLabels(
  message: ClientMessage,
): ClientMessage;
export function compressClientMessageLabels(
  message: FabricPlainObject,
): FabricPlainObject;
export function compressClientMessageLabels(message: unknown): unknown;
export function compressClientMessageLabels(message: unknown): unknown {
  if (
    !isPlainObject(message) || message.type !== "transact" ||
    !isPlainObject(message.commit)
  ) {
    return message;
  }
  const commit = compressLabelMetadata(message.commit, mapCommitMetadata);
  return commit === message.commit ? message : { ...message, commit };
}

/**
 * Resolves commit-local refs before consumers validate or hash the request.
 * Returns a deeply frozen expanded request; uncompressed requests retain identity.
 * Unchanged subtrees shared with the input may be frozen in place.
 * Malformed refs, non-self-contained labels, and excess expansion throw.
 */
export function expandClientMessageLabels(message: FabricValue): FabricValue;
export function expandClientMessageLabels(message: unknown): unknown;
export function expandClientMessageLabels(message: unknown): unknown {
  if (
    !isPlainObject(message) || message.type !== "transact" ||
    !isPlainObject(message.commit)
  ) {
    return message;
  }
  const commit = expandLabelMetadata(message.commit, mapCommitMetadata);
  return commit === message.commit
    ? message
    : deepFreeze({ ...message, commit });
}

/**
 * Detects tables requiring commit-label negotiation. A number at a whole-field
 * position without its table is stored data, which commit admission refuses in
 * a label map the commit changes;
 * numeric application values and numeric components inside labels are ordinary data.
 */
export function hasClientMessageLabelMetadata(message: unknown): boolean {
  if (
    !isPlainObject(message) || message.type !== "transact" ||
    !isPlainObject(message.commit)
  ) {
    return false;
  }
  return hasLabelMetadata(message.commit, mapCommitMetadata);
}

/**
 * Compresses applied-commit revisions using response-local tables under `.ok`.
 * Requires negotiated `commitLabelTableV1`. Stored results and replay results
 * retain their original values and frozenness; each send compacts independently.
 */
export function compressServerMessageCommitLabels(
  message: ServerMessage,
): ServerMessage;
export function compressServerMessageCommitLabels(
  message: FabricPlainObject,
): FabricPlainObject;
export function compressServerMessageCommitLabels(message: unknown): unknown;
export function compressServerMessageCommitLabels(message: unknown): unknown {
  if (!isPlainObject(message)) return message;
  const result = commitResultOf(message);
  if (result === undefined) return message;
  const ok = compressLabelMetadata(result, mapCommitResultMetadata);
  return ok === result ? message : { ...message, ok };
}

/**
 * Expands applied-commit revisions before consumers parse or hash the result.
 * Tables are scoped to `.ok`, with one combined referenced-byte budget per ACK.
 * Invalid tables and refs throw. Reconstructed responses are deeply frozen;
 * inline responses retain identity. Shared unchanged subtrees may be frozen.
 */
export function expandServerMessageCommitLabels(
  message: FabricValue,
): FabricValue;
export function expandServerMessageCommitLabels(message: unknown): unknown;
export function expandServerMessageCommitLabels(message: unknown): unknown {
  if (!isPlainObject(message)) return message;
  const result = commitResultOf(message);
  if (result === undefined) return message;
  const ok = expandLabelMetadata(result, mapCommitResultMetadata);
  return ok === result ? message : deepFreeze({ ...message, ok });
}

/** Detects result-local tables requiring commit-label negotiation. */
export function hasServerMessageCommitLabelMetadata(message: unknown): boolean {
  if (!isPlainObject(message)) return false;
  const result = commitResultOf(message);
  return result !== undefined &&
    hasLabelMetadata(result, mapCommitResultMetadata);
}

/**
 * Helper for ACK transforms, which recognizes the applied-commit result envelope.
 * Request identifiers are opaque. Revisions or table presence select the codec
 * before parent validation so malformed results cannot hide indexed metadata.
 */
function commitResultOf(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (message.type !== "response" || !isPlainObject(message.ok)) {
    return undefined;
  }
  const result = message.ok;
  return Object.hasOwn(result, "labelTable") ||
      Object.hasOwn(result, "labelPathTable") ||
      Object.hasOwn(result, "revisions")
    ? result
    : undefined;
}

/**
 * Helper for ACK tables, which visits stored set documents and patch operands.
 * Revision identities, sequence numbers, replay markers, and other result fields
 * retain their exact representation. Inline CFC semantics belong to CFC readers.
 */
function mapCommitResultMetadata(
  result: Record<string, unknown>,
  map: MapMetadataValue,
): Record<string, unknown> {
  const validParent = typeof result.branch === "string" &&
    isSequence(result.seq);
  const hasTables = Object.hasOwn(result, "labelTable") ||
    Object.hasOwn(result, "labelPathTable");
  if (!validParent && hasTables) {
    throw new Error("Invalid commit result");
  }
  // Inline-only malformed results belong to the semantic parser: nothing under
  // an invalid parent is compressed, and since no table is present there (see
  // above) a number there is inline data. A reference (a number whose
  // dictionary is present) still requires a valid revision before expansion.
  const mapValue: MapMetadataValue = validParent ? map : (value) => value;
  const tablePresent = {
    label: Object.hasOwn(result, "labelTable"),
    path: Object.hasOwn(result, "labelPathTable"),
  };
  const revisions = mapArray(result.revisions, (revision) => {
    if (!isPlainObject(revision)) {
      return revision;
    }
    const validRevision = typeof revision.id === "string" &&
      typeof revision.branch === "string" &&
      typeof revision.scopeKey === "string" &&
      isSequence(revision.seq) && isSequence(revision.commitSeq) &&
      isSequence(revision.opIndex);
    const mapRevisionValue: MapMetadataValue = validRevision
      ? mapValue
      : (value, field) => {
        if (typeof value === "number" && tablePresent[field]) {
          throw new Error("Invalid commit revision");
        }
        return value;
      };
    if (revision.op === "set") {
      const document = mapLabelMetadataAtPath(
        revision.document,
        [],
        mapRevisionValue,
      );
      return Object.is(document, revision.document)
        ? revision
        : { ...revision, document };
    }
    if (revision.op === "patch") {
      // Applied revisions may acknowledge only identity, with no patch payload.
      if (revision.patches === undefined) return revision;
      const patches = mapArray(
        revision.patches,
        (patch) => mapPatch(patch, mapRevisionValue),
      );
      return patches === revision.patches ? revision : { ...revision, patches };
    }
    return revision;
  });
  return revisions === result.revisions ? result : { ...result, revisions };
}

/** Helper for revision shape checks, which recognizes nonnegative sequence fields. */
function isSequence(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Helper for commit tables, which visits payloads at operation-owned paths. */
function mapCommitMetadata(
  commit: Record<string, unknown>,
  map: MapMetadataValue,
): Record<string, unknown> {
  const operations = mapArray(commit.operations, (operation) => {
    if (!isPlainObject(operation)) throw new Error("Invalid commit operation");
    if (operation.op === "set") {
      const value = mapLabelMetadataAtPath(operation.value, [], map);
      return Object.is(value, operation.value)
        ? operation
        : { ...operation, value };
    }
    if (operation.op === "patch") {
      const patches = mapArray(
        operation.patches,
        (patch) => mapPatch(patch, map),
      );
      return patches === operation.patches
        ? operation
        : { ...operation, patches };
    }
    return operation;
  });
  return operations === commit.operations ? commit : { ...commit, operations };
}

/**
 * Maps only new or compared values carried by a patch. Entry array edits use
 * their element position; moving or removing an existing value carries no payload
 * to transform. Expansion preserves patch order, indices, and pointer strings.
 */
function mapPatch(patch: unknown, map: MapMetadataValue): unknown {
  if (!isPlainObject(patch)) throw new Error("Invalid commit patch");
  if (
    patch.op !== "add" && patch.op !== "replace" && patch.op !== "splice" &&
    patch.op !== "append" && patch.op !== "add-unique" &&
    patch.op !== "remove-by-value"
  ) return patch;
  if (typeof patch.path !== "string") throw new Error("Invalid patch pointer");
  const path = parsePointer(patch.path);
  if (
    patch.op === "add" || patch.op === "replace" ||
    patch.op === "remove-by-value"
  ) {
    const value = mapLabelMetadataAtPath(
      patch.value,
      patch.op === "remove-by-value" ? [...path, "0"] : path,
      map,
    );
    return Object.is(value, patch.value) ? patch : { ...patch, value };
  }
  const field = patch.op === "splice" ? "add" : "values";
  const values = mapArray(
    patch[field],
    (value) => mapLabelMetadataAtPath(value, [...path, "0"], map),
  );
  return values === patch[field] ? patch : { ...patch, [field]: values };
}

/** Helper for operation payloads, which preserves unchanged array identity. */
function mapArray(value: unknown, map: (item: unknown) => unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid commit operation array");
  let changed = false;
  const result = value.map((item: unknown) => {
    const mapped = map(item);
    changed ||= !Object.is(mapped, item);
    return mapped;
  });
  return changed ? result : value;
}
