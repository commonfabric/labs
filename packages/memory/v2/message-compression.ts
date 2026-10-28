/**
 * Encodes and decodes negotiated compression envelopes for memory WebSocket
 * messages. Compressed envelopes use binary WebSocket frames so the gzip
 * payload travels without another encoding layer.
 */

import { getLogger } from "@commonfabric/utils/logger";

/** Frames produced by the compression encoder. */
export type EncodedMemoryMessage = string | Uint8Array<ArrayBuffer>;

/** In-band request and acknowledgement for one connection's send mode. */
export type MemoryCompressionControlMessage = {
  type: "memory.compression";
  requestId: string;
  enabled: boolean;
};

/** WebSocket message forms accepted by the compression decoder. */
export type MemoryMessageFrame =
  | EncodedMemoryMessage
  | ArrayBuffer
  | Uint8Array<ArrayBufferLike>
  | Blob;

const MEMORY_COMPRESSION_MAGIC = [0x6d, 0x63, 0x6d, 0x70] as const;
const MEMORY_COMPRESSION_VERSION = 1;
const MEMORY_COMPRESSION_HEADER_BYTES = 9;

/** Messages below this UTF-8 size stay in their original wire form. */
const MEMORY_COMPRESSION_THRESHOLD_BYTES = 1_024;

/** Maximum expanded size accepted from one compression envelope. */
export const MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES = 256 * 1_024 * 1_024;

const logger = getLogger("memory.compression", {
  enabled: true,
  level: "error",
});

const MAX_GZIP_MEMORY_MESSAGE_BYTES = MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES +
  1_024 * 1_024;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();

/**
 * Preserves message order while applying negotiated compression in both
 * directions of one WebSocket channel.
 */
export class MemoryMessageCompressionChannel {
  #closed = false;
  #incoming: Promise<void> = Promise.resolve();
  #outgoing: Promise<void> = Promise.resolve();
  #receiveCompressionEnabled = false;
  #sendCompressionEnabled = false;
  #sendRaw: (payload: EncodedMemoryMessage) => void;
  #onError: (error: Error) => void;

  /** Constructs an instance around a WebSocket frame sender. */
  constructor(
    sendRaw: (payload: EncodedMemoryMessage) => void,
    onError: (error: Error) => void,
  ) {
    this.#sendRaw = sendRaw;
    this.#onError = onError;
  }

  /** Enables compression envelopes for messages sent after this call. */
  enable(): void {
    this.#receiveCompressionEnabled = true;
    this.#sendCompressionEnabled = true;
  }

  /** Changes whether later sends use compression on a negotiated channel. */
  setSendCompressionEnabled(enabled: boolean): void {
    this.#sendCompressionEnabled = enabled;
  }

  /** Stops queued work and ignores later messages. */
  close(): void {
    this.#closed = true;
  }

  /** Resolves after every message already submitted in either direction. */
  async idle(): Promise<void> {
    await Promise.all([this.#incoming, this.#outgoing]);
  }

  /** Sends one payload after every payload submitted before it. */
  send(
    payload: string,
    beforeSend?: (frame: EncodedMemoryMessage) => void,
  ): void {
    if (this.#closed) return;
    const compressionEnabled = this.#sendCompressionEnabled;
    const send = this.#outgoing.then(async () => {
      if (this.#closed) return;
      const encodeStart = performance.now();
      const frame = compressionEnabled
        ? await encodeCompressedMemoryMessage(payload)
        : payload;
      // The sizes are the row's detail, so a capture can say what a slow
      // encode carried: the payload's length and the frame's.
      logger.timeDetailed(
        () =>
          JSON.stringify({
            payloadChars: payload.length,
            frameBytes: memoryMessageFrameBytes(frame),
          }),
        encodeStart,
        "send",
        "encode",
      );
      if (!this.#closed) {
        // Every send stays on this queue, including uncompressed control and
        // pre-negotiation frames. A mode change therefore cannot move its
        // acknowledgement ahead of compression work already in flight.
        beforeSend?.(frame);
        this.#sendRaw(frame);
      }
    });
    this.#outgoing = send.catch((cause) => this.#fail(cause));
  }

  /** Expands one frame and delivers it after every frame submitted before it. */
  receive(
    frame: MemoryMessageFrame,
    receiver: (payload: string) => void | Promise<void>,
  ): void {
    if (this.#closed) return;
    const receive = this.#incoming.then(async () => {
      if (this.#closed) return;
      const payload = this.#receiveCompressionEnabled
        ? await decodeCompressedMemoryMessage(frame)
        : requireTextFrame(frame);
      if (!this.#closed) await receiver(payload);
    });
    this.#incoming = receive.catch((cause) => this.#fail(cause));
  }

  /** Closes this channel and reports its first asynchronous failure. */
  #fail(cause: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onError(
      cause instanceof Error
        ? cause
        : new Error("Memory message compression failure", { cause }),
    );
  }
}

/** Encodes a compression-mode request as an ordinary inspectable text frame. */
export function encodeMemoryCompressionControlMessage(
  message: Omit<MemoryCompressionControlMessage, "type">,
): string {
  return JSON.stringify({ type: "memory.compression", ...message });
}

/** Parses a compression-mode text frame, returning `null` for memory data. */
export function parseMemoryCompressionControlMessage(
  payload: string,
): MemoryCompressionControlMessage | null {
  if (!payload.startsWith("{")) return null;
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (
      value.type !== "memory.compression" ||
      typeof value.requestId !== "string" || value.requestId.length === 0 ||
      typeof value.enabled !== "boolean"
    ) {
      return null;
    }
    return {
      type: "memory.compression",
      requestId: value.requestId,
      enabled: value.enabled,
    };
  } catch {
    return null;
  }
}

/**
 * Compresses `payload` into a versioned binary envelope when doing so reduces
 * its UTF-8 wire size. Small and incompressible payloads remain text.
 */
export async function encodeCompressedMemoryMessage(
  payload: string,
): Promise<EncodedMemoryMessage> {
  const source = TEXT_ENCODER.encode(payload);
  if (source.byteLength < MEMORY_COMPRESSION_THRESHOLD_BYTES) {
    return payload;
  }
  if (source.byteLength > MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES) {
    return payload;
  }

  const compressed = await collectReadable(
    byteSource(source).pipeThrough(new CompressionStream("gzip")),
    MAX_GZIP_MEMORY_MESSAGE_BYTES,
  );
  const encoded = new Uint8Array(
    MEMORY_COMPRESSION_HEADER_BYTES + compressed.byteLength,
  );
  encoded.set(MEMORY_COMPRESSION_MAGIC);
  encoded[4] = MEMORY_COMPRESSION_VERSION;
  new DataView(encoded.buffer).setUint32(5, source.byteLength);
  encoded.set(compressed, MEMORY_COMPRESSION_HEADER_BYTES);
  return encoded.byteLength < source.byteLength ? encoded : payload;
}

/**
 * Expands one binary compression envelope and returns ordinary memory wire
 * text. Text frames pass through unchanged.
 */
export async function decodeCompressedMemoryMessage(
  frame: MemoryMessageFrame,
): Promise<string> {
  if (typeof frame === "string") return frame;

  const envelope = await parseCompressionEnvelope(frame);
  const expanded = await collectReadable(
    byteSource(envelope.compressed).pipeThrough(
      new DecompressionStream("gzip"),
    ),
    envelope.uncompressedBytes,
  );
  if (expanded.byteLength !== envelope.uncompressedBytes) {
    throw new Error(
      "Memory compression envelope expanded to an unexpected size",
    );
  }
  return TEXT_DECODER.decode(expanded);
}

/** Returns the wire size of a received WebSocket message. */
export function memoryMessageFrameBytes(frame: MemoryMessageFrame): number {
  if (typeof frame === "string") return TEXT_ENCODER.encode(frame).byteLength;
  if (frame instanceof Blob) return frame.size;
  return frame.byteLength;
}

/** Returns whether a WebSocket event carries a supported memory frame. */
export function isMemoryMessageFrame(
  frame: unknown,
): frame is MemoryMessageFrame {
  return typeof frame === "string" || frame instanceof ArrayBuffer ||
    frame instanceof Uint8Array || frame instanceof Blob;
}

/**
 * A stream that yields `bytes` as its only chunk, from a JavaScript-defined
 * source. It stands in for `new Response(bytes).body`, which is not used here:
 * WebKit (Safari 26.6, WebKit 7624) builds a buffer-backed `Response` body as
 * a byte stream whose first pull is issued during construction and is never
 * settled, and a byte stream with a pending pull stays reachable for the life
 * of its realm. A JavaScript source has no such pull, so the stream is garbage
 * once collected.
 */
function byteSource(
  bytes: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Collects `readable`, refusing output beyond `maximumBytes`. */
async function collectReadable(
  readable: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Memory compression envelope expands beyond its limit");
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Parses and validates the fixed binary compression-envelope header. */
async function parseCompressionEnvelope(
  frame: Exclude<MemoryMessageFrame, string>,
): Promise<{ uncompressedBytes: number; compressed: Uint8Array<ArrayBuffer> }> {
  const bytes = frame instanceof Blob
    ? new Uint8Array(await frame.arrayBuffer())
    : frame instanceof Uint8Array
    ? new Uint8Array(frame)
    : new Uint8Array(frame);
  const headerMatches = bytes.byteLength >= MEMORY_COMPRESSION_HEADER_BYTES &&
    MEMORY_COMPRESSION_MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[4] === MEMORY_COMPRESSION_VERSION;
  if (!headerMatches) {
    throw new Error("Invalid memory compression envelope");
  }
  const uncompressedBytes = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    MEMORY_COMPRESSION_HEADER_BYTES,
  ).getUint32(5);
  const compressed = bytes.slice(MEMORY_COMPRESSION_HEADER_BYTES);
  if (
    uncompressedBytes > MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES ||
    compressed.byteLength > MAX_GZIP_MEMORY_MESSAGE_BYTES
  ) {
    throw new Error("Invalid memory compression envelope");
  }
  return { uncompressedBytes, compressed };
}

/** Refuses binary frames before compression has been negotiated. */
function requireTextFrame(frame: MemoryMessageFrame): string {
  if (typeof frame !== "string") {
    throw new Error("Memory websocket expects text before negotiation");
  }
  return frame;
}
