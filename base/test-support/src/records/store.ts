/**
 * The one write the store accepts: creating an object that does not exist
 * yet. Object names are deterministic, so shipping the same records twice
 * collides on create — which is not overwrite — and the duplicate never
 * comes into being. The writer credential holds objectCreator, which cannot
 * read, list, overwrite, or delete.
 */

/**
 * Gzips a sequence of text chunks into one member, with the web-standard
 * streams; repo lint forbids node: imports. The chunks are pulled one at a
 * time and compressed as they arrive, so the caller never holds the whole
 * text: what is held is one chunk plus the compressed result. A source that
 * reads its chunks from the network can therefore build an object far
 * larger than V8's maximum string length.
 */
export async function gzipChunks(
  chunks: AsyncIterable<string> | Iterable<string>,
): Promise<Uint8Array> {
  const stream = ReadableStream.from(chunks)
    .pipeThrough(new TextEncoderStream())
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gzips one string; the single-chunk case of `gzipChunks`. */
export function gzipText(text: string): Promise<Uint8Array> {
  return gzipChunks([text]);
}

/** Gunzips bytes back to text; the reader side of `gzipText`. */
export async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}

export interface CreateObjectOptions {
  bucket: string;

  /** Full object name, prefix included. */
  name: string;

  body: Uint8Array;
  token: string;
  contentType?: string;

  /** Set to "gzip" so plain HTTPS readers receive NDJSON via transcoding. */
  contentEncoding?: string;

  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export type CreateObjectResult = "created" | "exists";

/**
 * Creates one object, failing the precondition instead of overwriting when
 * the name is already stored. Returns "exists" on that precondition
 * failure, which callers treat as already shipped. One request, no retries.
 */
export async function createObject(
  options: CreateObjectOptions,
): Promise<CreateObjectResult> {
  const doFetch = options.fetch ?? fetch;
  const metadata: Record<string, string> = { name: options.name };
  if (options.contentType !== undefined) {
    metadata.contentType = options.contentType;
  }
  if (options.contentEncoding !== undefined) {
    metadata.contentEncoding = options.contentEncoding;
  }
  const boundary = `records-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${options.contentType ?? "application/octet-stream"}\r\n` +
      "\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    head.length + options.body.length + tail.length,
  );
  body.set(head, 0);
  body.set(options.body, head.length);
  body.set(tail, head.length + options.body.length);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${
    encodeURIComponent(options.bucket)
  }/o?uploadType=multipart&ifGenerationMatch=0`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (res.status === 412) {
    // Read and discard so the connection is reusable.
    await res.text();
    return "exists";
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `creating ${options.name} in ${options.bucket} failed: ` +
        `HTTP ${res.status} ${detail}`,
    );
  }
  await res.text();
  return "created";
}

/** OAuth scope for the store writers; IAM narrows it to create-only. */
export const STORE_WRITE_SCOPE =
  "https://www.googleapis.com/auth/devstorage.read_write";
