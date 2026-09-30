import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type MemorySpace, type Signer } from "@commonfabric/memory/interface";
import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  isMemoryMessageFrame,
  parseMemoryCompressionControlMessage,
} from "@commonfabric/memory/v2/message-compression";
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
    client: MemoryClient.Client;
    session: MemoryClient.SpaceSession;
  }>;

  /** Changes compression on live sessions and the default for later ones. */
  setMessageCompressionEnabled?(enabled: boolean): Promise<void>;
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
   * overtake earlier asynchronous compression.
   */
  async send(payload: string): Promise<void> {
    const opening = this.#open();
    const compressionEnabled = this.#sendCompressionEnabled;
    const send = this.#sending.then(async () => {
      const connection = await opening;
      const frame = compressionEnabled
        ? await encodeCompressedMemoryMessage(payload)
        : payload;
      if (this.#socket !== connection.socket) {
        throw new Error("Memory websocket changed before send");
      }
      await connection.send(frame);
    });
    this.#sending = send.catch(() => {});
    await send;
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#connection = null;
    this.#opening = null;
    this.#compressionNegotiated = false;
    this.#receiveCompressionEnabled = false;
    this.#sendCompressionEnabled = false;
    this.#rejectCompressionRequests(new Error("Memory transport closed"));
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
            if (this.#receiveCompressionEnabled) {
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
            const control = parseMemoryCompressionControlMessage(payload);
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
          reject(new Error("memory websocket transport closed before opening"));
        }
      });
      socket.addEventListener("error", (event) => {
        const isCurrentSocket = this.#socket === socket;
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
          this.#closeReceiver(
            event.error instanceof Error
              ? event.error
              : new Error("memory websocket transport error"),
          );
        }
        reject(event);
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
        throw new Error("Memory websocket changed before compression control");
      }
      await connection.send(encodeMemoryCompressionControlMessage({
        requestId,
        enabled,
      }));
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

export class RemoteSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  #compressionEnabled = true;
  #transports = new Set<WebSocketTransport>();

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

  #createSessionOpenAuth(
    signer: Signer,
    space: MemorySpace,
    session: MemoryClient.MountOptions,
    context: MemoryClient.SessionOpenAuthContext,
  ): Promise<MemoryClient.SessionOpenAuth> {
    return createSignedSessionOpenAuth(signer, space, session, context);
  }

  async create(
    space: MemorySpace,
    signer = this.#defaultSigner,
    mountOptions: MemoryClient.MountOptions = {},
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
