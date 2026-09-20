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
  storageAddressForHost,
  toSpaceWebSocketAddress,
  toWebSocketAddress,
  WebSocketTransport,
} from "../src/storage/v2-remote-session.ts";
import {
  createNativeMemorySocket,
  type MemorySocketFactory,
} from "../src/storage/memory-socket.ts";
import { SpaceHostValidationError } from "../src/space-host.ts";
import { StorageManager } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_HELLO_SESSION_OPEN } from "./memory-v2-test-utils.ts";

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

  /** Answers the client's `hello`, which is the whole of connecting. */
  const answerHello = (socket: DrivableWebSocket): void => {
    socket.receive(encodeMemoryBoundary({
      type: "hello.ok",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
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

      const send = transport.send("frame");
      socket().readyState = DrivableWebSocket.CLOSED;
      socket().dispatchEvent(new Event("close"));

      await expect(send).rejects.toThrow(
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

  it("propagates an asynchronous write failure without poisoning the send queue", async () => {
    const write = Promise.withResolvers<void>();
    await withTransport(async (transport, socket) => {
      const first = transport.send("first");
      const failure = expect(first).rejects.toThrow("TLS write failed");
      const second = transport.send("second");
      const activeSocket = socket();
      activeSocket.openConnection();
      await activeSocket.whenSent(1);
      write.reject(new Error("TLS write failed"));
      await failure;
      await second;
      expect(activeSocket.sent).toEqual(["first", "second"]);
      await transport.close();
    }, (frame) => frame === "first" ? write.promise : Promise.resolve());
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

      const control = transport.requestMessageCompression(false);
      activeSocket.fail(new Error("replace socket before control send"));

      await expect(control).rejects.toThrow(
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
        flags: getMemoryProtocolFlags(),
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
          flags: getMemoryProtocolFlags(),
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
          flags: getMemoryProtocolFlags(),
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
      const send = transport.send("frame");
      socket().dispatchEvent(new ErrorEvent("error", { error: boom }));

      await expect(send).rejects.toBeDefined();
      expect(closeError).toBe(boom);
    });
  });

  it("reports a generic transport error when the error event carries no Error", async () => {
    await withTransport(async (transport, socket) => {
      let closeError: Error | undefined;
      transport.setCloseReceiver((error) => {
        closeError = error;
      });

      const send = transport.send("frame");
      socket().dispatchEvent(new Event("error"));

      await expect(send).rejects.toBeDefined();
      expect(closeError).toBeInstanceOf(Error);
      expect(closeError?.message).toContain("memory websocket transport error");
    });
  });
});
