import { debugStr, hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import {
  encodeMemoryBoundary,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type EncodedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  isMemoryMessageFrame,
  parseMemoryCompressionControlMessage,
} from "@commonfabric/memory/v2/message-compression";
import {
  MAX_ROUTED_LEASE_SECONDS,
  readRoutedHex,
  ROUTED_CHALLENGE_SECONDS,
  routedBase64,
  routedStatementPayload,
} from "@commonfabric/memory/v2/routed-wire";
import {
  compressRoutedPayload,
  decodeRoutedFrame,
  decodeRoutedFrameAsync,
  encodeRoutedFrame,
} from "@commonfabric/memory/v2/routed-parser";
import {
  isRouterControl,
  ROUTER_CHUNK_BYTES,
  ROUTER_UPLOAD_WINDOW,
  routerRecords,
  routerRoute,
} from "@commonfabric/memory/v2/router-protocol";
import { getLogger } from "@commonfabric/utils/logger";
import { utf8ByteLength } from "@commonfabric/utils/utf8";
import { normalizeSpaceHost, SpaceHostValidationError } from "../space-host.ts";
import type { MemoryConnectionSizes } from "./diagnostics.ts";
import {
  createMemorySocket,
  type MemorySocket,
  type MemorySocketConnection,
  type MemorySocketFactory,
} from "./memory-socket.ts";

const logger = getLogger("storage.v2.remote", {
  enabled: true,
  level: "error",
});

/**
 * Default JSON value count for routed frames when the server omits
 * `routerFrameSlots`. Values count as the router counts them: one per value,
 * keys free. A negotiated positive integer replaces this bound, and `null`
 * disables slot counting while retaining the other routed frame checks.
 */
export const ROUTED_FRAME_SLOTS = 150_000;

/**
 * How long one credited record waits for the router's credit before its send
 * fails. Credit acknowledges receipt of earlier records, so a router that has
 * stopped acknowledging has stopped reading; the failure carries the
 * write-failure tag, which resets the connection rather than retrying the
 * payload on it.
 */
export const ROUTER_CREDIT_WAIT_MS = 60_000;

/**
 * Bound on the native WebSocket send queue while streaming records without
 * peer credit. Credit, when negotiated, is the signal that lets the queue
 * drain, so this check is live only for a streaming selection that has none.
 */
const ROUTER_NATIVE_QUEUE_BYTES = 4 * 1024 * 1024;

/** Credit accounting for one selection on one socket. */
type RouterUploadCredits = {
  /** Maximum bytes sent without an acknowledgement. */
  window: number;

  /** Record bytes sent but not yet acknowledged by the peer. */
  outstanding: number;

  /** Current send's wait for enough credit to write its next record. */
  waiter?: PromiseWithResolvers<void>;
};

/** A raw routed frame, checked as its receiver checks it before it is sent. */
function checkedRoutedText(
  payload: string,
  frameSlots: number | null = ROUTED_FRAME_SLOTS,
): string {
  decodeRoutedFrame(payload, false, frameSlots);
  return payload;
}

/**
 * The connection a session was opened on, as far as the session's holder may
 * use it. A `MemoryClient.Client` holding one session is one, and so is a
 * holder's share of a client that holds several.
 */
export interface SessionConnection {
  /** Flags the server advertised; `null` before the first handshake. */
  readonly serverFlags: MemoryProtocolFlags | null;

  /**
   * Resolves once every server frame the connection held at the call has
   * been handed to its client.
   */
  delivered(): Promise<void>;

  /**
   * Ends the holder's session. The connection itself closes with it when
   * nothing else can be using it.
   */
  close(): Promise<void>;

  /**
   * Ends the connection's authentication of `principal`, for a key no later
   * session will use, such as a created space's. Only a share of a
   * connection that outlives the session has one; a connection that closes
   * with its session has nothing to release.
   */
  releasePrincipal?(principal: string): Promise<void>;
}

export interface SessionFactory {
  /** Opt in to StorageManager's ACL genesis handshake. Scripted factories used
   *  by lower-level replica tests omit this because they intentionally model
   *  only the messages under test. */
  readonly supportsAclBootstrap?: boolean;

  create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions?: MemoryClient.MountOptions,
    signal?: AbortSignal,
  ): Promise<{
    client: SessionConnection;
    session: MemoryClient.SpaceSession;
  }>;

  /** Changes compression on live sessions and the default for later ones. */
  setMessageCompressionEnabled?(enabled: boolean): Promise<void>;

  /**
   * The flags the memory server serving `space` advertises, read from a
   * handshake alone. No session is opened on `space`, so nothing a server
   * does when a session opens there, such as starting to serve the space,
   * happens. `null` when the handshake carries none.
   */
  serverFlags?(
    space: MemorySpace,
    signal?: AbortSignal,
  ): Promise<MemoryProtocolFlags | null>;

  /**
   * Calls `observer` with each `session/admissible` a connection the factory
   * opened is sent: a space that refused `principal` on that connection and
   * would now admit it. Returns the function that ends the subscription.
   */
  subscribeAdmissible?(
    observer: (space: MemorySpace, principal: string) => void,
  ): () => void;

  /**
   * Chooses, for the sessions created from here on, between one connection
   * per host and one per space.
   */
  setSharedConnections?(enabled: boolean): void;

  /** Closes every connection the factory keeps open between sessions. */
  close?(): Promise<void>;

  /** What the factory's connections have carried, for the sizes read. */
  getSizes?(): MemoryConnectionSizes;
}

export const toWebSocketAddress = (address: URL): URL => {
  const next = new URL(address);
  if (next.protocol === "https:") {
    next.protocol = "wss:";
  } else if (next.protocol === "http:") {
    next.protocol = "ws:";
  }
  return next;
};

export const toSpaceWebSocketAddress = (
  address: URL,
  space: MemorySpace,
): URL => {
  const next = toWebSocketAddress(address);
  next.searchParams.set("space", space);
  return next;
};

/** Path every memory host serves its storage endpoint under. */
export const MEMORY_STORAGE_PATH = "/api/storage/memory";

/**
 * Resolves a shared HTTP or HTTPS space host to the memory storage endpoint.
 * Space hosts also serve compute requests, so WebSocket-only URLs are not
 * valid routes.
 */
export const storageAddressForHost = (host: string | URL): URL => {
  return new URL(MEMORY_STORAGE_PATH, normalizeSpaceHost(host));
};

const storageAddressForMemoryHost = (host: URL): URL => {
  const parsed = new URL(host);
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    throw new TypeError(
      `Unsupported memory host protocol: ${parsed.protocol}`,
    );
  }
  return new URL(MEMORY_STORAGE_PATH, parsed);
};

/**
 * Validity window stamped onto each signed `session.open`.
 * `session.open` is a live handshake sent when a connection opens, so a few
 * minutes covers clock skew and round-trip time while bounding replay.
 */
export const SESSION_OPEN_TTL_SECONDS = 300;

/**
 * Lease a signed direct `connection.auth` asks for, in seconds: the server
 * caps it at its own limit, and the client renews ahead of whatever it
 * granted. A routed statement asks for MAX_ROUTED_LEASE_SECONDS, the longest
 * a router admits.
 */
export const CONNECTION_AUTH_LEASE_SECONDS = 3600;

/**
 * Builds the per-space storage-endpoint resolver: a space present in
 * `spaceHostMap` resolves against that host's origin, everything else
 * against `defaultHost`. Host selection lives here, next to the
 * websocket address builders, so the storage-endpoint join happens in
 * exactly one place.
 *
 * Map entries are validated eagerly so a malformed host fails at
 * configuration time with the offending space named, not later inside
 * session creation as a bare `Invalid URL`.
 */
export const createStorageAddressResolver = (
  defaultHost: URL,
  spaceHostMap?: Record<string, string>,
  /**
   * Late-bound host hints mapping a space DID to an HTTP or HTTPS origin.
   * Learned at runtime, e.g. from the home-space site table. Consulted AFTER the
   * seed map and BEFORE the default. The caller keeps the first accepted
   * hint stable, including after the space opens.
   */
  dynamicHosts?: ReadonlyMap<string, string>,
): (space: MemorySpace) => URL => {
  const overrides = new Map<string, URL>();
  for (const [space, host] of Object.entries(spaceHostMap ?? {})) {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid spaceHostMap entry for ${space}`,
        { cause },
      );
    }
    overrides.set(space, new URL(MEMORY_STORAGE_PATH, route));
  }
  const fallback = storageAddressForMemoryHost(defaultHost);
  return (space) => {
    const seeded = overrides.get(space);
    if (seeded) return new URL(seeded);
    const dynamic = dynamicHosts?.get(space);
    if (dynamic) return storageAddressForHost(dynamic);
    return new URL(fallback);
  };
};

/** The traffic one transport has carried, counted as `frameSize()` counts. */
export type TransportSizes = {
  /** Frames handed to a socket. */
  messagesSent: number;

  /** The size of every frame handed to a socket. */
  bytesSent: number;

  /** Frames a socket delivered. */
  messagesReceived: number;

  /** The size of every frame a socket delivered. */
  bytesReceived: number;
};

/**
 * The size of a frame on the wire: a text frame its UTF-8 size, counted
 * from its code units without encoding it, a binary frame its bytes.
 * Neither allocates, which is what lets every frame be counted.
 */
function frameSize(frame: unknown): number {
  if (typeof frame === "string") return utf8ByteLength(frame);
  if (frame instanceof Blob) return frame.size;
  if (frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)) {
    return frame.byteLength;
  }
  return 0;
}

export class WebSocketTransport implements MemoryClient.Transport {
  #address: URL;
  #createSocket: MemorySocketFactory;
  #compressionNegotiated = false;
  #compressionPreference: boolean;
  #compressionRequests = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<boolean>>
  >();
  #disposed = false;
  #onDispose: () => void;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #socket: MemorySocket | null = null;
  #connection: MemorySocketConnection | null = null;
  #opening: Promise<MemorySocketConnection> | null = null;
  #receiveCompressionEnabled = false;
  #sendCompressionEnabled = false;
  #routedMessages = false;
  #routedFrameSlots: number | null = ROUTED_FRAME_SLOTS;
  #routerStreaming = false;
  /** Streamed bodies use the routed compression envelope, both ways. */
  #routedCompression = false;
  #uploadCredits: RouterUploadCredits | undefined;
  #sending: Promise<void> = Promise.resolve();
  #receiving: Promise<void> = Promise.resolve();
  #messagesSent = 0;
  #bytesSent = 0;
  #messagesReceived = 0;
  #bytesReceived = 0;

  /** Constructs a transport for one memory WebSocket route. */
  constructor(
    address: URL,
    compressionPreference = true,
    onDispose: () => void = () => {},
    createSocket: MemorySocketFactory = createMemorySocket,
  ) {
    this.#address = address;
    this.#createSocket = createSocket;
    this.#compressionPreference = compressionPreference;
    this.#onDispose = onDispose;
  }

  /** @inheritDoc */
  get supportsMessageCompression(): boolean {
    return typeof CompressionStream === "function" &&
      typeof DecompressionStream === "function";
  }

  /** Bytes the current socket holds queued for the network, if it says. */
  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  /** Whether this transport holds a socket that is open right now. */
  get socketOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * What this transport has handed to its sockets and received from them.
   * `messagesSent` counts logical messages: a streamed message's records
   * count once, though `bytesSent` counts every record's bytes.
   */
  getSizes(): TransportSizes {
    return {
      messagesSent: this.#messagesSent,
      bytesSent: this.#bytesSent,
      messagesReceived: this.#messagesReceived,
      bytesReceived: this.#bytesReceived,
    };
  }

  /**
   * This transport always supports the separately negotiated router transport
   * records; a transport that cannot send them leaves the property false or
   * absent, and the client then selects legacy routed framing.
   */
  readonly supportsRouterStreaming = true;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /**
   * Selects routed framing after a pinned hello. A supported upload window
   * enables peer credit for every logical message after the text selection.
   * `frameSlots` defaults to `ROUTED_FRAME_SLOTS`; `null` disables slot counting.
   * `compressedBodies` selects end-to-end body compression, negotiated as
   * `routedCompressionV1`, on a streamed selection.
   * Throws if a supplied bound is not a positive safe integer or `null`.
   */
  setRoutedMessagesEnabled(
    enabled: boolean,
    transportVersion?: number,
    uploadWindow?: number,
    frameSlots?: number | null,
    compressedBodies?: boolean,
  ): void {
    if (
      frameSlots !== undefined && frameSlots !== null &&
      (!Number.isSafeInteger(frameSlots) || frameSlots <= 0)
    ) {
      throw new TypeError("Invalid routed frame slot limit");
    }
    this.#clearUploadCredits(new Error("Router transport selection changed"));
    this.#routedMessages = enabled;
    this.#routedFrameSlots = enabled && frameSlots !== undefined
      ? frameSlots
      : ROUTED_FRAME_SLOTS;
    this.#routerStreaming = false;
    this.#routedCompression = false;
    if (enabled && transportVersion === 1) {
      if (
        typeof uploadWindow === "number" &&
        Number.isSafeInteger(uploadWindow) &&
        uploadWindow >= ROUTER_CHUNK_BYTES + 5 &&
        uploadWindow <= ROUTER_UPLOAD_WINDOW
      ) {
        this.#uploadCredits = { window: uploadWindow, outstanding: 0 };
      }
      // Selection shares the send queue so no streamed body can overtake it.
      // It is a text write, independent of the mode selected for later sends.
      const opening = this.#open();
      const selection = this.#uploadCredits === undefined
        ? 'fvj1:{"type":"router.transport","version":1}'
        : 'fvj1:{"type":"router.transport","version":1,"uploadCredits":true}';
      const send = this.#sending.then(async () => {
        const connection = await opening;
        if (this.#socket !== connection.socket) {
          throw MemoryClient.connectionError(
            "Memory websocket changed before transport selection",
          );
        }
        this.#messagesSent++;
        await this.#write(connection, selection);
      });
      // `#write()` reports a failure on the current socket. A stale selection
      // must not report a second loss against its replacement.
      this.#sending = send.catch(() => {});
      this.#routerStreaming = true;
      this.#routedCompression = compressedBodies === true;
    }
  }

  /** @inheritDoc */
  setMessageCompressionEnabled(enabled: boolean): void {
    this.#compressionNegotiated = enabled;
    this.#receiveCompressionEnabled = enabled;
    this.#sendCompressionEnabled = enabled && this.#compressionPreference;
    if (enabled && !this.#compressionPreference) {
      void this.#sendCompressionControl(false).catch(reportError);
    }
  }

  /** Changes compression in both directions without reconnecting. */
  async requestMessageCompression(enabled: boolean): Promise<boolean> {
    this.#compressionPreference = enabled;
    this.#sendCompressionEnabled = enabled && this.#compressionNegotiated;
    if (!this.#compressionNegotiated) return false;
    return await this.#sendCompressionControl(enabled);
  }

  /**
   * Sends in submission order using the compression mode active at submission.
   * Every payload stays on the queue because a later text frame must not
   * overtake earlier asynchronous compression. A payload lost with its
   * connection — one queued when the socket closes, one whose write fails, or
   * one sent on a socket that fails to open — rejects with a `ConnectionError`.
   */
  async send(payload: string): Promise<void> {
    const opening = this.#open();
    const compressionEnabled = this.#sendCompressionEnabled;
    const routed = this.#routedMessages;
    const frameSlots = this.#routedFrameSlots;
    const streaming = this.#routerStreaming;
    const routedCompression = this.#routedCompression;
    const credits = this.#uploadCredits;
    const send = this.#sending.then(async () => {
      const connection = await opening;
      const decoded = streaming
        ? decodeRoutedFrame(payload, false, frameSlots)
        : undefined;
      const control = decoded !== undefined &&
        isRouterControl(decoded.body.type);
      // A streamed message travels as the routed compression envelope when
      // compression is on and `routedCompressionV1` was negotiated: the router
      // reads only the controls it answers or counts, and the toolshed expands
      // the rest.
      const frame = decoded !== undefined
        ? compressionEnabled && routedCompression
          ? compressRoutedPayload(
            payload,
            new TextEncoder().encode(payload),
            decoded.space,
          )
          : payload
        : compressionEnabled
        ? routed
          ? encodeRoutedFrame(payload, frameSlots)
          : await encodeCompressedMemoryMessage(payload)
        : routed
        ? checkedRoutedText(payload, frameSlots)
        : payload;
      if (this.#socket !== connection.socket) {
        throw MemoryClient.connectionError(
          "Memory websocket changed before send",
        );
      }
      // Counted as its first frame is handed to `#write`, which counts that
      // frame's bytes.
      this.#messagesSent++;
      if (decoded !== undefined && (!control || credits !== undefined)) {
        for (const record of routerRecords(routerRoute(decoded.body), frame)) {
          if (this.#socket !== connection.socket) {
            throw MemoryClient.connectionError(
              "Memory websocket changed during send",
            );
          }
          await this.#write(connection, record, credits);
        }
      } else {
        await this.#write(connection, frame);
      }
    });
    this.#sending = send.catch(() => {});
    await send;
  }

  async close(): Promise<void> {
    const socket = this.#detachSocket(new Error("Memory transport closed"));
    if (!this.#disposed) {
      this.#disposed = true;
      this.#onDispose();
    }
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
    });
    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close();
    }
    await closed;
  }

  /** @inheritDoc */
  reset(): void {
    const socket = this.#detachSocket(new Error("Memory connection reset"));
    if (
      socket?.readyState === WebSocket.CONNECTING ||
      socket?.readyState === WebSocket.OPEN
    ) {
      socket.close();
    }
  }

  /** Invalidates this connection before its close event or queued frames run. */
  #detachSocket(error: Error): MemorySocket | null {
    const socket = this.#socket;
    this.#socket = null;
    this.#connection = null;
    this.#opening = null;
    this.#compressionNegotiated = false;
    this.#receiveCompressionEnabled = false;
    this.#sendCompressionEnabled = false;
    this.#routedMessages = false;
    this.#routedFrameSlots = ROUTED_FRAME_SLOTS;
    this.#routerStreaming = false;
    this.#routedCompression = false;
    this.#clearUploadCredits(error);
    this.#rejectCompressionRequests(error);
    return socket;
  }

  async #open(): Promise<MemorySocketConnection> {
    if (this.#disposed) throw new Error("Memory transport closed");
    if (this.#connection?.socket.readyState === WebSocket.OPEN) {
      return this.#connection;
    }
    if (this.#opening) {
      return await this.#opening;
    }
    const address = toWebSocketAddress(this.#address);
    const opening = new Promise<MemorySocketConnection>((resolve, reject) => {
      const connection = this.#createSocket(address);
      const { socket } = connection;
      this.#socket = socket;
      this.#connection = connection;
      this.#compressionNegotiated = false;
      this.#receiveCompressionEnabled = false;
      this.#sendCompressionEnabled = false;
      this.#routedMessages = false;
      this.#routedFrameSlots = ROUTED_FRAME_SLOTS;
      this.#routerStreaming = false;
      this.#routedCompression = false;
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        resolve(connection);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        const frame = event.data;
        this.#messagesReceived++;
        this.#bytesReceived += frameSize(frame);
        const receive = this.#receiving.then(async () => {
          if (this.#socket !== socket) return;
          try {
            if (!isMemoryMessageFrame(frame)) {
              throw new Error("Unsupported memory websocket frame type");
            }
            let payload: string;
            // A routed body's type, which its decode has already parsed.
            let routedType: unknown;
            const decodeStart = performance.now();
            if (this.#routedMessages) {
              const routedFrame = typeof frame === "string"
                ? frame
                : frame instanceof Blob
                ? new Uint8Array(await frame.arrayBuffer())
                : frame instanceof ArrayBuffer
                ? new Uint8Array(frame)
                : frame;
              if (this.#socket !== socket) return;
              if (
                this.#uploadCredits !== undefined &&
                typeof routedFrame !== "string" &&
                !(routedFrame.length >= 4 && routedFrame[0] === 0x6d &&
                  routedFrame[1] === 0x63 && routedFrame[2] === 0x6d &&
                  routedFrame[3] === 0x70)
              ) {
                // On a credited connection a binary frame is a compressed body
                // only if it opens with the envelope's `mcmp`, which the router
                // checks before forwarding one; any other is a router credit.
                this.#acceptUploadCredit(routedFrame);
                return;
              }
              // A streamed connection takes compressed bodies only once
              // `routedCompressionV1` was negotiated; a legacy one, from its
              // own negotiated compression.
              const decoded = await decodeRoutedFrameAsync(
                routedFrame,
                this.#routerStreaming
                  ? this.#routedCompression
                  : this.#receiveCompressionEnabled,
                this.#routedFrameSlots,
              );
              if (this.#socket !== socket) return;
              if (decoded.body.type === "router.credit") {
                throw new Error("Unexpected text router credit");
              }
              payload = decoded.payload;
              routedType = decoded.body.type;
            } else if (this.#receiveCompressionEnabled) {
              payload = await decodeCompressedMemoryMessage(frame);
            } else {
              if (typeof frame !== "string") {
                throw new Error(
                  "Memory websocket expects text before compression negotiation",
                );
              }
              payload = frame;
            }
            logger.time(decodeStart, "receive", "decodeFrame");
            if (this.#socket !== socket) return;
            // Only a routed control is parsed again; a legacy frame is parsed
            // to find out whether it is one.
            const control = routedType === undefined
              ? parseMemoryCompressionControlMessage(payload)
              : routedType === "memory.compression"
              ? parseMemoryCompressionControlMessage(payload.slice(5))
              : null;
            if (control) {
              const pending = this.#compressionRequests.get(control.requestId);
              if (pending) {
                this.#compressionRequests.delete(control.requestId);
                const enabled = control.enabled && this.#compressionNegotiated;
                this.#sendCompressionEnabled = enabled;
                pending.resolve(enabled);
              }
              return;
            }
            const receiverStart = performance.now();
            try {
              this.#receiver(payload);
            } catch (cause) {
              reportError(cause);
            }
            logger.time(receiverStart, "receive", "dispatchPayload");
          } catch (cause) {
            if (this.#socket !== socket) return;
            // Error-level records expose decode failures to console capture.
            // Text lengths count UTF-16 code units; binary lengths count bytes.
            // Error names/messages are capped at 50/500 characters, and only
            // the immediate error cause is included.
            try {
              logger.error("receive-decode-failure", () => [
                JSON.stringify({
                  errorName: cause instanceof Error
                    ? debugStr`$short${cause.name}`
                    : typeof cause,
                  errorMessage: cause instanceof Error
                    ? debugStr`$long${cause.message}`
                    : debugStr`$long${cause}`,
                  causeName:
                    cause instanceof Error && cause.cause instanceof Error
                      ? debugStr`$short${cause.cause.name}`
                      : undefined,
                  causeMessage:
                    cause instanceof Error && cause.cause instanceof Error
                      ? debugStr`$long${cause.cause.message}`
                      : undefined,
                  frameType: typeof frame === "string"
                    ? "string"
                    : frame instanceof Blob
                    ? "Blob"
                    : frame instanceof ArrayBuffer
                    ? "ArrayBuffer"
                    : ArrayBuffer.isView(frame)
                    ? "ArrayBufferView"
                    : typeof frame,
                  frameCodeUnits: typeof frame === "string"
                    ? frame.length
                    : undefined,
                  frameBytes: frame instanceof Blob
                    ? frame.size
                    : frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)
                    ? frame.byteLength
                    : undefined,
                  routed: this.#routedMessages,
                  compressionEnabled: this.#receiveCompressionEnabled,
                }),
              ]);
            } catch {
              // Diagnostics cannot prevent detaching and closing this socket.
            }
            // Tagged so the client invalidates every session's delivery: the
            // server may count the frame this transport could not decode as
            // delivered.
            const error = MemoryClient.receiveFailedError(
              "Unable to decode compressed memory websocket message",
              cause,
            );
            this.#detachSocket(error);
            this.#closeReceiver(error);
            if (socket.readyState === WebSocket.OPEN) {
              // Native clients permit only `1000` or application close codes
              // (`3000`–`4999`), so decode failures use application code `4007`.
              socket.close(4007, error.message);
            }
          }
        });
        this.#receiving = receive.catch(reportError);
      });
      socket.addEventListener("close", () => {
        const isCurrentSocket = this.#socket === socket;
        if (isCurrentSocket) {
          this.#detachSocket(
            new Error("Memory websocket transport closed"),
          );
        }
        if (this.#opening === opening) {
          this.#opening = null;
        }
        if (isCurrentSocket) {
          this.#closeReceiver();
        }
        if (!opened) {
          reject(
            MemoryClient.connectionError(
              "memory websocket transport closed before opening",
            ),
          );
        }
      });
      socket.addEventListener("error", (event) => {
        const isCurrentSocket = this.#socket === socket;
        const error = event.error instanceof Error
          ? event.error
          : new Error("memory websocket transport error");
        if (isCurrentSocket) {
          this.#detachSocket(
            new Error("Memory websocket transport failed"),
          );
        }
        if (this.#opening === opening) {
          this.#opening = null;
        }
        if (isCurrentSocket) {
          this.#closeReceiver(error);
        }
        reject(MemoryClient.connectionError(error.message, error));
      }, { once: true });
    });
    this.#opening = opening;
    void opening.catch(() => {
      if (this.#opening === opening) this.#opening = null;
    });
    return await this.#opening;
  }

  /** Sends a compression control after every earlier application send. */
  async #sendCompressionControl(enabled: boolean): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<boolean>();
    void response.promise.catch(() => {});
    this.#compressionRequests.set(requestId, response);
    if (this.#uploadCredits !== undefined) {
      try {
        await this.send(encodeMemoryBoundary({
          type: "memory.compression",
          requestId,
          enabled,
        }));
        return await response.promise;
      } catch (cause) {
        this.#compressionRequests.delete(requestId);
        throw cause;
      }
    }
    const opening = this.#open();
    const send = this.#sending.then(async () => {
      const connection = await opening;
      if (this.#socket !== connection.socket) {
        throw MemoryClient.connectionError(
          "Memory websocket changed before compression control",
        );
      }
      this.#messagesSent++;
      await this.#write(
        connection,
        this.#routedMessages
          ? encodeMemoryBoundary({
            type: "memory.compression",
            requestId,
            enabled,
          })
          : encodeMemoryCompressionControlMessage({ requestId, enabled }),
      );
    });
    this.#sending = send.catch(() => {});
    try {
      await send;
      return await response.promise;
    } catch (cause) {
      this.#compressionRequests.delete(requestId);
      throw cause;
    }
  }

  /**
   * Helper for `send()` and `#sendCompressionControl()`, which writes `frame`
   * to `connection`. A failed write rejects with a `ConnectionError` carrying
   * the socket's error as its cause. The transport then abandons the socket and
   * reports the loss to the close receiver itself, without waiting for the
   * socket's own close or error event, so the reconnect that replays the
   * payload always starts.
   *
   * The failure is the payload's own, made with `writeFailedError()`, only
   * when the socket was current and open: a write refused because the socket
   * is closing, or because it was already replaced, says nothing about the
   * payload.
   */
  async #write(
    connection: MemorySocketConnection,
    frame: EncodedMemoryMessage,
    credits?: RouterUploadCredits,
  ): Promise<void> {
    this.#bytesSent += frameSize(frame);
    try {
      if (credits !== undefined) {
        if (typeof frame === "string" || frame.length > credits.window) {
          throw new Error("Router upload record exceeds credit window");
        }
        for (;;) {
          if (
            this.#socket !== connection.socket ||
            this.#uploadCredits !== credits
          ) {
            throw MemoryClient.connectionError(
              "Memory websocket changed while waiting for router credit",
            );
          }
          if (credits.outstanding + frame.length <= credits.window) break;
          // The wait ends when credit arrives or when none has for
          // `ROUTER_CREDIT_WAIT_MS`; the latter fails this write on an open
          // socket, so the catch below tags it as the payload's own failure.
          const waiter = credits.waiter ??= Promise.withResolvers<void>();
          const deadline = setTimeout(
            () =>
              waiter.reject(
                new Error(
                  "Router upload credit did not arrive within " +
                    `${ROUTER_CREDIT_WAIT_MS} ms`,
                ),
              ),
            ROUTER_CREDIT_WAIT_MS,
          );
          try {
            await waiter.promise;
          } finally {
            clearTimeout(deadline);
          }
        }
        // Charge before sending: even a synchronous peer reply must be bounded
        // by bytes already submitted on this connection.
        credits.outstanding += frame.length;
      }
      if (this.#routerStreaming) {
        const bytes = typeof frame === "string"
          ? new TextEncoder().encode(frame).length
          : frame.length;
        if (
          (connection.socket.bufferedAmount ?? 0) + bytes >
            ROUTER_NATIVE_QUEUE_BYTES
        ) {
          throw new Error("Router socket output limit");
        }
      }
      await connection.send(frame);
    } catch (cause) {
      const { socket } = connection;
      const ownFailure = this.#socket === socket &&
        socket.readyState === WebSocket.OPEN;
      const error = (ownFailure
        ? MemoryClient.writeFailedError
        : MemoryClient.connectionError)(
          cause instanceof Error
            ? cause.message
            : "Memory websocket write failed",
          cause,
        );
      if (this.#socket === socket) {
        this.#detachSocket(error);
        this.#closeReceiver(error);
        if (
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close();
        }
      }
      throw error;
    }
  }

  /** Accepts additive credit only for outstanding bytes on this selection. */
  #acceptUploadCredit(frame: Uint8Array): void {
    if (
      frame.length !== 8 || frame[0] !== 0x6d || frame[1] !== 0x72 ||
      frame[2] !== 0x63 || frame[3] !== 0x01
    ) {
      throw new Error("Invalid router upload credit");
    }
    const credits = this.#uploadCredits;
    const bytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
      .getUint32(4, false);
    if (
      credits === undefined || bytes === 0 || bytes > credits.outstanding
    ) {
      throw new Error("Invalid router upload credit");
    }
    credits.outstanding -= bytes;
    const waiter = credits.waiter;
    credits.waiter = undefined;
    waiter?.resolve();
  }

  /** Rejects the blocked upload and discards this connection's credit. */
  #clearUploadCredits(error: Error): void {
    const credits = this.#uploadCredits;
    this.#uploadCredits = undefined;
    credits?.waiter?.reject(MemoryClient.connectionError(error.message, error));
  }

  /** Rejects control requests which cannot receive an acknowledgement. */
  #rejectCompressionRequests(error: Error): void {
    for (const pending of this.#compressionRequests.values()) {
      pending.reject(error);
    }
    this.#compressionRequests.clear();
  }
}

/**
 * Build the signed `session.open` auth for a space session — the ONE
 * signing shape every session-open path shares. Extracted from
 * {@link RemoteSessionFactory} so the server-execution loopback plane
 * (serving-loop.md §1 plane (a)) opens its sessions under the SAME
 * production verification as remote clients, rather than a parallel
 * auth scheme.
 */
export async function createSignedSessionOpenAuth(
  signer: Signer,
  space: MemorySpace,
  session: MemoryClient.MountOptions,
  context: MemoryClient.SessionOpenAuthContext,
): Promise<MemoryClient.SessionOpenAuth> {
  const iat = Math.floor(Date.now() / 1000);
  const invocation = {
    iss: signer.did(),
    cmd: "session.open",
    sub: space,
    aud: context.audience,
    args: {
      protocol: MEMORY_PROTOCOL,
      session,
    },
    challenge: context.challenge.value,
    iat,
    exp: iat + SESSION_OPEN_TTL_SECONDS,
  };
  const signature = await signer.sign(hashOf(invocation).bytes);
  if (signature.error) {
    throw signature.error;
  }
  return {
    invocation,
    authorization: {
      // The signature travels as a `FabricBytes` -- the proper fabric form
      // for a byte sequence, which serializes to a compact `/Bytes@1` wire
      // form and round-trips faithfully. The server's `toByteArray` accepts
      // it.
      signature: new FabricBytes(signature.ok),
    },
  };
}

/** Builds the signed `connection.auth` for `signer`, as a client sends it. */
export async function createSignedConnectionAuth(
  signer: Signer,
  context: MemoryClient.SessionOpenAuthContext,
): Promise<MemoryClient.ConnectionAuth> {
  const iat = Math.floor(Date.now() / 1000);
  if (context.deployment !== undefined) {
    return {
      statement: routedBase64(
        await routedStatementPayload({
          principal: signer.did(),
          router: context.audience,
          deployment: context.deployment,
          challenge: readRoutedHex(context.challenge.value, 32),
          iat,
          exp: Math.min(
            iat + MAX_ROUTED_LEASE_SECONDS,
            context.challenge.expiresAt - ROUTED_CHALLENGE_SECONDS +
              MAX_ROUTED_LEASE_SECONDS,
          ),
        }).sign(signer),
      ),
    };
  }
  const invocation = {
    iss: signer.did(),
    cmd: "connection.auth",
    aud: context.audience,
    args: { protocol: MEMORY_PROTOCOL },
    challenge: context.challenge.value,
    iat,
    exp: iat + CONNECTION_AUTH_LEASE_SECONDS,
  };
  const signature = await signer.sign(hashOf(invocation).bytes);
  if (signature.error) {
    throw signature.error;
  }
  return {
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
}

/** The error an aborted `signal` stands for. */
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("memory replica route replaced");

/**
 * Settles as `work` settles, or rejects with the abort reason as soon as
 * `signal` aborts, whichever comes first. `work` itself is not cancelled.
 */
const abortable = <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(abortReason(signal));
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() =>
    signal.removeEventListener("abort", abort)
  );
};

/** One session's share of a connection that holds several. */
class SharedSessionConnection implements SessionConnection {
  #closed = false;

  readonly #client: MemoryClient.Client;
  readonly #session: MemoryClient.SpaceSession;

  /** Constructs the share `session` has of `client`. */
  constructor(client: MemoryClient.Client, session: MemoryClient.SpaceSession) {
    this.#client = client;
    this.#session = session;
  }

  /** @inheritDoc */
  get serverFlags(): MemoryProtocolFlags | null {
    return this.#client.serverFlags;
  }

  /** @inheritDoc */
  delivered(): Promise<void> {
    return this.#client.delivered();
  }

  /** Ends the session and leaves the connection to its other sessions. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.close();
  }

  /**
   * Ends the shared connection's authentication of `principal`, which a
   * router counts against the connection until it is released.
   */
  async releasePrincipal(principal: string): Promise<void> {
    await this.#client.release(principal);
  }
}

/** A connection that the sessions of one host share. */
type SharedConnection = {
  transport: WebSocketTransport;

  /** Settles once the connection's handshake has completed. */
  client: Promise<MemoryClient.Client>;
};

/**
 * Opens memory sessions over WebSockets: one connection per space, or, with
 * shared connections on, one per host that every session on that host is
 * mounted on.
 */
export class RemoteSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  #compressionEnabled = true;
  #transports = new Set<WebSocketTransport>();
  #sharedConnections = false;

  /** Transports closed so far. */
  #closedTransports = 0;

  /** What the closed transports carried, so the totals stay cumulative. */
  #closedTransportSizes: TransportSizes = {
    messagesSent: 0,
    bytesSent: 0,
    messagesReceived: 0,
    bytesReceived: 0,
  };

  /** The shared connection per storage address, while sharing is on. */
  #shared = new Map<string, SharedConnection>();

  /** Observers of `session/admissible`, as `subscribeAdmissible()` added. */
  #admissibleObservers = new Set<
    (space: MemorySpace, principal: string) => void
  >();

  readonly #resolveAddress: (space: MemorySpace) => URL;
  readonly #defaultSigner: Signer;
  readonly #createSocket: MemorySocketFactory;

  constructor(
    resolveAddress: (space: MemorySpace) => URL,
    defaultSigner: Signer,
    createSocket: MemorySocketFactory = createMemorySocket,
  ) {
    this.#resolveAddress = resolveAddress;
    this.#defaultSigner = defaultSigner;
    this.#createSocket = createSocket;
  }

  /** Changes compression on live sessions and the default for later ones. */
  async setMessageCompressionEnabled(enabled: boolean): Promise<void> {
    this.#compressionEnabled = enabled;
    await Promise.all(
      [...this.#transports].map((transport) =>
        transport.requestMessageCompression(enabled)
      ),
    );
  }

  /** @inheritDoc */
  subscribeAdmissible(
    observer: (space: MemorySpace, principal: string) => void,
  ): () => void {
    this.#admissibleObservers.add(observer);
    return () => {
      this.#admissibleObservers.delete(observer);
    };
  }

  /** @inheritDoc */
  setSharedConnections(enabled: boolean): void {
    this.#sharedConnections = enabled;
  }

  /** @inheritDoc */
  getSizes(): MemoryConnectionSizes {
    const sizes = {
      ...this.#closedTransportSizes,
      socketsOpen: 0,
      bufferedAmount: 0,
    };
    for (const transport of this.#transports) {
      const carried = transport.getSizes();
      sizes.messagesSent += carried.messagesSent;
      sizes.bytesSent += carried.bytesSent;
      sizes.messagesReceived += carried.messagesReceived;
      sizes.bytesReceived += carried.bytesReceived;
      if (transport.socketOpen) sizes.socketsOpen++;
      sizes.bufferedAmount += transport.bufferedAmount;
    }
    return {
      transports: this.#transports.size,
      transportsClosed: this.#closedTransports,
      ...sizes,
    };
  }

  /** Closes the shared connections, and with them the sessions on them. */
  async close(): Promise<void> {
    const shared = [...this.#shared.values()];
    this.#shared.clear();
    await Promise.all(shared.map(async ({ transport, client }) => {
      // The transport closes first: a dial still in progress ends with it,
      // where waiting for the dial would wait for a peer that may never
      // answer.
      await transport.close().catch(() => {});
      const connected = await client.catch(() => undefined);
      await connected?.close().catch(() => {});
    }));
  }

  /**
   * Helper for the connection paths, which relays the `session/admissible`
   * notices `client` is sent to this factory's observers.
   */
  #relayAdmissible(client: MemoryClient.Client): void {
    client.subscribeAdmissible((space, principal) => {
      for (const observer of [...this.#admissibleObservers]) {
        try {
          observer(space as MemorySpace, principal);
        } catch (cause) {
          console.error("session-admissible subscriber threw:", cause);
        }
      }
    });
  }

  create(
    space: MemorySpace,
    signer = this.#defaultSigner,
    mountOptions: MemoryClient.MountOptions = {},
    signal?: AbortSignal,
  ): Promise<{
    client: SessionConnection;
    session: MemoryClient.SpaceSession;
  }> {
    return this.#sharedConnections
      ? this.#createShared(space, signer, mountOptions, signal)
      : this.#createDedicated(space, signer, mountOptions, signal);
  }

  /**
   * Helper for `create()`, which returns both authentication signers for the
   * key. The server's capabilities select authentication independently of
   * whether the factory shares connections.
   */
  #sessionPrincipal(signer: Signer): MemoryClient.SessionPrincipal {
    return {
      did: signer.did(),
      authorizeConnection: (context) =>
        createSignedConnectionAuth(signer, context),
      authorizeSessionOpen: (space, descriptor, context) =>
        createSignedSessionOpenAuth(
          signer,
          space as MemorySpace,
          descriptor,
          context,
        ),
    };
  }

  /**
   * Helper for `create()`, which mounts the session on the connection its
   * host's sessions share, dialing that connection if there is none or the
   * one there can no longer be used.
   */
  async #createShared(
    space: MemorySpace,
    signer: Signer,
    mountOptions: MemoryClient.MountOptions,
    signal?: AbortSignal,
  ): Promise<{
    client: SessionConnection;
    session: MemoryClient.SpaceSession;
  }> {
    if (signal?.aborted) throw abortReason(signal);
    const client = await this.#sharedClient(
      this.#resolveAddress(space),
      signal,
    );
    try {
      const session = await client.mount(
        space,
        mountOptions,
        this.#sessionPrincipal(signer),
        signal,
      );
      return {
        client: new SharedSessionConnection(client, session),
        session,
      };
    } catch (error) {
      throw signal?.aborted ? abortReason(signal) : error;
    }
  }

  /**
   * Helper for `#createShared()`, which returns the connected client the
   * sessions at `address` share. An abort of `signal` while the dial is in
   * progress stops this caller waiting for it; the dial itself goes on for
   * the sessions that follow, and is closed only if it fails.
   */
  async #sharedClient(
    address: URL,
    signal?: AbortSignal,
  ): Promise<MemoryClient.Client> {
    const key = address.href;
    const existing = this.#shared.get(key);
    if (existing !== undefined) {
      // A dial that fails fails every session waiting on it; a client that
      // connected and has since failed or closed is replaced.
      const client = await abortable(existing.client, signal);
      const state = client.connectionState;
      if (state === "connected" || state === "reconnecting") {
        return client;
      }
      if (this.#shared.get(key) === existing) {
        this.#shared.delete(key);
        await client.close().catch(() => {});
      }
      return await this.#sharedClient(address, signal);
    }
    const transport = new WebSocketTransport(
      toWebSocketAddress(address),
      this.#compressionEnabled,
      () => this.#retire(transport),
      this.#createSocket,
    );
    this.#transports.add(transport);
    const dialed: SharedConnection = {
      transport,
      client: MemoryClient.connect({ transport }).then((client) => {
        this.#relayAdmissible(client);
        return client;
      }),
    };
    this.#shared.set(key, dialed);
    // A failed dial takes its entry with it, whoever is waiting on it.
    dialed.client.catch(async () => {
      if (this.#shared.get(key) === dialed) {
        this.#shared.delete(key);
      }
      await transport.close().catch(() => {});
    });
    return await abortable(dialed.client, signal);
  }

  /** @inheritDoc */
  async serverFlags(
    space: MemorySpace,
    signal?: AbortSignal,
  ): Promise<MemoryProtocolFlags | null> {
    if (this.#sharedConnections) {
      const client = await this.#sharedClient(
        this.#resolveAddress(space),
        signal,
      );
      // A shared connection may be reconnecting, and the flags it holds are
      // then the previous server's until the new handshake is done.
      await client.restoreConnection();
      return client.serverFlags;
    }
    const transport = this.#dedicatedTransport(space);
    let client: MemoryClient.Client | undefined;
    try {
      client = await MemoryClient.connect({ transport, signal });
      return client.serverFlags;
    } finally {
      await (client?.close() ?? transport.close()).catch(() => {});
    }
  }

  /**
   * Forgets a transport that has closed, folding what it carried into the
   * factory's totals so a closed connection's traffic stays counted.
   */
  #retire(transport: WebSocketTransport): void {
    if (!this.#transports.delete(transport)) return;
    this.#closedTransports++;
    const carried = transport.getSizes();
    const totals = this.#closedTransportSizes;
    totals.messagesSent += carried.messagesSent;
    totals.bytesSent += carried.bytesSent;
    totals.messagesReceived += carried.messagesReceived;
    totals.bytesReceived += carried.bytesReceived;
  }

  /**
   * Helper for `#createDedicated()` and `serverFlags()`, which makes the
   * transport of a connection for one space alone, naming the space in its
   * address.
   */
  #dedicatedTransport(space: MemorySpace): WebSocketTransport {
    const transport = new WebSocketTransport(
      toSpaceWebSocketAddress(this.#resolveAddress(space), space),
      this.#compressionEnabled,
      () => this.#retire(transport),
      this.#createSocket,
    );
    this.#transports.add(transport);
    return transport;
  }

  /**
   * Helper for `create()`, which dials a connection for this session alone,
   * naming the space in its address.
   */
  async #createDedicated(
    space: MemorySpace,
    signer: Signer,
    mountOptions: MemoryClient.MountOptions,
    signal?: AbortSignal,
  ) {
    const transport = this.#dedicatedTransport(space);
    let client: MemoryClient.Client | undefined;
    const abortError = (): Error =>
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("memory replica route replaced");

    try {
      // `connect` and `mount` each refuse an aborted signal on entry, so the
      // only window this method has to check for itself is the one after the
      // mount resolves, below.
      client = await MemoryClient.connect({ transport, signal });
      this.#relayAdmissible(client);
      const closeForAbort = (): void => {
        void client?.close().catch(() => {});
      };
      signal?.addEventListener("abort", closeForAbort, { once: true });
      try {
        const session = await client.mount(
          space,
          mountOptions,
          this.#sessionPrincipal(signer),
          signal,
        );
        if (signal?.aborted) throw abortError();
        return { client, session };
      } finally {
        signal?.removeEventListener("abort", closeForAbort);
      }
    } catch (error) {
      await (client?.close() ?? transport.close()).catch(() => {});
      throw signal?.aborted ? abortError() : error;
    }
  }
}
