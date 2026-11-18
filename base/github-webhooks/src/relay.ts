/**
 * Reading the GitHub webhook relay, which writes each delivery of the
 * organization's webhook to every TCP connection open to it the moment GitHub
 * makes the delivery, and keeps nothing for a subscriber that is not
 * connected. The relay is described in `github-webhook-relay/README.md` in the
 * infra repository.
 *
 * Each delivery reaches a subscriber as a frame: the length of the HTTP
 * request GitHub made, as a 32-bit big-endian unsigned integer, and then that
 * request.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

/** One delivery of the organization's webhook. */
export interface GitHubDelivery {
  /** The kind of activity, from the `X-GitHub-Event` header. */
  readonly event: string;

  /** The body GitHub signed, parsed. */
  readonly payload: unknown;
}

/** A connection to the relay, as far as a subscriber uses one. */
export interface RelayConnection {
  readonly readable: ReadableStream<Uint8Array>;
  close(): void;
}

/** Opens a connection to the relay, giving up when `signal` aborts. */
export type RelayConnect = (signal?: AbortSignal) => Promise<RelayConnection>;

/** What a frame from the relay carried: a delivery, or why it carried none. */
export type RelayFrame =
  | { readonly delivery: GitHubDelivery; readonly unreadable?: undefined }
  | { readonly delivery?: undefined; readonly unreadable: string };

/**
 * The longest frame a reader accepts. The relay drops a subscriber once 32
 * MiB of deliveries are waiting for it, so no frame it sends is longer.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const DECODER = new TextDecoder();

/**
 * Returns the `RelayConnect` for the relay at `address`, as `host:port`, with
 * TCP keepalive on each connection, or `undefined` for an empty address. An
 * address that names no host and port fails each connection.
 */
export function relayAddress(address: string): RelayConnect | undefined {
  if (address === "") return undefined;
  return async (signal) => {
    const { hostname, port } = new URL(`tcp://${address}`);
    if (port === "") throw new Error(`"${address}" names no port`);
    const connection = await Deno.connect({
      hostname: hostname.replace(/^\[(.*)\]$/, "$1"),
      port: Number(port),
      signal,
    });
    connection.setKeepAlive(true);
    return connection;
  };
}

/**
 * Reads the next frame from `frames`, and returns what it carried, or
 * `undefined` when the stream ends before a whole frame has arrived. Throws
 * for a frame longer than `MAX_FRAME_BYTES`, which shows that the stream is
 * not the relay's.
 */
export async function readDelivery(
  frames: FrameReader,
): Promise<RelayFrame | undefined> {
  const prefix = await frames.read(4);
  if (prefix === undefined) return undefined;
  const length = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).getUint32(0);
  if (length > MAX_FRAME_BYTES) {
    throw new Error(
      `a frame of ${length} bytes is longer than the relay sends`,
    );
  }
  const request = await frames.read(length);
  return request === undefined ? undefined : parseDelivery(request);
}

/** Reads a byte stream in pieces of the lengths asked for. */
export class FrameReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #held = 0;

  /** Constructs an instance which reads `readable`. */
  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  /**
   * Reads the next `length` bytes, or returns `undefined` when the stream
   * ends first.
   */
  async read(length: number): Promise<Uint8Array | undefined> {
    while (this.#held < length) {
      const { done, value } = await this.#reader.read();
      if (done) return undefined;
      this.#chunks.push(value);
      this.#held += value.length;
    }
    this.#held -= length;
    const first = this.#chunks[0];
    if (first !== undefined && first.length >= length) {
      // The bytes asked for are in one chunk, and are handed out in place.
      this.#take(first, length);
      return first.subarray(0, length);
    }
    const bytes = new Uint8Array(length);
    let filled = 0;
    let emptied = 0;
    for (const chunk of this.#chunks) {
      const taken = Math.min(chunk.length, length - filled);
      bytes.set(chunk.subarray(0, taken), filled);
      filled += taken;
      if (taken < chunk.length) {
        this.#chunks[emptied] = chunk.subarray(taken);
        break;
      }
      emptied++;
      if (filled === length) break;
    }
    this.#chunks.splice(0, emptied);
    return bytes;
  }

  /** Ends the stream, so that a read under way returns `undefined`. */
  cancel(): void {
    // A stream that failed rejects the cancel as it does the read under way,
    // which reports the failure.
    this.#reader.cancel().catch(() => {});
  }

  /** Stops reading the stream. */
  release(): void {
    this.#reader.releaseLock();
  }

  /** Helper for `read()`, which drops `length` bytes from `chunk`, the first. */
  #take(chunk: Uint8Array, length: number): void {
    if (length === chunk.length) this.#chunks.shift();
    else this.#chunks[0] = chunk.subarray(length);
  }
}

/**
 * Helper for `readDelivery()`, which reads the delivery an HTTP request from
 * GitHub carries, or says why it carries none.
 */
function parseDelivery(request: Uint8Array): RelayFrame {
  const end = headEnd(request);
  if (end === -1) return { unreadable: "a request had no end to its head" };
  const headers = new Map<string, string>();
  const head = DECODER.decode(request.subarray(0, end));
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
    }
  }
  const event = headers.get("x-github-event");
  if (event === undefined) return { unreadable: "a request named no event" };
  const body = DECODER.decode(request.subarray(end + 4));
  try {
    const form = headers.get("content-type")?.startsWith(
      "application/x-www-form-urlencoded",
    );
    const json = form ? new URLSearchParams(body).get("payload") : body;
    if (json === null) throw new Error("the form carries no payload");
    return { delivery: { event, payload: JSON.parse(json) } };
  } catch (error) {
    return {
      unreadable: `a ${event} delivery could not be read: ${
        describeFailure(error)
      }`,
    };
  }
}

/**
 * Helper for `parseDelivery()`, which returns where the empty line ending
 * `request`'s head starts, or -1 when it has none.
 */
function headEnd(request: Uint8Array): number {
  for (let i = 0; i + 3 < request.length; i++) {
    if (
      request[i] === 13 && request[i + 1] === 10 && request[i + 2] === 13 &&
      request[i + 3] === 10
    ) return i;
  }
  return -1;
}
