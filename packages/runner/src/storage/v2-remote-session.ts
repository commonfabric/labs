import { hashOf } from "@commonfabric/data-model";
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
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
} from "@commonfabric/memory/v2/routed-wire";
import {
  decodeRoutedFrame,
  encodeRoutedFrame,
} from "@commonfabric/memory/v2/routed-parser";
import { getLogger } from "@commonfabric/utils/logger";
import { normalizeSpaceHost, SpaceHostValidationError } from "../space-host.ts";
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
   * Chooses, for the sessions created from here on, between one connection
   * per host and one per space.
   */
  setSharedConnections?(enabled: boolean): void;

  /** Closes every connection the factory keeps open between sessions. */
  close?(): Promise<void>;
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
 * Lease a signed `connection.auth` asks for, in seconds: the server caps it
 * at its own limit, and the client renews ahead of whatever it granted.
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
  #sending: Promise<void> = Promise.resolve();
  #receiving: Promise<void> = Promise.resolve();

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

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  /** Selects the router frame codec after a pinned routed hello. */
  setRoutedMessagesEnabled(enabled: boolean): void {
    this.#routedMessages = enabled;
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
    const send = this.#sending.then(async () => {
      const connection = await opening;
      const frame = compressionEnabled
        ? routed
          ? encodeRoutedFrame(payload)
          : await encodeCompressedMemoryMessage(payload)
        : payload;
      if (this.#socket !== connection.socket) {
        throw MemoryClient.connectionError(
          "Memory websocket changed before send",
        );
      }
      await this.#write(connection, frame);
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
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        resolve(connection);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        const frame = event.data;
        const receive = this.#receiving.then(async () => {
          if (this.#socket !== socket) return;
          try {
            if (!isMemoryMessageFrame(frame)) {
              throw new Error("Unsupported memory websocket frame type");
            }
            let payload: string;
            const decodeStart = performance.now();
            if (this.#routedMessages) {
              const routedFrame = typeof frame === "string"
                ? frame
                : frame instanceof Blob
                ? new Uint8Array(await frame.arrayBuffer())
                : frame instanceof ArrayBuffer
                ? new Uint8Array(frame)
                : frame;
              payload =
                decodeRoutedFrame(routedFrame, this.#receiveCompressionEnabled)
                  .payload;
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
            const control = parseMemoryCompressionControlMessage(
              this.#routedMessages ? payload.slice(5) : payload,
            );
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
            const error = new Error(
              "Unable to decode compressed memory websocket message",
              { cause },
            );
            this.#socket = null;
            this.#connection = null;
            this.#compressionNegotiated = false;
            this.#receiveCompressionEnabled = false;
            this.#sendCompressionEnabled = false;
            this.#rejectCompressionRequests(error);
            this.#closeReceiver(error);
            if (socket.readyState === WebSocket.OPEN) {
              socket.close(1007, error.message);
            }
          }
        });
        this.#receiving = receive.catch(reportError);
      });
      socket.addEventListener("close", () => {
        const isCurrentSocket = this.#socket === socket;
        if (isCurrentSocket) {
          this.#socket = null;
          this.#connection = null;
          this.#compressionNegotiated = false;
          this.#receiveCompressionEnabled = false;
          this.#sendCompressionEnabled = false;
          this.#rejectCompressionRequests(
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
          this.#socket = null;
          this.#connection = null;
          this.#compressionNegotiated = false;
          this.#receiveCompressionEnabled = false;
          this.#sendCompressionEnabled = false;
          this.#rejectCompressionRequests(
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

  /** Sends one inspectable control frame after every earlier application send. */
  async #sendCompressionControl(enabled: boolean): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<boolean>();
    void response.promise.catch(() => {});
    this.#compressionRequests.set(requestId, response);
    const opening = this.#open();
    const send = this.#sending.then(async () => {
      const connection = await opening;
      if (this.#socket !== connection.socket) {
        throw MemoryClient.connectionError(
          "Memory websocket changed before compression control",
        );
      }
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
   */
  async #write(
    connection: MemorySocketConnection,
    frame: EncodedMemoryMessage,
  ): Promise<void> {
    try {
      await connection.send(frame);
    } catch (cause) {
      const error = MemoryClient.connectionError(
        cause instanceof Error
          ? cause.message
          : "Memory websocket write failed",
        cause,
      );
      const { socket } = connection;
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
            iat + CONNECTION_AUTH_LEASE_SECONDS,
            context.challenge.expiresAt - 60 + CONNECTION_AUTH_LEASE_SECONDS,
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

  /** The shared connection per storage address, while sharing is on. */
  #shared = new Map<string, SharedConnection>();

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
  setSharedConnections(enabled: boolean): void {
    this.#sharedConnections = enabled;
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

  #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryClient.MountOptions,
    context: MemoryClient.SessionOpenAuthContext,
  ): Promise<MemoryClient.SessionOpenAuth> {
    return createSignedSessionOpenAuth(signer, space, session, context);
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
      const session = await client.mount(space, mountOptions, {
        did: signer.did(),
        authorizeConnection: (context) =>
          createSignedConnectionAuth(signer, context),
        authorizeSessionOpen: (targetSpace, descriptor, context) =>
          this.#createSessionOpenAuth(
            signer,
            targetSpace as MemorySpace,
            descriptor,
            context,
          ),
      }, signal);
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
      () => this.#transports.delete(transport),
      this.#createSocket,
    );
    this.#transports.add(transport);
    const dialed: SharedConnection = {
      transport,
      client: MemoryClient.connect({ transport }),
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
    const transport = new WebSocketTransport(
      toSpaceWebSocketAddress(this.#resolveAddress(space), space),
      this.#compressionEnabled,
      () => this.#transports.delete(transport),
      this.#createSocket,
    );
    this.#transports.add(transport);
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
      const closeForAbort = (): void => {
        void client?.close().catch(() => {});
      };
      signal?.addEventListener("abort", closeForAbort, { once: true });
      try {
        const session = await client.mount(
          space,
          mountOptions,
          (
            targetSpace: string,
            descriptor: MemoryClient.MountOptions,
            context: MemoryClient.SessionOpenAuthContext,
          ) =>
            this.#createSessionOpenAuth(
              signer,
              targetSpace as MemorySpace,
              descriptor,
              context,
            ),
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
