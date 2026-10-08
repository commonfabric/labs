import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { DEFAULT_ROUTED_HOST_LIMITS } from "@commonfabric/memory/v2/routed-host";
import { decodeRoutedFrame } from "@commonfabric/memory/v2/routed-parser";
import { routedFrameOf } from "../../memory/test/support/routed-slots.ts";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import {
  decodeCompressedMemoryMessage,
  encodeCompressedMemoryMessage,
  type EncodedMemoryMessage,
  encodeMemoryCompressionControlMessage,
  type MemoryMessageFrame,
  parseMemoryCompressionControlMessage,
} from "@commonfabric/memory/v2/message-compression";
import {
  createStorageAddressResolver,
  MEMORY_STORAGE_PATH,
  RemoteSessionFactory,
  ROUTED_FRAME_SLOTS,
  storageAddressForHost,
  toSpaceWebSocketAddress,
  toWebSocketAddress,
  WebSocketTransport,
} from "../src/storage/v2-remote-session.ts";
import {
  createNativeMemorySocket,
  type MemorySocket,
  type MemorySocketFactory,
} from "../src/storage/memory-socket.ts";
import { SpaceHostValidationError } from "../src/space-host.ts";
import { StorageManager } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  TEST_HELLO_SESSION_OPEN,
  testSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

function expectSafeValidationCause(
  error: Error,
  secret: string,
  message: string,
): void {
  expect(error.message).not.toContain(secret);
  expect(error.cause).toBeInstanceOf(SpaceHostValidationError);
  expect((error.cause as Error).message).toBe(message);
  expect((error.cause as Error).message).not.toContain(secret);
}

function urlWithThrowingHref(cause: Error): URL {
  const host = new URL("https://host-b.test/");
  Object.defineProperty(host, "href", {
    get() {
      throw cause;
    },
  });
  return host;
}

describe("memory v2 remote session websocket address", () => {
  it("upgrades http and https urls to websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("http://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("https://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("preserves existing websocket protocols", () => {
    expect(
      toWebSocketAddress(new URL("ws://example.test/storage")).toString(),
    ).toBe("ws://example.test/storage");
    expect(
      toWebSocketAddress(new URL("wss://example.test/storage")).toString(),
    ).toBe("wss://example.test/storage");
  });

  it("adds the memory space to the websocket query", () => {
    expect(
      toSpaceWebSocketAddress(
        new URL("https://example.test/api/storage/memory?trace=1"),
        "did:key:z6Mk-storage-space",
      ).toString(),
    ).toBe(
      "wss://example.test/api/storage/memory?trace=1&space=did%3Akey%3Az6Mk-storage-space",
    );
  });
});

describe("per-space storage address resolution", () => {
  const spaceA = "did:key:z6Mk-space-a" as MemorySpace;
  const spaceB = "did:key:z6Mk-space-b" as MemorySpace;

  it("resolves every space to the default host without a map", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(resolve(spaceB).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
  });

  it("preserves a WebSocket-only default memory host", () => {
    const resolve = createStorageAddressResolver(
      new URL("wss://host-a.test/some/base/"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `wss://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(toSpaceWebSocketAddress(resolve(spaceA), spaceA).protocol).toBe(
      "wss:",
    );
  });

  it("rejects an unsupported default memory host protocol", () => {
    expect(() => createStorageAddressResolver(new URL("ftp://host-a.test")))
      .toThrow("Unsupported memory host protocol: ftp:");
    expect(() => createStorageAddressResolver(new URL("memory://local")))
      .toThrow("Unsupported memory host protocol: memory:");
  });

  it("resolves a mapped space to its host and others to the default", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test"),
      { [spaceB]: "https://host-b.test:8000" },
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
    expect(resolve(spaceB).toString()).toBe(
      `https://host-b.test:8000${MEMORY_STORAGE_PATH}`,
    );
  });

  it("yields distinct websocket targets for spaces on distinct hosts", () => {
    const resolve = createStorageAddressResolver(
      new URL("http://host-a.test"),
      { [spaceB]: "http://host-b.test" },
    );
    const wsA = toSpaceWebSocketAddress(resolve(spaceA), spaceA);
    const wsB = toSpaceWebSocketAddress(resolve(spaceB), spaceB);
    expect(wsA.host).not.toBe(wsB.host);
    expect(wsA.toString()).toBe(
      `ws://host-a.test${MEMORY_STORAGE_PATH}?space=${
        encodeURIComponent(spaceA)
      }`,
    );
    expect(wsB.toString()).toBe(
      `ws://host-b.test${MEMORY_STORAGE_PATH}?space=${
        encodeURIComponent(spaceB)
      }`,
    );
  });

  it("ignores any path on the host base URL (host selection only)", () => {
    const resolve = createStorageAddressResolver(
      new URL("https://host-a.test/some/base/"),
    );
    expect(resolve(spaceA).toString()).toBe(
      `https://host-a.test${MEMORY_STORAGE_PATH}`,
    );
  });

  it("rejects a malformed spaceHostMap entry eagerly, naming the space", () => {
    expect(() =>
      createStorageAddressResolver(
        new URL("https://host-a.test"),
        { [spaceB]: "not a url" },
      )
    ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
  });

  it("rejects a host protocol that cannot serve storage and compute", () => {
    expect(() => storageAddressForHost("ftp://host-b.test"))
      .toThrow("Unsupported space host protocol");
    expect(() => storageAddressForHost("wss://host-b.test"))
      .toThrow("Unsupported space host protocol");
    expect(() =>
      createStorageAddressResolver(
        new URL("https://host-a.test"),
        { [spaceB]: "ftp://host-b.test" },
      )
    ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
  });

  it("rejects route components beyond the origin", () => {
    for (
      const host of [
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/api/..",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => storageAddressForHost(host)).toThrow();
      expect(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      ).toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
    }
  });

  it("preserves safe validation causes without repeating route secrets", () => {
    const hosts = [
      [
        "https://user:storage-password-sentinel@host-b.test/",
        "storage-password-sentinel",
        "Space host must not include credentials",
      ],
      [
        "https://host-b.test/?token=storage-query-sentinel",
        "storage-query-sentinel",
        "Space host must not include a query",
      ],
      [
        "https://user:storage-parse-password-sentinel@[/",
        "storage-parse-password-sentinel",
        "Invalid space host URL",
      ],
    ] as const;
    for (const [host, secret, message] of hosts) {
      const error = captureError(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      );
      expectSafeValidationCause(error, secret, message);
    }
  });

  it("propagates non-validation errors unchanged", () => {
    for (
      const cause of [
        new Error("unexpected route read failure"),
        new TypeError("unexpected route read type failure"),
      ]
    ) {
      const host = urlWithThrowingHref(cause) as unknown as string;
      const error = captureError(() =>
        createStorageAddressResolver(
          new URL("https://host-a.test"),
          { [spaceB]: host },
        )
      );
      expect(error).toBe(cause);
    }
  });
});

/**
 * Stand-in WebSocket that records every dialed URL and never connects.
 * Session creation stalls on the silent socket, which is fine: the test
 * only asserts which hosts were dialed.
 */
class RecordingWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static dialed: string[] = [];
  static #waiters: Array<{ count: number; resolve: () => void }> = [];
  readyState = RecordingWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  constructor(url: string | URL) {
    super();
    RecordingWebSocket.dialed.push(url.toString());
    RecordingWebSocket.#waiters = RecordingWebSocket.#waiters.filter(
      (waiter) => {
        if (RecordingWebSocket.dialed.length >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      },
    );
  }

  /** Resolves once `count` sockets have been dialed — no polling. */
  static whenDialed(count: number): Promise<void> {
    if (RecordingWebSocket.dialed.length >= count) return Promise.resolve();
    return new Promise((resolve) =>
      RecordingWebSocket.#waiters.push({ count, resolve })
    );
  }

  send(_payload: EncodedMemoryMessage): void {}
  close(): void {}
}

describe("StorageManager per-space host wiring", () => {
  it("dials a mapped space on its host and others on the default", {
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    // The pending session promises hold no resources, but their microtask
    // chains outlive the test body; opt out of the op sanitizer for that.

    const realWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    RecordingWebSocket.dialed.length = 0;
    try {
      const signer = await Identity.fromPassphrase("per-space-host-wiring");
      const spaceA = signer.did();
      const spaceB = "did:key:z6Mk-other-space" as MemorySpace;
      const manager = StorageManager.open({
        as: signer,
        memoryHost: new URL("http://host-a.test"),
        spaceHostMap: { [spaceB]: "http://host-b.test" },
      });
      manager.open(spaceA).sync("of:wiring-probe" as URI).catch(() => {});
      manager.open(spaceB).sync("of:wiring-probe" as URI).catch(() => {});
      await RecordingWebSocket.whenDialed(2);
      const hosts = RecordingWebSocket.dialed.map((url) => new URL(url).host)
        .sort();
      expect(hosts).toEqual(["host-a.test", "host-b.test"]);
      for (const url of RecordingWebSocket.dialed) {
        expect(new URL(url).pathname).toBe(MEMORY_STORAGE_PATH);
      }
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
  });

  it("forwards compression preferences without opening a session", async () => {
    const signer = await Identity.fromPassphrase("storage-compression-mode");
    const manager = StorageManager.open({
      as: signer,
      memoryHost: new URL("http://memory.test"),
    });
    try {
      await manager.setMessageCompressionEnabled(false);
    } finally {
      await manager.closeNow();
    }
  });
});

describe("StorageManager.setSessionReadCeiling", () => {
  it("throws once a session is open, so a late ceiling never leaves a session reading unbounded", async () => {
    const identity = await Identity.fromPassphrase(
      "read-ceiling-late-declaration",
    );
    const manager = EmulatedStorageManager.emulate({ as: identity });
    try {
      manager.open(identity.did());
      expect(() =>
        manager.setSessionReadCeiling({
          maxConfidentiality: [identity.did()],
        })
      ).toThrow(/already open/);
    } finally {
      await manager.close();
    }
  });
});

describe("StorageManager.registerSpaceHost", () => {
  // Site-table v0: runtime-learned host hints. A default-host connection
  // remains provisional until the first configured or accepted route is known.

  const spaceSeeded = "did:key:z6Mk-register-seeded" as MemorySpace;
  const spaceLearned = "did:key:z6Mk-register-learned" as MemorySpace;
  const spaceOpened = "did:key:z6Mk-register-opened" as MemorySpace;

  async function makeManager() {
    const signer = await Identity.fromPassphrase("register-space-host");
    return StorageManager.open({
      as: signer,
      memoryHost: new URL("http://host-a.test"),
      spaceHostMap: { [spaceSeeded]: "http://host-seed.test" },
    });
  }

  it("accepts a hint for an untouched space and refuses re-pointing a seeded one", async () => {
    const manager = await makeManager();
    expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
      .toBe(true);
    // Seed wins: same host confirms, different host refuses.
    expect(manager.registerSpaceHost(spaceSeeded, "http://host-seed.test"))
      .toBe(true);
    expect(manager.registerSpaceHost(spaceSeeded, "http://host-evil.test"))
      .toBe(false);
  });

  it("keeps an accepted hint stable and replaces a provisional default route", async () => {
    const realWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
    RecordingWebSocket.dialed.length = 0;
    let manager: Awaited<ReturnType<typeof makeManager>> | undefined;
    try {
      manager = await makeManager();
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test/"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-c.test"))
        .toBe(false);
      manager.open(spaceLearned).sync("of:register-probe" as URI)
        .catch(() => {});
      await RecordingWebSocket.whenDialed(1);
      expect(new URL(RecordingWebSocket.dialed[0]).host).toBe("host-b.test");
      // Now that the space is open: same-host hint confirms; a
      // different host refuses rather than silently re-pointing.
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceLearned, "http://host-c.test"))
        .toBe(false);
      // The opened space refusal also applies with no prior hint.
      manager.open(spaceOpened).sync("of:register-probe" as URI)
        .catch(() => {});
      await RecordingWebSocket.whenDialed(2);
      expect(new URL(RecordingWebSocket.dialed[1]).host).toBe("host-a.test");
      expect(manager.registerSpaceHost(spaceOpened, "http://host-d.test"))
        .toBe(true);
      await RecordingWebSocket.whenDialed(3);
      expect(new URL(RecordingWebSocket.dialed[2]).host).toBe("host-d.test");
      expect(manager.registerSpaceHost(spaceOpened, "http://host-d.test"))
        .toBe(true);
      expect(manager.registerSpaceHost(spaceOpened, "http://host-e.test"))
        .toBe(false);
    } finally {
      await manager?.closeNow();
      (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    }
  });

  it("throws on a malformed host, naming the space", async () => {
    const manager = await makeManager();
    expect(() => manager.registerSpaceHost(spaceLearned, "not a url"))
      .toThrow(`Invalid host for space ${spaceLearned}`);
  });

  describe("registerSpaceHostDetailed()", () => {
    it("returns an acceptance for a first hint and for its confirmation", async () => {
      const manager = await makeManager();
      expect(
        manager.registerSpaceHostDetailed(spaceLearned, "http://host-b.test"),
      ).toEqual({ accepted: true });
      expect(
        manager.registerSpaceHostDetailed(spaceLearned, "http://host-b.test/"),
      ).toEqual({ accepted: true });
      expect(
        manager.registerSpaceHostDetailed(spaceSeeded, "http://host-seed.test"),
      ).toEqual({ accepted: true });
    });

    it("returns `known-different-host` with the seeded host for a seeded space", async () => {
      const manager = await makeManager();
      expect(
        manager.registerSpaceHostDetailed(spaceSeeded, "http://host-evil.test"),
      ).toEqual({
        accepted: false,
        reason: "known-different-host",
        existingHost: "http://host-seed.test/",
      });
    });

    it("returns `known-different-host` with the accepted host for a later hint", async () => {
      const manager = await makeManager();
      expect(manager.registerSpaceHost(spaceLearned, "http://host-b.test"))
        .toBe(true);
      expect(
        manager.registerSpaceHostDetailed(spaceLearned, "http://host-c.test"),
      ).toEqual({
        accepted: false,
        reason: "known-different-host",
        existingHost: "http://host-b.test/",
      });
    });

    it("throws on a malformed host, naming the space", async () => {
      const manager = await makeManager();
      expect(() => manager.registerSpaceHostDetailed(spaceLearned, "not a url"))
        .toThrow(`Invalid host for space ${spaceLearned}`);
    });
  });

  it("rejects an unusable first hint without fixing the route", async () => {
    const manager = await makeManager();
    for (
      const host of [
        "mailto:memory@example.test",
        "wss://host-b.test",
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/%2e%2e/",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => manager.registerSpaceHost(spaceLearned, host))
        .toThrow(`Invalid host for space ${spaceLearned}`);
    }
    expect(manager.registerSpaceHost(spaceLearned, "https://host-b.test"))
      .toBe(true);
  });

  it("preserves safe live validation causes without repeating route secrets", async () => {
    const manager = await makeManager();
    try {
      for (
        const [host, secret, message] of [
          [
            "https://user:live-password-sentinel@host-b.test/",
            "live-password-sentinel",
            "Space host must not include credentials",
          ],
          [
            "https://host-b.test/?token=live-query-sentinel",
            "live-query-sentinel",
            "Space host must not include a query",
          ],
          [
            "https://user:live-parse-password-sentinel@[/",
            "live-parse-password-sentinel",
            "Invalid space host URL",
          ],
        ] as const
      ) {
        const error = captureError(() =>
          manager.registerSpaceHost(spaceLearned, host)
        );
        expectSafeValidationCause(error, secret, message);
      }
    } finally {
      await manager.closeNow();
    }
  });
});

describe("WebSocketTransport failure signaling", () => {
  // A socket the test opens, closes, and errors by hand. Nothing here waits on
  // a real connection or a timer: the transport reaches its close and error
  // handlers because the test dispatches those events synchronously.
  class DrivableWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: DrivableWebSocket[] = [];
    readyState = DrivableWebSocket.CONNECTING;
    binaryType: BinaryType = "blob";
    readonly sent: EncodedMemoryMessage[] = [];
    #sentWaiters: Array<{ count: number; resolve: () => void }> = [];
    constructor(readonly url: string | URL) {
      super();
      DrivableWebSocket.instances.push(this);
    }
    send(payload: EncodedMemoryMessage): void {
      this.sent.push(payload);
      this.#sentWaiters = this.#sentWaiters.filter((waiter) => {
        if (this.sent.length >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      });
    }
    whenSent(count: number): Promise<void> {
      if (this.sent.length >= count) return Promise.resolve();
      return new Promise((resolve) =>
        this.#sentWaiters.push({ count, resolve })
      );
    }
    openConnection(): void {
      this.readyState = DrivableWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }
    receive(payload: MemoryMessageFrame): void {
      this.dispatchEvent(new MessageEvent("message", { data: payload }));
    }
    fail(error: Error): void {
      this.dispatchEvent(new ErrorEvent("error", { error }));
    }
    close(): void {
      this.readyState = DrivableWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }

  class DeferredBlob extends Blob {
    readonly started = Promise.withResolvers<void>();
    readonly released = Promise.withResolvers<void>();

    readonly #contents: ArrayBuffer;

    constructor(contents = new Uint8Array([0]).buffer) {
      super();
      this.#contents = contents;
    }

    override async arrayBuffer(): Promise<ArrayBuffer> {
      this.started.resolve();
      await this.released.promise;
      return this.#contents;
    }
  }

  // Install the drivable socket, hand the body a transport and its socket, then
  // always restore the real global. `send()` reaches `open()`, which constructs
  // the socket synchronously, so `socket()` is available before any event.
  function withTransport(
    body: (
      transport: WebSocketTransport,
      socket: () => DrivableWebSocket,
    ) => Promise<void>,
    write?: (frame: EncodedMemoryMessage) => Promise<void>,
    createSocket: MemorySocketFactory = createNativeMemorySocket,
  ): Promise<void> {
    const realWebSocket = globalThis.WebSocket;
    DrivableWebSocket.instances.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = DrivableWebSocket;
    const transport = new WebSocketTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      (address) => {
        const connection = createSocket(address);
        return {
          socket: connection.socket,
          send: (frame) => {
            connection.send(frame);
            return write?.(frame);
          },
        };
      },
    );
    return body(transport, () => DrivableWebSocket.instances.at(-1)!)
      .finally(() => {
        (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
      });
  }

  const requireTextFrame = (frame: EncodedMemoryMessage): string => {
    if (typeof frame !== "string") throw new Error("Expected text frame");
    return frame;
  };

  /**
   * Aborts `controller` at the moment the memory client stops listening for
   * aborts on the signal, which it does once its handshake is done and before
   * the promise `create` is awaiting resolves. Nothing else on the signal is
   * disturbed, and aborting twice is harmless, so the later removals do no
   * more than the first.
   *
   * Returns whether the abort has happened yet. Where in the client's own
   * cleanup the first removal falls is the client's business rather than this
   * file's, so a case reads that back and states which side of the handshake
   * the abort landed on. A client that grew an earlier removal would then fail
   * the case rather than quietly move it to a window it was not written for.
   */
  const abortWhenClientStopsListening = (
    controller: AbortController,
    reason: Error,
  ): () => boolean => {
    const signal = controller.signal;
    const remove = signal.removeEventListener.bind(signal);
    signal.removeEventListener = ((
      ...args: Parameters<AbortSignal["removeEventListener"]>
    ) => {
      remove(...args);
      controller.abort(reason);
    }) as AbortSignal["removeEventListener"];
    return () => signal.aborted;
  };

  /**
   * Aborts `controller` at the moment a mount resolves, before whoever awaited
   * it is resumed. Returns the undo, which every caller runs: the patch is on
   * the shared client prototype.
   */
  const abortWhenMountResolves = (
    controller: AbortController,
    reason: Error,
  ): () => void => {
    const prototype = MemoryClient.Client.prototype;
    const mount = prototype.mount;
    prototype.mount = function (
      this: MemoryClient.Client,
      ...args: Parameters<MemoryClient.Client["mount"]>
    ) {
      return mount.apply(this, args).then((session) => {
        controller.abort(reason);
        return session;
      });
    };
    return () => {
      prototype.mount = mount;
    };
  };

  /** Answers `hello` as a server using signed session-open authentication. */
  const answerHello = (socket: DrivableWebSocket): void => {
    socket.receive(encodeMemoryBoundary({
      type: "hello.ok",
      protocol: MEMORY_PROTOCOL,
      flags: { ...getMemoryProtocolFlags(), connectionAuth: false },
      sessionOpen: TEST_HELLO_SESSION_OPEN,
    }));
  };

  /** Answers the `session.open` the client sent as its second frame. */
  const answerSessionOpen = (
    socket: DrivableWebSocket,
    sessionId: string,
    requestIndex = 1,
  ): void => {
    const open = decodeMemoryBoundary(
      requireTextFrame(socket.sent[requestIndex]),
    ) as {
      requestId: string;
    };
    socket.receive(encodeMemoryBoundary({
      type: "response",
      requestId: open.requestId,
      ok: {
        sessionId,
        sessionToken: `token:${sessionId}`,
        serverSeq: 0,
        sessionOpen: TEST_HELLO_SESSION_OPEN,
      },
    }));
  };

  /**
   * A transport that never negotiates message compression, so every frame it
   * sends is text an in-process memory server can read.
   */
  class TextOnlyTransport extends WebSocketTransport {
    /** @inheritDoc */
    override get supportsMessageCompression(): boolean {
      return false;
    }
  }

  /** Returns the message type of the text frame `frame`. */
  const frameType = (frame: EncodedMemoryMessage): string | undefined =>
    (decodeMemoryBoundary(requireTextFrame(frame)) as { type?: string }).type;

  /**
   * Returns a socket factory whose sockets reach `server`. Each socket opens as
   * soon as the transport has attached its listeners, so the client's
   * reconnects need nothing from the test. A frame reaches the server once
   * `write` has settled successfully for it, and only while its socket is still
   * open, as a frame still being written when the connection drops is lost with
   * it.
   */
  const serverWiredSockets = (
    server: MemoryServer,
    write: (frame: EncodedMemoryMessage) => Promise<void> | undefined,
  ): MemorySocketFactory =>
  (address) => {
    const socket = new DrivableWebSocket(address);
    const peer = server.connect((message) => {
      if (socket.readyState === DrivableWebSocket.OPEN) {
        socket.receive(encodeMemoryBoundary(message));
      }
    });
    socket.addEventListener("close", () => peer.close());
    queueMicrotask(() => socket.openConnection());
    return {
      socket: socket as unknown as MemorySocket,
      send: async (frame) => {
        socket.send(frame);
        await write(frame);
        if (socket.readyState === DrivableWebSocket.OPEN) {
          void peer.receive(requireTextFrame(frame));
        }
      },
    };
  };

  /** Returns a commit setting the document `id` to `localSeq`. */
  const commitAt = (localSeq: number, id: string) => ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set" as const, id, value: { value: localSeq } }],
  });

  it("resets an open connection and ignores its queued frames and late close events", async () => {
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      const delivered = Promise.withResolvers<void>();
      let disconnects = 0;
      transport.setReceiver((payload) => {
        received.push(payload);
        delivered.resolve();
      });
      transport.setCloseReceiver(() => disconnects++);
      const initialSend = transport.send("initial");
      const initial = socket();
      initial.openConnection();
      await initialSend;

      initial.receive("stale");
      transport.reset();
      expect(initial.readyState).toBe(DrivableWebSocket.CLOSED);
      const nextSend = transport.send("next");
      const next = socket();
      expect(next).not.toBe(initial);
      next.openConnection();
      await nextSend;
      initial.dispatchEvent(new Event("close"));
      next.receive("fresh");
      await delivered.promise;
      expect(received).toEqual(["fresh"]);
      expect(disconnects).toBe(0);
      expect(next.sent).toEqual(["next"]);
      await transport.close();
      await expect(transport.send("closed")).rejects.toThrow(
        "Memory transport closed",
      );
    });
  });

  it("rejects an opening connection on reset and permits a new one", async () => {
    await withTransport(async (transport, socket) => {
      const pending = transport.send("initial");
      const rejected = expect(pending).rejects.toThrow(
        "memory websocket transport closed before opening",
      );
      transport.reset();
      await rejected;

      const next = transport.send("next");
      socket().openConnection();
      await next;
      expect(socket().sent).toEqual(["next"]);
      await transport.close();
    });
  });

  it("refuses to open a session declaring a read ceiling on a server that does not advertise `sessionReadCeiling`", async () => {
    // Such a server would accept the descriptor and serve every query
    // unbounded, so the refusal lands before the session opens.
    const identity = await Identity.fromPassphrase(
      "read-ceiling-gate-remote-session",
    );
    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        identity,
        createNativeMemorySocket,
      );
      const opening = factory.create(identity.did(), identity, {
        readCeiling: { maxConfidentiality: [identity.did()] },
      });
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      const { sessionReadCeiling: _, ...older } = getMemoryProtocolFlags();
      activeSocket.receive(encodeMemoryBoundary({
        type: "hello.ok",
        protocol: MEMORY_PROTOCOL,
        flags: older,
        sessionOpen: TEST_HELLO_SESSION_OPEN,
      }));
      await expect(opening).rejects.toThrow(/sessionReadCeiling/);
      expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
      // Only the hello went out: no session.open was signed for a server
      // that could not honor it.
      expect(activeSocket.sent).toHaveLength(1);
    });
  });

  it("rejects the in-flight send and closes cleanly when the socket closes before opening", async () => {
    await withTransport(async (transport, socket) => {
      let closeCalled = false;
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeCalled = true;
        closeError = error;
      });

      const send = transport.send("frame").then(
        () => undefined,
        (error: unknown) => error,
      );
      socket().readyState = DrivableWebSocket.CLOSED;
      socket().dispatchEvent(new Event("close"));

      const failure = await send;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe(
        "memory websocket transport closed before opening",
      );
      // A close before opening is not an error, so the receiver gets none.
      expect(closeCalled).toBe(true);
      expect(closeError).toBeUndefined();
    });
  });

  it("rejects a compression control when the socket closes before opening", async () => {
    await withTransport(async (transport, socket) => {
      transport.setMessageCompressionEnabled(true);
      const control = transport.requestMessageCompression(false);
      socket().readyState = DrivableWebSocket.CLOSED;
      socket().dispatchEvent(new Event("close"));

      await expect(control).rejects.toThrow(
        "memory websocket transport closed before opening",
      );
    });
  });

  it("declines compression controls before negotiation", async () => {
    await withTransport(async (transport) => {
      expect(await transport.requestMessageCompression(false)).toBe(false);
      expect(DrivableWebSocket.instances).toHaveLength(0);
    });
  });

  it("dials once for two sends issued while the socket is opening", async () => {
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const second = transport.send("second");
      const activeSocket = socket();
      activeSocket.openConnection();

      await Promise.all([first, second]);
      expect(activeSocket.sent).toEqual(["first", "second"]);
      expect(DrivableWebSocket.instances).toHaveLength(1);
    });
  });

  it("sends and accepts a routed frame of ROUTED_FRAME_SLOTS values and refuses one more", async () => {
    // The constant matches the toolshed's default `limits.frameSlots`; a
    // deployment that lowers either must lower both.
    expect(ROUTED_FRAME_SLOTS).toBe(DEFAULT_ROUTED_HOST_LIMITS.frameSlots);
    await withTransport(async (transport, socket) => {
      const received: string[] = [];
      const delivered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<Error | undefined>();
      transport.setReceiver((payload) => {
        received.push(payload);
        delivered.resolve();
      });
      transport.setCloseReceiver((error) => closed.resolve(error));
      const exact = routedFrameOf(ROUTED_FRAME_SLOTS);
      const over = routedFrameOf(ROUTED_FRAME_SLOTS + 1);
      try {
        // Opening resets the codec, so the routed hello selects it afterwards.
        const hello = transport.send("hello");
        const activeSocket = socket();
        activeSocket.openConnection();
        await hello;
        transport.setRoutedMessagesEnabled(true);
        transport.setMessageCompressionEnabled(true);
        await transport.send(exact);
        expect(activeSocket.sent).toHaveLength(2);
        const sent = activeSocket.sent[1];
        expect(sent).toBeInstanceOf(Uint8Array);
        expect(
          decodeRoutedFrame(sent as Uint8Array, true, ROUTED_FRAME_SLOTS)
            .payload,
        ).toBe(exact);
        // One value more is refused before it is sent.
        await expect(transport.send(over)).rejects.toThrow();
        expect(activeSocket.sent).toHaveLength(2);

        activeSocket.receive(exact);
        await delivered.promise;
        expect(received).toEqual([exact]);
        // One value more received closes the socket and reports the failure.
        activeSocket.receive(over);
        expect(await closed.promise).toBeInstanceOf(Error);
        expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
        expect(received).toHaveLength(1);
      } finally {
        await transport.close();
      }
    });
  });

  it("applies ROUTED_FRAME_SLOTS to a raw routed frame when compression is off", async () => {
    await withTransport(async (transport, socket) => {
      const exact = routedFrameOf(ROUTED_FRAME_SLOTS);
      try {
        const hello = transport.send("hello");
        const activeSocket = socket();
        activeSocket.openConnection();
        await hello;
        transport.setRoutedMessagesEnabled(true);
        transport.setMessageCompressionEnabled(false);
        await transport.send(exact);
        expect(activeSocket.sent).toEqual(["hello", exact]);
        await expect(transport.send(routedFrameOf(ROUTED_FRAME_SLOTS + 1)))
          .rejects.toThrow();
        expect(activeSocket.sent).toHaveLength(2);
      } finally {
        await transport.close();
      }
    });
  });

  it("opens a fresh socket after socket construction fails", async () => {
    const failure = new Error("Unable to construct memory socket");
    let attempts = 0;
    await withTransport(
      async (transport, socket) => {
        try {
          await expect(transport.send("first")).rejects.toBe(failure);
          expect(attempts).toBe(1);
          expect(DrivableWebSocket.instances).toHaveLength(0);

          const second = transport.send("second");
          expect(attempts).toBe(2);
          expect(DrivableWebSocket.instances).toHaveLength(1);
          socket().openConnection();
          await second;
          expect(socket().sent).toEqual(["second"]);
        } finally {
          await transport.close();
        }
      },
      undefined,
      (address) => {
        if (++attempts === 1) throw failure;
        return createNativeMemorySocket(address);
      },
    );
  });

  it("waits for local write completion before resolving or sending the next frame", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      let completed = false;
      const first = transport.send("first").then(() => completed = true);
      const second = transport.send("second");
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      await clock.settle();
      expect(completed).toBe(false);
      expect(activeSocket.sent).toEqual(["first"]);

      write.resolve();
      await Promise.all([first, second]);
      expect(completed).toBe(true);
      expect(activeSocket.sent).toEqual(["first", "second"]);
      await transport.close();
    }, () => write.promise);
  });

  it("reports a failed write as a lost connection and sends later frames on a new socket", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });
      const writeFailure = new Error("TLS write failed");
      const first = transport.send("first").then(
        () => undefined,
        (error: unknown) => error,
      );
      const second = transport.send("second").then(
        () => undefined,
        (error: unknown) => error,
      );
      const failed = socket();
      failed.openConnection();
      await failed.whenSent(1);
      write.reject(writeFailure);

      const failure = await first;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe("TLS write failed");
      expect((failure as Error).cause).toBe(writeFailure);
      // The transport reports the loss itself; the socket has reported nothing.
      expect(closeError).toBe(failure);
      // A frame queued behind the failed write is lost with the connection.
      expect(((await second) as Error).name).toBe("ConnectionError");
      expect(failed.sent).toEqual(["first"]);

      // The send queue is not poisoned: the next send opens a new socket.
      const third = transport.send("third");
      const replacement = socket();
      expect(replacement).not.toBe(failed);
      replacement.openConnection();
      await third;
      expect(replacement.sent).toEqual(["third"]);
      await transport.close();
    }, (frame) => frame === "first" ? write.promise : Promise.resolve());
  });

  it("rejects a send with a `ConnectionError` carrying the failure when its write fails with a value other than an `Error`", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      const send = transport.send("frame").then(
        () => undefined,
        (error: unknown) => error,
      );
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      write.reject("socket gone");
      const failure = await send;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe("Memory websocket write failed");
      expect((failure as Error).cause).toBe("socket gone");
      await transport.close();
    }, () => write.promise);
  });

  it("rejects queued sends after close without reopening the socket", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const second = transport.send("second");
      const failure = expect(second).rejects.toThrow("changed before send");
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      await transport.close();
      write.resolve();
      await first;
      await failure;
      await expect(transport.send("after close")).rejects.toThrow(
        "Memory transport closed",
      );
      expect(activeSocket.sent).toEqual(["first"]);
      expect(DrivableWebSocket.instances).toHaveLength(1);
    }, () => write.promise);
  });

  it("rejects a send queued behind a pending write with a `ConnectionError` when the socket closes", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const second = transport.send("second").then(
        () => undefined,
        (error: unknown) => error,
      );
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      activeSocket.close();
      write.resolve();
      await first;
      const failure = await second;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe(
        "Memory websocket changed before send",
      );
      expect(activeSocket.sent).toEqual(["first"]);
    }, () => write.promise);
  });

  it("queues compression controls behind outstanding writes", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      transport.setMessageCompressionEnabled(true);
      const control = transport.requestMessageCompression(false);
      await clock.settle();
      expect(activeSocket.sent).toEqual(["first"]);
      write.resolve();
      await first;
      await activeSocket.whenSent(2);
      activeSocket.receive(requireTextFrame(activeSocket.sent[1]));
      expect(await control).toBe(false);
      await transport.close();
    }, () => write.promise);
  });

  it("preserves errors from a non-DOM socket event", async () => {
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const activeSocket = socket();
      activeSocket.openConnection();
      await first;
      const closed = Promise.withResolvers<Error | undefined>();
      transport.setCloseReceiver(closed.resolve);
      const error = new Error("Node TLS failure");
      activeSocket.dispatchEvent(Object.assign(new Event("error"), { error }));
      expect(await closed.promise).toBe(error);
      activeSocket.close();
      await transport.close();
    });
  });

  it("compresses and expands negotiated messages without reordering them", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      transport.setMessageCompressionEnabled(true);

      const payloads = [
        "first compressed message ".repeat(1_000),
        "small second",
        "third compressed message ".repeat(1_000),
        "small fourth",
      ];
      await Promise.all(payloads.map((payload) => transport.send(payload)));

      expect(activeSocket.sent[1]).toBeInstanceOf(Uint8Array);
      expect(typeof activeSocket.sent[2]).toBe("string");
      expect(activeSocket.sent[3]).toBeInstanceOf(Uint8Array);
      expect(typeof activeSocket.sent[4]).toBe("string");
      expect(
        await Promise.all(
          activeSocket.sent.slice(1).map(decodeCompressedMemoryMessage),
        ),
      ).toEqual(payloads);

      const received = Promise.withResolvers<string>();
      transport.setReceiver(received.resolve);
      activeSocket.receive(await encodeCompressedMemoryMessage(payloads[0]));
      expect(await received.promise).toBe(payloads[0]);
    });
  });

  it("uses the compression mode active when each send is submitted", async () => {
    await withTransport(async (transport, socket) => {
      const hello = transport.send("hello");
      transport.setMessageCompressionEnabled(true);
      const large = "submitted before compression was disabled ".repeat(1_000);
      const submittedWhileEnabled = transport.send(large);
      const disabling = transport.requestMessageCompression(false);

      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(3);

      expect(activeSocket.sent[0]).toBe("hello");
      expect(activeSocket.sent[1]).toBeInstanceOf(Uint8Array);
      const control = parseMemoryCompressionControlMessage(
        requireTextFrame(activeSocket.sent[2]),
      );
      if (!control) throw new Error("Expected disable control");
      activeSocket.receive(encodeMemoryCompressionControlMessage({
        requestId: control.requestId,
        enabled: false,
      }));

      await Promise.all([hello, submittedWhileEnabled, disabling]);
      expect(await decodeCompressedMemoryMessage(activeSocket.sent[1])).toBe(
        large,
      );
    });
  });

  it("changes compression on a live socket", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      transport.setMessageCompressionEnabled(true);

      const disabling = transport.requestMessageCompression(false);
      await activeSocket.whenSent(2);
      const disableControl = parseMemoryCompressionControlMessage(
        requireTextFrame(activeSocket.sent[1]),
      );
      expect(disableControl?.enabled).toBe(false);
      if (!disableControl) throw new Error("Expected disable control");
      activeSocket.receive(encodeMemoryCompressionControlMessage({
        requestId: disableControl.requestId,
        enabled: false,
      }));
      expect(await disabling).toBe(false);

      const large = "visible memory websocket message ".repeat(1_000);
      await transport.send(large);
      expect(activeSocket.sent[2]).toBe(large);

      const received = Promise.withResolvers<string>();
      transport.setReceiver(received.resolve);
      activeSocket.receive(await encodeCompressedMemoryMessage(large));
      expect(await received.promise).toBe(large);

      const enabling = transport.requestMessageCompression(true);
      await activeSocket.whenSent(4);
      const enableControl = parseMemoryCompressionControlMessage(
        requireTextFrame(activeSocket.sent[3]),
      );
      expect(enableControl?.enabled).toBe(true);
      if (!enableControl) throw new Error("Expected enable control");
      activeSocket.receive(encodeMemoryCompressionControlMessage({
        requestId: enableControl.requestId,
        enabled: true,
      }));
      expect(await enabling).toBe(true);
      await transport.send(large);
      expect(activeSocket.sent[4]).toBeInstanceOf(Uint8Array);
    });
  });

  it("rejects unsupported websocket message values", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      const closed = Promise.withResolvers<Error | undefined>();
      transport.setCloseReceiver(closed.resolve);

      activeSocket.receive({ invalid: true } as unknown as MemoryMessageFrame);

      await expect(closed.promise).resolves.toMatchObject({
        message: "Unable to decode compressed memory websocket message",
        cause: { message: "Unsupported memory websocket frame type" },
      });
    });
  });

  it("rejects binary websocket messages before negotiation", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      const closed = Promise.withResolvers<Error | undefined>();
      transport.setCloseReceiver(closed.resolve);

      activeSocket.receive(new Uint8Array([1, 2, 3]));

      await expect(closed.promise).resolves.toMatchObject({
        message: "Unable to decode compressed memory websocket message",
        cause: {
          message:
            "Memory websocket expects text before compression negotiation",
        },
      });
    });
  });

  it("rejects invalid negotiated compression envelopes", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      transport.setMessageCompressionEnabled(true);
      const closed = Promise.withResolvers<Error | undefined>();
      transport.setCloseReceiver(closed.resolve);

      activeSocket.receive(new Uint8Array([1, 2, 3]));

      await expect(closed.promise).resolves.toMatchObject({
        message: "Unable to decode compressed memory websocket message",
        cause: { message: "Invalid memory compression envelope" },
      });
    });
  });

  it("rejects a queued control when its websocket is replaced", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      transport.setMessageCompressionEnabled(true);

      const control = transport.requestMessageCompression(false).then(
        () => undefined,
        (error: unknown) => error,
      );
      activeSocket.fail(new Error("replace socket before control send"));

      const failure = await control;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe(
        "Memory websocket changed before compression control",
      );
    });
  });

  it("ignores stale close events after a replacement socket enables compression", async () => {
    await withTransport(async (transport, socket) => {
      const firstOpening = transport.send("first hello");
      const firstSocket = socket();
      firstSocket.openConnection();
      await firstOpening;
      transport.setMessageCompressionEnabled(true);
      const closes: Array<Error | undefined> = [];
      transport.setCloseReceiver((error) => closes.push(error));

      firstSocket.fail(new Error("replace first socket"));
      const replacementOpening = transport.send("replacement hello");
      const replacementSocket = socket();
      replacementSocket.openConnection();
      await replacementOpening;
      transport.setMessageCompressionEnabled(true);
      firstSocket.receive("stale response");
      firstSocket.close();

      await transport.send("replacement compressed message ".repeat(1_000));
      expect(replacementSocket.sent.at(-1)).toBeInstanceOf(Uint8Array);
      expect(closes).toHaveLength(1);
    });
  });

  it("ignores a stale decode failure after the socket is replaced", async () => {
    await withTransport(async (transport, socket) => {
      const firstOpening = transport.send("first hello");
      const firstSocket = socket();
      firstSocket.openConnection();
      await firstOpening;
      transport.setMessageCompressionEnabled(true);
      const closes: Array<Error | undefined> = [];
      transport.setCloseReceiver((error) => closes.push(error));
      const staleFrame = new DeferredBlob();
      firstSocket.receive(staleFrame);
      await staleFrame.started.promise;

      firstSocket.fail(new Error("replace decoding socket"));
      const replacementOpening = transport.send("replacement hello");
      const replacementSocket = socket();
      replacementSocket.openConnection();
      await replacementOpening;
      transport.setMessageCompressionEnabled(true);
      const received = Promise.withResolvers<string>();
      transport.setReceiver(received.resolve);
      staleFrame.released.resolve();
      replacementSocket.receive("replacement response");

      expect(await received.promise).toBe("replacement response");
      expect(closes).toHaveLength(1);
      await transport.send("replacement compressed message ".repeat(1_000));
      expect(replacementSocket.sent.at(-1)).toBeInstanceOf(Uint8Array);
    });
  });

  it("ignores a stale decoded message after the socket is replaced", async () => {
    await withTransport(async (transport, socket) => {
      const firstOpening = transport.send("first hello");
      const firstSocket = socket();
      firstSocket.openConnection();
      await firstOpening;
      transport.setMessageCompressionEnabled(true);
      const payload = "stale compressed response ".repeat(1_000);
      const encoded = await encodeCompressedMemoryMessage(payload);
      if (!(encoded instanceof Uint8Array)) {
        throw new Error("Expected compressed response");
      }
      const staleFrame = new DeferredBlob(encoded.buffer.slice(0));
      firstSocket.receive(staleFrame);
      await staleFrame.started.promise;

      firstSocket.fail(new Error("replace decoded socket"));
      const replacementOpening = transport.send("replacement hello");
      const replacementSocket = socket();
      replacementSocket.openConnection();
      await replacementOpening;
      transport.setMessageCompressionEnabled(true);
      const received = Promise.withResolvers<string>();
      transport.setReceiver(received.resolve);
      staleFrame.released.resolve();
      replacementSocket.receive("replacement response");

      expect(await received.promise).toBe("replacement response");
    });
  });

  it("reports receiver failures without labeling them as decode failures", async () => {
    await withTransport(async (transport, socket) => {
      const opening = transport.send("hello");
      const activeSocket = socket();
      activeSocket.openConnection();
      await opening;
      const failure = new Error("receiver failed");
      const reported = Promise.withResolvers<unknown>();
      const onError = (event: ErrorEvent) => {
        event.preventDefault();
        reported.resolve(event.error);
      };
      globalThis.addEventListener("error", onError, { once: true });
      const closes: Array<Error | undefined> = [];
      transport.setCloseReceiver((error) => closes.push(error));
      transport.setReceiver(() => {
        throw failure;
      });
      try {
        activeSocket.receive("ordinary response");
        expect(await reported.promise).toBe(failure);
        expect(closes).toEqual([]);
        expect(activeSocket.readyState).toBe(WebSocket.OPEN);
      } finally {
        globalThis.removeEventListener("error", onError);
      }
    });
  });

  it("rejects a remote session whose signal is aborted before it dials", async () => {
    const signer = await Identity.fromPassphrase("pre-aborted-remote-session");
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");
    controller.abort(reason);

    await withTransport(async () => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );

      await expect(
        factory.create(signer.did(), signer, {}, controller.signal),
      ).rejects.toBe(reason);
      expect(DrivableWebSocket.instances).toHaveLength(0);
    });
  });

  it("applies a disabled preference to remote sessions opened later", async () => {
    const signer = await Identity.fromPassphrase(
      "disabled-compression-remote-session",
    );
    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      await factory.setMessageCompressionEnabled(false);
      const opening = factory.create(signer.did(), signer, {});
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      answerHello(activeSocket);

      await activeSocket.whenSent(2);
      const control = parseMemoryCompressionControlMessage(
        requireTextFrame(activeSocket.sent[1]),
      );
      expect(control?.enabled).toBe(false);
      if (!control) throw new Error("Expected disable control");
      activeSocket.receive(encodeMemoryCompressionControlMessage({
        requestId: control.requestId,
        enabled: false,
      }));

      await activeSocket.whenSent(3);
      expect(typeof activeSocket.sent[2]).toBe("string");
      answerSessionOpen(activeSocket, "disabled-compression-session", 2);
      const created = await opening;
      await created.client.close();
    });
  });

  it("rejects a remote session whose signer reports a signing failure", async () => {
    const identity = await Identity.fromPassphrase("failing-signer-session");
    const failure = new Error("signing key unavailable");
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      sign: () => ({ error: failure }),
    };

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      const opening = factory.create(signer.did(), signer, {});
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      answerHello(activeSocket);

      await expect(opening).rejects.toBe(failure);
      // The failure lands while signing the session.open, so that frame was
      // never sent.
      expect(activeSocket.sent).toHaveLength(1);
    });
  });

  it("cancels a remote session while its websocket is opening", async () => {
    const signer = await Identity.fromPassphrase(
      "cancel-opening-remote-session",
    );
    const space = signer.did();
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");
    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      const opening = factory.create(
        space,
        signer,
        {},
        controller.signal,
      );

      controller.abort(reason);

      await expect(opening).rejects.toBe(reason);
      expect(socket().readyState).toBe(DrivableWebSocket.CLOSED);
    });
  });

  it("cancels a remote session while its session signature is pending", async () => {
    const identity = await Identity.fromPassphrase(
      "cancel-signing-remote-session",
    );
    const signingStarted = Promise.withResolvers<void>();
    const releaseSigning = Promise.withResolvers<void>();
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      async sign(payload) {
        signingStarted.resolve();
        await releaseSigning.promise;
        return await identity.sign(payload);
      },
    };
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      const opening = factory.create(
        signer.did(),
        signer,
        {},
        controller.signal,
      );
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      activeSocket.receive(encodeMemoryBoundary({
        type: "hello.ok",
        protocol: MEMORY_PROTOCOL,
        flags: { ...getMemoryProtocolFlags(), connectionAuth: false },
        sessionOpen: TEST_HELLO_SESSION_OPEN,
      }));
      await signingStarted.promise;

      controller.abort(reason);

      await expect(opening).rejects.toBe(reason);
      expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
      expect(activeSocket.sent).toHaveLength(1);
      releaseSigning.resolve();
    });
  });

  it("cancels reconnect session signing before closing the old client", async () => {
    const identity = await Identity.fromPassphrase(
      "cancel-reconnect-signing-remote-session",
    );
    const reconnectSigningStarted = Promise.withResolvers<void>();
    const releaseReconnectSigning = Promise.withResolvers<void>();
    let signatures = 0;
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      async sign(payload) {
        signatures++;
        if (signatures === 2) {
          reconnectSigningStarted.resolve();
          await releaseReconnectSigning.promise;
        }
        return await identity.sign(payload);
      },
    };
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      let opened:
        | Awaited<ReturnType<RemoteSessionFactory["create"]>>
        | undefined;
      try {
        const opening = factory.create(
          signer.did(),
          signer,
          {},
          controller.signal,
        );
        const initialSocket = socket();
        initialSocket.openConnection();
        await initialSocket.whenSent(1);
        initialSocket.receive(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: { ...getMemoryProtocolFlags(), connectionAuth: false },
          sessionOpen: TEST_HELLO_SESSION_OPEN,
        }));
        await initialSocket.whenSent(2);
        const initialOpen = decodeMemoryBoundary(
          requireTextFrame(initialSocket.sent[1]),
        ) as { requestId: string };
        initialSocket.receive(encodeMemoryBoundary({
          type: "response",
          requestId: initialOpen.requestId,
          ok: {
            sessionId: "session:cancel-reconnect-signing",
            sessionToken: "token:cancel-reconnect-signing",
            serverSeq: 0,
            sessionOpen: TEST_HELLO_SESSION_OPEN,
          },
        }));
        opened = await opening;

        initialSocket.close();
        const reconnectSocket = socket();
        expect(reconnectSocket).not.toBe(initialSocket);
        reconnectSocket.openConnection();
        await reconnectSocket.whenSent(1);
        reconnectSocket.receive(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: { ...getMemoryProtocolFlags(), connectionAuth: false },
          sessionOpen: TEST_HELLO_SESSION_OPEN,
        }));
        await reconnectSigningStarted.promise;

        controller.abort(reason);
        await opened.client.close();

        expect(reconnectSocket.readyState).toBe(DrivableWebSocket.CLOSED);
        expect(reconnectSocket.sent).toHaveLength(1);
        expect(signatures).toBe(2);
      } finally {
        controller.abort(reason);
        releaseReconnectSigning.resolve();
        await opened?.client.close();
      }
    });
  });

  it("cancels a remote session aborted between connecting and mounting", async () => {
    const signer = await Identity.fromPassphrase(
      "cancel-connected-remote-session",
    );
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");
    const hasAborted = abortWhenClientStopsListening(controller, reason);

    await withTransport(async (_transport, socket) => {
      const factory = new RemoteSessionFactory(
        () => new URL("wss://memory.test/api/storage/memory"),
        signer,
        createNativeMemorySocket,
      );
      const opening = factory.create(
        signer.did(),
        signer,
        {},
        controller.signal,
      );
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      // The route is still live while the handshake is in flight: this case is
      // about the abort that lands after it, not during it.
      expect(hasAborted()).toBe(false);
      answerHello(activeSocket);

      await expect(opening).rejects.toBe(reason);
      expect(hasAborted()).toBe(true);
      // No session.open followed the handshake, and the connection the
      // handshake opened did not survive the rejection.
      expect(activeSocket.sent).toHaveLength(1);
      expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
    });
  });

  it("cancels a remote session aborted between mounting and returning", async () => {
    const signer = await Identity.fromPassphrase(
      "cancel-mounted-remote-session",
    );
    const controller = new AbortController();
    const reason = new Error("memory replica route replaced");
    const restoreMount = abortWhenMountResolves(controller, reason);

    try {
      await withTransport(async (_transport, socket) => {
        const factory = new RemoteSessionFactory(
          () => new URL("wss://memory.test/api/storage/memory"),
          signer,
          createNativeMemorySocket,
        );
        const opening = factory.create(
          signer.did(),
          signer,
          {},
          controller.signal,
        );
        const activeSocket = socket();
        activeSocket.openConnection();
        await activeSocket.whenSent(1);
        answerHello(activeSocket);
        await activeSocket.whenSent(2);
        answerSessionOpen(activeSocket, "session:cancel-mounted");

        // The server opened the session, so the mount resolved; the route was
        // replaced before `create` could hand the session back.
        await expect(opening).rejects.toBe(reason);
        expect(activeSocket.readyState).toBe(DrivableWebSocket.CLOSED);
      });
    } finally {
      restoreMount();
    }
  });

  it("surfaces the underlying Error of a socket error to the close receiver", async () => {
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });

      const boom = new Error("connection refused");
      const send = transport.send("frame").then(
        () => undefined,
        (error: unknown) => error,
      );
      socket().dispatchEvent(new ErrorEvent("error", { error: boom }));

      const failure = await send;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe("connection refused");
      expect((failure as Error).cause).toBe(boom);
      expect(closeError).toBe(boom);
    });
  });

  it("reports a generic transport error when the error event carries no Error", async () => {
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });

      const send = transport.send("frame").then(
        () => undefined,
        (error: unknown) => error,
      );
      socket().dispatchEvent(new Event("error"));

      const failure = await send;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("ConnectionError");
      expect((failure as Error).message).toBe(
        "memory websocket transport error",
      );
      expect(closeError).toBeInstanceOf(Error);
      expect(closeError?.message).toContain("memory websocket transport error");
    });
  });

  it("resolves commits queued behind a pending write when the socket closes, once the client reconnects", async () => {
    // The first commit's write is still in progress when the peer drops the
    // connection, and the second commit waits behind it. Neither reaches the
    // server on that connection, so the client replays both on the next one.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    const write = Promise.withResolvers<void>();
    let holdNextTransact = false;
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      serverWiredSockets(server, (frame) => {
        if (!holdNextTransact || frameType(frame) !== "transact") return;
        holdNextTransact = false;
        return write.promise;
      }),
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-queued-commit-replay",
        {},
        testSessionOpenAuthFactory,
      );
      const dropped = DrivableWebSocket.instances.at(-1)!;
      const sentBefore = dropped.sent.length;
      holdNextTransact = true;
      const outcomes = Promise.allSettled([
        session.transact(commitAt(1, "of:first")),
        session.transact(commitAt(2, "of:second")),
      ]);
      await dropped.whenSent(sentBefore + 1);
      dropped.close();
      write.resolve();
      await client.restoreConnection();

      expect((await outcomes).map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect(DrivableWebSocket.instances.at(-1)).not.toBe(dropped);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves a commit whose write fails while the socket is closing, once the client reconnects", async () => {
    // The peer has started closing the connection, so the socket refuses the
    // write before it reports the close. The commit never reached the server
    // and is replayed on the next connection.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    const write = Promise.withResolvers<void>();
    let holdNextTransact = false;
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      serverWiredSockets(server, (frame) => {
        if (!holdNextTransact || frameType(frame) !== "transact") return;
        holdNextTransact = false;
        return write.promise;
      }),
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-closing-commit-replay",
        {},
        testSessionOpenAuthFactory,
      );
      const closing = DrivableWebSocket.instances.at(-1)!;
      const sentBefore = closing.sent.length;
      holdNextTransact = true;
      const outcomes = Promise.allSettled([
        session.transact(commitAt(1, "of:closing")),
      ]);
      await closing.whenSent(sentBefore + 1);
      closing.readyState = DrivableWebSocket.CLOSING;
      write.reject(new Error("WebSocket is not open: readyState 2 (CLOSING)"));
      await clock.settle();
      closing.close();
      await client.restoreConnection();

      expect((await outcomes).map((outcome) => outcome.status)).toEqual([
        "fulfilled",
      ]);
      expect(DrivableWebSocket.instances.at(-1)).not.toBe(closing);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("resolves a commit whose write fails on a socket that reports nothing, ahead of the commit after it", async () => {
    // The first commit's write fails, but the socket neither closes nor errors
    // and goes on carrying frames. The transport reported the write as a lost
    // connection, so it must also start the reconnect that replays the commit,
    // and must not deliver the second commit on the old socket ahead of it.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    let failNextTransact = false;
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      serverWiredSockets(server, (frame) => {
        if (!failNextTransact || frameType(frame) !== "transact") return;
        failNextTransact = false;
        return Promise.reject(new Error("write failed"));
      }),
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-silent-write-failure",
        {},
        testSessionOpenAuthFactory,
      );
      const silent = DrivableWebSocket.instances.at(-1)!;
      failNextTransact = true;
      const settled = { first: false, second: false };
      const first = session.transact(commitAt(1, "of:first"));
      const second = session.transact(commitAt(2, "of:second"));
      first.then(() => settled.first = true, () => settled.first = true);
      second.then(() => settled.second = true, () => settled.second = true);

      await clock.settle();
      await clock.tick(120_000);
      await clock.settle();

      expect(settled).toEqual({ first: true, second: true });
      expect((await first).seq).toBe(1);
      expect((await second).seq).toBe(2);
      expect(DrivableWebSocket.instances.at(-1)).not.toBe(silent);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves a commit the server applied before its write reported failure, without applying it twice", async () => {
    // The frame reaches the server, which applies the commit, but the closing
    // socket drops the response and reports the write as failed. The replay on
    // the next connection is a duplicate the server answers from its record.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    let duplicateNextTransact = false;
    const localSeqsSeenByServer: number[] = [];
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      (address) => {
        const socket = new DrivableWebSocket(address);
        const peer = server.connect((message) => {
          if (socket.readyState === DrivableWebSocket.OPEN) {
            socket.receive(encodeMemoryBoundary(message));
          }
        });
        socket.addEventListener("close", () => peer.close());
        queueMicrotask(() => socket.openConnection());
        return {
          socket: socket as unknown as MemorySocket,
          send: async (frame) => {
            socket.send(frame);
            const text = requireTextFrame(frame);
            if (frameType(frame) !== "transact") {
              void peer.receive(text);
              return;
            }
            localSeqsSeenByServer.push(
              (decodeMemoryBoundary(text) as { commit: { localSeq: number } })
                .commit.localSeq,
            );
            if (!duplicateNextTransact) {
              void peer.receive(text);
              return;
            }
            duplicateNextTransact = false;
            socket.readyState = DrivableWebSocket.CLOSING;
            await peer.receive(text);
            throw new Error("WebSocket is not open: readyState 2 (CLOSING)");
          },
        };
      },
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-duplicate-commit",
        {},
        testSessionOpenAuthFactory,
      );
      const closing = DrivableWebSocket.instances.at(-1)!;
      duplicateNextTransact = true;
      const first = session.transact(commitAt(1, "of:duplicate"));
      first.catch(() => {});
      await clock.settle();
      closing.close();
      await client.restoreConnection();

      expect(await first).toMatchObject({ seq: 1, replayed: true });
      // Applied twice, the first commit would have taken seq 2 as well.
      expect((await session.transact(commitAt(2, "of:after"))).seq).toBe(2);
      expect(localSeqsSeenByServer).toEqual([1, 1, 2]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("rejects a commit whose own write fails on one connection after another, and lands the commit behind it", async () => {
    // The first commit's write fails on every socket, so each replay takes the
    // new connection down with it. After a bounded number of connections the
    // client rejects that commit with the write's error, and the commit behind
    // it lands.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    const writeFailure = new Error("frame refused by socket");
    let refusedWrites = 0;
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      serverWiredSockets(server, (frame) => {
        if (frameType(frame) !== "transact") return;
        const { commit } = decodeMemoryBoundary(requireTextFrame(frame)) as {
          commit: { localSeq: number };
        };
        if (commit.localSeq !== 1) return;
        refusedWrites += 1;
        return Promise.reject(writeFailure);
      }),
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-refused-write",
        {},
        testSessionOpenAuthFactory,
      );
      const settled = { first: false, second: false };
      const first = session.transact(commitAt(1, "of:refused"));
      const second = session.transact(commitAt(2, "of:behind"));
      first.then(() => settled.first = true, () => settled.first = true);
      second.then(() => settled.second = true, () => settled.second = true);

      await clock.settle();
      await clock.tick(600_000);
      await clock.settle();

      expect(settled).toEqual({ first: true, second: true });
      await expect(first).rejects.toBe(writeFailure);
      expect((await second).seq).toBe(1);
      expect(refusedWrites).toBe(5);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("keeps replaying a commit that closing sockets refuse, and lands it once a socket accepts it", async () => {
    // Each socket has started closing when the commit's write reaches it, as
    // a peer restarting over and over would leave it. A refusal from a closing
    // socket says nothing about the commit, so none counts against it, however
    // many there are in a row.

    DrivableWebSocket.instances.length = 0;
    const server = newSharedServer();
    let refusedWrites = 0;
    const transport = new TextOnlyTransport(
      new URL("wss://memory.test/api/storage/memory"),
      true,
      () => {},
      serverWiredSockets(server, (frame) => {
        if (frameType(frame) !== "transact" || refusedWrites === 6) return;
        refusedWrites += 1;
        DrivableWebSocket.instances.at(-1)!.readyState =
          DrivableWebSocket.CLOSING;
        return Promise.reject(
          new Error("WebSocket is not open: readyState 2 (CLOSING)"),
        );
      }),
    );
    const client = await MemoryClient.connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-closing-refusals",
        {},
        testSessionOpenAuthFactory,
      );
      const outcome = Promise.allSettled([
        session.transact(commitAt(1, "of:refused-while-closing")),
      ]);

      await clock.settle();
      await clock.tick(600_000);
      await clock.settle();

      const [result] = await outcome;
      expect(result.status).toBe("fulfilled");
      expect(refusedWrites).toBe(6);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
