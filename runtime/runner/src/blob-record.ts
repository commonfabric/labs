/**
 * The record a space's blob store keeps for each blob, and the rules that
 * decide what one may hold. A record is the document `cid:<id>` of the blob's
 * space, where `<id>`, the blob's id, is the hash of the whole record, so a
 * record never changes: the same bytes under another name are another blob.
 * The blob store's routes and `nameBlob()` both write records, and both hold
 * them to these rules.
 */

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { URI } from "@commonfabric/memory/interface";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** The most bytes a blob's file name may take as UTF-8. */
export const MAX_BLOB_FILE_NAME_BYTES = 1024;

/**
 * A blob as its space's blob store keeps it: its media type, its bytes, and,
 * when it was stored with one, the name of the file they came from.
 */
export type BlobRecord = {
  /** The media type of the bytes. */
  type: string;

  /** The bytes. */
  body: FabricBytes;

  /** The name of the file the bytes came from, if they have one. */
  name?: string;
};

/**
 * Indicates whether `name` may name the file a blob holds: a non-empty string
 * of well-formed Unicode, one with no unpaired surrogate, of at most
 * {@link MAX_BLOB_FILE_NAME_BYTES} bytes as UTF-8. A download offers the name
 * as one to save under, encoded so that no character of it can reach a header
 * as itself, so a name is held to no rule of a file system's. The encoding is
 * what needs it well-formed, and the bound keeps the header it is written into
 * to a few kilobytes.
 */
export function isBlobFileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.isWellFormed() &&
    new TextEncoder().encode(name).byteLength <= MAX_BLOB_FILE_NAME_BYTES;
}

/** Returns the id of the document holding the record of the blob `blobId`. */
export function blobDocumentId(blobId: string): URI {
  return `cid:${blobId}`;
}

/**
 * Returns the stored value `value` as a blob record, or `undefined` when it is
 * not one. A record's body is a `FabricBytes`, the one form an upload takes, or
 * one of the byte-shaped forms an older store may hold, which is read as bytes.
 * A `name` that is not a file name (see {@link isBlobFileName}) is dropped
 * rather than refused, so that the blob is still read, under no name.
 */
export function asStoredBlobRecord(value: unknown): BlobRecord | undefined {
  if (!isObjectNotArray(value) || typeof value.type !== "string") {
    return undefined;
  }
  const name = isBlobFileName(value.name) ? { name: value.name } : {};
  if (value.body instanceof FabricBytes) {
    return { type: value.type, body: value.body, ...name };
  }
  const bytes = toByteArray(value.body);
  if (bytes) {
    return { type: value.type, body: new FabricBytes(bytes, true), ...name };
  }
  return undefined;
}

/**
 * Helper for {@link asStoredBlobRecord}, which interprets a stored blob's body
 * as bytes, or returns `undefined` when it is not byte-shaped. The result is
 * always freshly allocated and unshared, so a caller may cede it to something
 * that takes ownership of a buffer.
 */
function toByteArray(value: unknown): Uint8Array | undefined {
  // The copy is what makes the contract above hold for this arm, and so is what
  // lets the caller cede the result.
  // TODO(seefeldb): This arm may be unreachable. Every value reaching here is
  // decoded from a string, and binary in a string form arrives as a
  // `FabricBytes`, which the caller returns before asking this. Remove the arm
  // and its copy once that is confirmed.
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value);
  }
  if (!isObjectNotArray(value)) {
    return undefined;
  }

  // `Object.entries()` lists an object's array-index keys first, in ascending
  // order, so a record of bytes lists each key at its own position. Any other
  // entry, or a value that is not a byte, makes the body not byte-shaped.
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(([key, item], position) =>
      key !== String(position) || typeof item !== "number" ||
      !Number.isInteger(item) || item < 0 || item > 255
    )
  ) {
    return undefined;
  }
  return Uint8Array.from(entries, ([, item]) => item as number);
}
