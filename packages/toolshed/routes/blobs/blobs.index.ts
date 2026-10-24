import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isDID } from "@commonfabric/identity/did";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  asStoredBlobRecord,
  blobDocumentId,
  type BlobRecord,
  isBlobFileName,
} from "@commonfabric/runner/blob-record";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { Context } from "@hono/hono";

// Blob routes are intentionally unauthenticated for the MVP. Anyone can POST a
// blob into any space DID; content addressing prevents overwriting a different
// payload, but callers can inject blobs and consume storage. Anyone with a hash
// can GET the blob. Revisit this before any production exposure.
import { createRouter } from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const router = createRouter();

const DEFAULT_SUFFIX_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
const SAFE_RESPONSE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const VALID_SUFFIX = /^[A-Za-z0-9]{1,8}$/;

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

const suffixFor = (blobName: string | undefined, type: string): string => {
  const extension = blobName?.includes(".")
    ? blobName.split(".").pop()
    : undefined;
  if (extension && VALID_SUFFIX.test(extension)) return extension;
  return DEFAULT_SUFFIX_BY_TYPE[type] ?? "bin";
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
  if (Number.isFinite(contentLength) && contentLength > MAX_BLOB_UPLOAD_BYTES) {
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
    if (total > MAX_BLOB_UPLOAD_BYTES) {
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
  const suffix = suffixFor(blobName ?? contents.name, contents.type);
  const hash = id.slice("fid1:".length);
  await memoryServer.writeDocument(spaceDid, blobDocumentId(id), contents);

  return c.json({ id, url: `blobs/${hash}.${suffix}` }, 201);
};

router.post("/:spaceDid/blobs", upload);
router.post("/:spaceDid/blobs/:blobName", upload);

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
