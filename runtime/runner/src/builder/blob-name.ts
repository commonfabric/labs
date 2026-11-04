import { debugStr } from "@commonfabric/data-model";

import {
  asStoredBlobRecord,
  blobDocumentId,
  type BlobRecord,
  isBlobFileName,
} from "../blob-record.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { withdrawHandlerWhileLoading } from "../scheduler/handler-load-wait.ts";
import { topFrame } from "./frame-context.ts";
import { spaceOfTarget } from "./space-access.ts";

/**
 * Returns the id of a blob holding the bytes and media type of the blob
 * `blobId` under the file name `name`, in the space `target`'s value lives in,
 * staging that blob's record in the running handler's transaction when the
 * space does not already hold it. A blob already named `name` is its own
 * answer, and nothing is staged.
 *
 * Returns `undefined` when the space holds no record of `blobId`, as
 * `asStoredBlobRecord()` reads one. A record still loading is not one of
 * those: the handler is withdrawn, and runs again
 * once the record arrives.
 *
 * The record staged carries no label, as no blob record does, so `name` is
 * readable by anyone who can fetch the blob. Its id is the hash of the name,
 * the media type and the bytes together, so fetching it takes knowing all three
 * already, and a correct guess at all three is confirmed by fetching.
 *
 * @throws Error when called anywhere but a handler, when `target` is not a
 *   cell, when `blobId` is not a non-empty string, or when `name` is not a
 *   file name a blob may hold (see {@link isBlobFileName}).
 */
export function nameBlob(
  target: unknown,
  blobId: unknown,
  name: unknown,
): string | undefined {
  const frame = topFrame();
  if (frame?.frameKind !== "handler") {
    throw new Error("`nameBlob()` can only be called from a handler.");
  }
  const { runtime, tx } = frame;
  if (runtime === undefined || tx === undefined) {
    throw new Error("`nameBlob()` requires an executing runtime.");
  }
  if (typeof blobId !== "string" || blobId.length === 0) {
    throw new Error(
      debugStr`\`nameBlob()\` takes a blob id as its \`blobId\`, not $quote${blobId}.`,
    );
  }
  if (!isBlobFileName(name)) {
    throw new Error(
      debugStr`\`nameBlob()\` takes a non-empty string of well-formed Unicode as its \`name\`, not $quote${name}.`,
    );
  }

  const space = spaceOfTarget(target, "nameBlob()");
  const link: NormalizedFullLink = {
    space,
    id: blobDocumentId(blobId),
    scope: "space",
    path: [],
  };
  // A record is reached by its id, never through a link that would already
  // have started its load, so the load is started here.
  runtime.ensureLinkedDocLoaded(link);
  const record = asStoredBlobRecord(tx.readValueOrThrow(link));
  withdrawHandlerWhileLoading(
    runtime,
    tx,
    link,
    `the record of blob \`${blobId}\` was read while it was still loading`,
  );
  if (record === undefined) return undefined;
  if (record.name === name) return blobId;

  const named: BlobRecord = { type: record.type, body: record.body, name };
  return tx.stageContentAddressedDocument(space, named).slice("cid:".length);
}
