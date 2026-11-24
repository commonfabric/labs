/**
 * The record a space's blob store keeps for each blob, the rules that decide
 * what one may hold, and how a blob is named. A record is the document
 * `cid:<id>` of the blob's space, where `<id>`, the blob's id, is the hash of
 * the whole record, so a record never changes: the same bytes under another
 * name are another blob. `storeBlob()`, the blob store's upload route and
 * `nameBlob()` all write records, and all hold them to these rules.
 */

import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { DID } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import type { URI } from "@commonfabric/memory/interface";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { Runtime } from "./runtime.ts";

/** The most bytes a blob's file name may take as UTF-8. */
export const MAX_BLOB_FILE_NAME_BYTES = 1024;

/**
 * The most bytes a blob record may take in its JSON encoding (see
 * {@link encodedBlobRecordBytes}), which carries the bytes as unpadded
 * base64url: a record of about 7.86 MB of bytes, with a short name and media
 * type, fits.
 *
 * An upload is refused above this before anything is sent. The bound is well
 * under what one commit can carry on a direct memory connection, which refuses
 * a message over 64 MiB by closing the socket. A direct connection declares no
 * bound of its own, so the memory client then sends the same commit again on
 * each new connection: a record of 64 MiB of incompressible bytes takes the
 * connection down again and again, for up to two minutes, before its commit
 * fails. A routed connection takes 4 MiB in one request
 * (`ROUTED_QUEUE_LIMIT`), and the memory client refuses a commit past what its
 * connection takes, unsent, so there an upload of a record past about 4 MiB is
 * refused that way.
 */
export const MAX_BLOB_RECORD_BYTES = 10 * 1024 * 1024;

/** The extension a blob of each of these media types is served under. */
const DEFAULT_SUFFIX_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** An extension a blob may be served under. */
const VALID_SUFFIX = /^[A-Za-z0-9]{1,8}$/;

/**
 * The codec of a record's JSON encoding, which keeps its bytes a `FabricBytes`
 * whatever JSON flags the process runs with.
 */
const blobRecordCodec = newDefaultJsonCodecEngine();

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

/** A blob, by the DID of the space whose blob store holds it and its id there. */
export type BlobReference = { space: DID; id: string };

/**
 * Returns `value` as a reference to a blob when it names one, by a space's DID
 * and a non-empty id, or `undefined` when it names none.
 */
export function blobReferenceOf(value: unknown): BlobReference | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const { space, id } = value;
  return isDID(space) && typeof id === "string" && id !== ""
    ? { space, id }
    : undefined;
}

/** Returns the id of the document holding the record of the blob `blobId`. */
export function blobDocumentId(blobId: string): URI {
  return `cid:${blobId}`;
}

/**
 * Returns the number of bytes `record` takes in its JSON encoding, the form
 * the blob store's upload route takes it in, which
 * {@link MAX_BLOB_RECORD_BYTES} bounds.
 */
export function encodedBlobRecordBytes(record: BlobRecord): number {
  return new TextEncoder().encode(blobRecordCodec.encode(record)).byteLength;
}

/**
 * Stores `record` in the blob store of `space`, and returns the blob's id. The
 * record is staged as the document `cid:<id>` in a transaction committed on
 * `runtime`'s session there, so the memory server admits it only for a
 * principal holding `WRITE` on the space, and the call settles once the commit
 * does. While the session's connection is down, it waits for the connection,
 * and the commit is sent once it is back.
 *
 * @throws Error when `record` has a name that is not a file name a blob may
 *   hold (see {@link isBlobFileName}), when it would take more than
 *   {@link MAX_BLOB_RECORD_BYTES} encoded, or when the commit is refused. A
 *   commit larger than the space's connection takes in one request is refused
 *   without being sent.
 */
export async function storeBlob(
  runtime: Runtime,
  space: DID,
  record: BlobRecord,
): Promise<string> {
  if (record.name !== undefined && !isBlobFileName(record.name)) {
    throw new Error("The name given is not one a blob may hold");
  }
  const size = encodedBlobRecordBytes(record);
  if (size > MAX_BLOB_RECORD_BYTES) {
    throw new Error(
      `Blob upload failed: a blob takes at most ${MAX_BLOB_RECORD_BYTES} ` +
        `bytes encoded, and this one takes ${size}`,
    );
  }
  const tx = runtime.edit();
  const id = tx.stageContentAddressedDocument(space, record)
    .slice("cid:".length);
  runtime.prepareTxForCommit(tx);
  const result = await tx.commit().settled;
  if (result.error) {
    throw new Error(`Blob upload failed: ${result.error.message}`);
  }
  return id;
}

/**
 * Returns the extension a blob of media type `type` is served under when the
 * name `fileName` is asked for it: the text after the name's last dot when it
 * is one to eight ASCII letters and digits, or else the usual extension for
 * `type`, or else `bin`.
 */
export function blobSuffix(fileName: string | undefined, type: string): string {
  const extension = fileName?.includes(".")
    ? fileName.split(".").pop()
    : undefined;
  if (extension && VALID_SUFFIX.test(extension)) return extension;
  return Object.hasOwn(DEFAULT_SUFFIX_BY_TYPE, type)
    ? DEFAULT_SUFFIX_BY_TYPE[type]
    : "bin";
}

/**
 * Returns the path, relative to its space's path, that the blob store serves
 * the blob `blobId` at under the extension `suffix`.
 */
export function storedBlobPath(blobId: string, suffix: string): string {
  const hash = blobId.startsWith("fid1:")
    ? blobId.slice("fid1:".length)
    : blobId;
  return `blobs/${hash}.${suffix}`;
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
