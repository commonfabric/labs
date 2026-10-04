import { assert, assertEquals } from "@std/assert";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { SessionFactory } from "../src/storage/v2.ts";
import {
  newSharedServer,
  TEST_SESSION_OPEN_AUDIENCE,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

function makeServer(): MemoryV2Server.Server {
  return newSharedServer();
}

/**
 * A session whose handshake and session.open succeed against a real server, but
 * whose `session.watch.add` — the request a pull issues — is answered directly
 * with an `AuthorizationError` response instead of being forwarded. This is the
 * denial the storage layer must surface from `synced()`: the watch (and thus the
 * pull, and thus the sync) fails authorization.
 */
class DenyingWatchSessionFactory implements SessionFactory {
  readonly #server: MemoryV2Server.Server;
  readonly #retriable: boolean;

  constructor(
    server: MemoryV2Server.Server,
    retriable: boolean,
  ) {
    this.#server = server;
    this.#retriable = retriable;
  }

  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.#server);
    let receive: (payload: string) => void = () => {};
    const transport: MemoryV2Client.Transport = {
      send: (payload: string) => {
        const message = decodeMemoryBoundary(payload) as {
          type?: string;
          requestId?: string;
        };
        if (message.type === "session.watch.add") {
          receive(encodeMemoryBoundary({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "AuthorizationError",
              message: "Principal lacks READ on space",
              ...(this.#retriable ? { retriable: true } : {}),
            },
          }));
          return Promise.resolve();
        }
        return base.send(payload);
      },
      close: () => base.close(),
      setReceiver: (r) => {
        receive = r;
        base.setReceiver(r);
      },
      setCloseReceiver: (r) => base.setCloseReceiver?.(r),
    };
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

Deno.test(
  "authorizationError() surfaces a permanent watch denial for the space",
  async () => {
    const signer = await Identity.fromPassphrase("storage-synced-authz-perm");
    const storage = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      new DenyingWatchSessionFactory(makeServer(), false),
    );

    try {
      const provider = storage.open(signer.did());
      void provider.sync("of:storage-synced-authz-perm" as URI);

      // synced() stays quiet — a denied read is a silent absent read at the sync
      // barrier — but the per-space status carries the real, throwable error.
      await storage.synced();
      const error = storage.authorizationError(signer.did());
      assert(error !== undefined);
      assertEquals(error.name, "AuthorizationError");
      assert(error.message.includes("lacks READ"));
    } finally {
      await storage.close();
    }
  },
);

Deno.test(
  "authorizationError() stays undefined on a retriable authorization race",
  async () => {
    const signer = await Identity.fromPassphrase("storage-synced-authz-retry");
    const storage = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      new DenyingWatchSessionFactory(makeServer(), true),
    );

    try {
      const provider = storage.open(signer.did());
      void provider.sync("of:storage-synced-authz-retry" as URI);

      // A retriable auth race (an anti-replay handshake failure a fresh
      // reconnect heals) is not a permanent denial, so nothing is surfaced.
      await storage.synced();
      assertEquals(storage.authorizationError(signer.did()), undefined);
    } finally {
      await storage.close();
    }
  },
);

const EMPTY_SYNC = {
  type: "sync" as const,
  fromSeq: 0,
  toSeq: 0,
  upserts: [],
  removes: [],
};

const helloOk = (): FabricValue => ({
  type: "hello.ok",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
  sessionOpen: {
    audience: TEST_SESSION_OPEN_AUDIENCE,
    challenge: { value: "challenge:reconnect-terminal", expiresAt: 1_000_000 },
  },
});

const openOk = (requestId: string): FabricValue => ({
  type: "response",
  requestId,
  ok: {
    sessionId: "session-A",
    sessionToken: "token:session-A",
    serverSeq: 0,
    sessionOpen: {
      audience: TEST_SESSION_OPEN_AUDIENCE,
      challenge: {
        value: `challenge:reconnect-terminal:${requestId}`,
        expiresAt: 1_000_000,
      },
    },
  },
});

/**
 * A scripted transport whose first `session.open` succeeds but whose reopen (the
 * second `session.open`, driven by a reconnect) is permanently denied. It lets
 * the test fire the transport's close receiver to start the reconnect.
 */
class ReopenDenyTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #openCount = 0;

  triggerClose(): void {
    this.#closeReceiver(new Error("disconnect"));
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };
    switch (message.type) {
      case "hello":
        this.#respond(helloOk());
        return Promise.resolve();
      case "session.open":
        this.#openCount += 1;
        this.#respond(
          this.#openCount === 1 ? openOk(message.requestId!) : {
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "AuthorizationError",
              message: "Principal lacks READ on space",
            },
          },
        );
        return Promise.resolve();
      case "session.watch.add":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0, sync: EMPTY_SYNC },
        });
        return Promise.resolve();
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0 },
        });
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class ReconnectDenyingSessionFactory implements SessionFactory {
  readonly transport = new ReopenDenyTransport();
  client?: MemoryV2Client.Client;

  async create(id: string, signer?: Signer) {
    const client = await MemoryV2Client.connect({ transport: this.transport });
    this.client = client;
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

Deno.test(
  "authorizationError() surfaces a permanent denial that terminated the session on reconnect",
  async () => {
    const signer = await Identity.fromPassphrase(
      "storage-synced-authz-reconnect",
    );
    const factory = new ReconnectDenyingSessionFactory();
    const storage = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      factory,
    );

    try {
      const provider = storage.open(signer.did());
      // Establish the session and a watch while authorized.
      await provider.sync("of:storage-synced-authz-reconnect" as URI);
      assertEquals(storage.authorizationError(signer.did()), undefined);

      // Drop the connection and drive the reconnect to completion: the reopen is
      // permanently denied, so the client terminates the session. No further
      // pull runs, so the watch-refresh path never records the denial — the gap
      // this test pins.
      factory.transport.triggerClose();
      await factory.client!.restoreConnection();

      await storage.synced();
      const error = storage.authorizationError(signer.did());
      assert(error !== undefined);
      assertEquals(error.name, "AuthorizationError");
      assert(error.message.includes("lacks READ"));
    } finally {
      await storage.close();
    }
  },
);
