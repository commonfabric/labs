import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isDID } from "@commonfabric/identity/did";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  asStoredBlobRecord,
  blobDocumentId,
  type BlobRecord,
  blobSuffix,
  isBlobFileName,
  MAX_BLOB_RECORD_BYTES,
  storedBlobPath,
} from "@commonfabric/runner/blob-record";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { Context } from "@hono/hono";
import { cors } from "@hono/hono/cors";

import { createRouter } from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const router = createRouter();

// A page on any origin may upload a blob and read the reply, and may read a
// blob's bytes; a preflight admits `Content-Type` and no other header. Hono
// runs middleware in the order the app mounts it, and a preflight is answered
// by the first `cors()` it reaches. The `routes/static` and `routes/shell`
// routers each put one on every path, listing no `POST` and admitting any
// header asked for, so this policy is the one a preflight gets only while the
// app mounts this router ahead of those two.
for (const path of ["/:spaceDid/blobs", "/:spaceDid/blobs/*"]) {
  router.use(
    path,
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );
}

const SAFE_RESPONSE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

class BlobPayloadTooLarge extends Error {
  constructor() {
    super("Blob payload too large");
    this.name = "BlobPayloadTooLarge";
  }
}

/**
 * Returns `value` as blob contents if its body is a `FabricBytes`, the one form
 * an upload may take, and its `name`, if it has one, is a file name (see
 * `isBlobFileName()`), or `undefined` otherwise.
 */
const asBlobRecord = (value: unknown): BlobRecord | undefined => {
  if (
    !isObjectNotArray(value) || typeof value.type !== "string" ||
    !(value.body instanceof FabricBytes)
  ) {
    return undefined;
  }
  if (value.name === undefined) {
    return { type: value.type, body: value.body };
  }
  return isBlobFileName(value.name)
    ? { type: value.type, body: value.body, name: value.name }
    : undefined;
};

const parseBlobName = (
  blobName: string,
): { id: string; hash: string } | undefined => {
  const hashSegment = blobName.split(".")[0] ?? "";
  const id = hashSegment.startsWith("fid1:")
    ? hashSegment
    : `fid1:${hashSegment}`;
  const hash = id.slice("fid1:".length);
  if (hash.length === 0) {
    return undefined;
  }
  return { id, hash: id.slice("fid1:".length) };
};

const safeResponseType = (type: string): string =>
  SAFE_RESPONSE_TYPES.has(type) ? type : "application/octet-stream";

/**
 * Returns the `Content-Disposition` a blob of media type `type` is served with,
 * naming its file when `name` is given: `inline` for a type served as itself,
 * and `attachment` for one served as `application/octet-stream`, which a
 * browser saves rather than shows, or for any type when `download` asks for the
 * blob to be saved. A name is given twice, as RFC 6266
 * describes: as percent-encoded UTF-8 in `filename*`, and as an ASCII stand-in
 * in `filename`, with `_` for each character a quoted string can't carry, for a
 * client that reads only that one.
 */
const contentDispositionFor = (
  name: string | undefined,
  type: string,
  download: boolean,
): string => {
  const disposition = !download && SAFE_RESPONSE_TYPES.has(type)
    ? "inline"
    : "attachment";
  if (name === undefined) {
    return disposition;
  }
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  // `encodeURIComponent()` leaves `'`, `(`, `)` and `*` as they are, and RFC
  // 5987 admits none of them unencoded.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

const readLimitedText = async (request: Request): Promise<string> => {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BLOB_RECORD_BYTES) {
    throw new BlobPayloadTooLarge();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BLOB_RECORD_BYTES) {
      await reader.cancel();
      throw new BlobPayloadTooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readRequestContents = async (request: Request) => {
  const source = await readLimitedText(request);
  if (!source) {
    return undefined;
  }
  return asBlobRecord(decodeMemoryBoundary(source));
};

const loadBlobRecord = async (
  spaceDid: string,
  id: string,
): Promise<BlobRecord | undefined> => {
  const document = await memoryServer.readDocument(
    spaceDid,
    blobDocumentId(id),
  );
  return asStoredBlobRecord(document?.value);
};

const upload = async (c: Context) => {
  const spaceDid = c.req.param("spaceDid");
  if (!isDID(spaceDid)) {
    return c.text("Invalid space DID", 400);
  }

  let contents: BlobRecord | undefined;
  try {
    contents = await readRequestContents(c.req.raw);
  } catch (error) {
    if (error instanceof BlobPayloadTooLarge) {
      return c.text("Blob payload too large", 413);
    }
    return c.text("Invalid blob payload", 400);
  }
  if (!contents) {
    return c.text("Invalid blob payload", 400);
  }

  const id = hashOf(contents).toString();
  const blobName = c.req.param("blobName") as string | undefined;
  const suffix = blobSuffix(blobName ?? contents.name, contents.type);
  await memoryServer.writeDocument(spaceDid, blobDocumentId(id), contents);

  return c.json({ id, url: storedBlobPath(id, suffix) }, 201);
};

// The upload route takes no credential: anyone can POST a blob into any space
// that already exists, and the record is written directly into the space's
// store (`Server.writeDocument()`), with no principal for the space's access
// list to judge. Content addressing keeps an upload from replacing another
// blob's bytes, but not from adding blobs or taking up a space's storage. So
// while the route is served, a space's access list does not decide who writes
// its blobs, and the FabriFile design's prerequisite that a blob write be
// admitted only for a principal the space admits
// (`docs/specs/fabrifile/README.md`, "Authorized blob reads") is unmet. That
// makes the route a candidate for removal. The authenticated upload is the
// runtime client's, `RuntimeProcessor.handleUploadBlob()` in
// `runtime/runtime-client/src/backends/runtime-processor.ts`: it stages the
// record with `stageContentAddressedDocument()` in a transaction it commits on
// the uploading session, signed by that session's principal, so the memory
// server admits the write only for a principal holding `WRITE` on the space.
router.post("/:spaceDid/blobs", upload);
router.post("/:spaceDid/blobs/:blobName", upload);

// A blob read takes no credential either: anyone who knows a blob's id can
// fetch its bytes from its space.
router.get("/:spaceDid/blobs/:blobName", async (c) => {
  const spaceDid = c.req.param("spaceDid");
  if (!isDID(spaceDid)) {
    return c.text("Invalid space DID", 400);
  }

  const parsed = parseBlobName(c.req.param("blobName"));
  if (!parsed) {
    return c.text("Invalid blob name", 400);
  }
  const { id } = parsed;
  const contents = await loadBlobRecord(spaceDid, id);
  if (!contents) {
    return c.text("Blob not found", 404);
  }

  const body = contents.body.slice();
  // `nosniff` holds a browser to the `Content-Type` given, so bytes served as
  // `application/octet-stream` are never read as a type it guesses at.
  const headers = new Headers({
    "Content-Type": safeResponseType(contents.type),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    // `?download` asks for the blob to be saved, which a browser does for an
    // `attachment` from any origin, where it honors a link's `download`
    // attribute only from its own.
    "Content-Disposition": contentDispositionFor(
      contents.name,
      contents.type,
      c.req.query("download") !== undefined,
    ),
  });
  return new Response(body, { status: 200, headers });
});

export default router;
