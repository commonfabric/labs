import { assertEquals } from "@std/assert";

import type { SchemaPathSelector } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import type { CellScope } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { Result, Unit } from "../src/storage/interface.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

class PendingSessionFactory implements SessionFactory {
  create(_space: MemorySpace, _signer?: Signer): Promise<{
    client: MemoryV2Client.Client;
    session: MemoryV2Client.SpaceSession;
  }> {
    return new Promise(() => {});
  }
}

function makeServer(): MemoryV2Server.Server {
  return newSharedServer();
}

// A session whose transport delivers the handshake and commits normally but
// silently swallows every `session.watch.add`, so the watch request the pull
// issues is left in flight — its response never arrives. This mirrors the
// regression's mechanism: a transport gate holding a watched doc past dispose,
// so the storage layer is left with an open watch whose long-poll never
// settles on its own.
class WithheldWatchSessionFactory implements SessionFactory {
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }
  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.#server);
    const transport: MemoryV2Client.Transport = {
      send: (payload: string) =>
        payload.includes("session.watch.add")
          ? Promise.resolve()
          : base.send(payload),
      close: () => base.close(),
      setReceiver: (r) => base.setReceiver(r),
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

type DestroyNowProvider = {
  destroy(): Promise<void>;
  destroyNow(): Promise<void>;
  replica: {
    synced(): Promise<void>;
    close(): Promise<void>;
    closeNow(): void;
  };
  sync(
    uri: URI,
    selector?: SchemaPathSelector,
    scope?: CellScope,
  ): Promise<Result<Unit, Error>>;
};

function hasDestroyNowProvider(
  provider: unknown,
): provider is DestroyNowProvider {
  return isObjectOrArray(provider) &&
    "destroy" in provider && typeof provider.destroy === "function" &&
    "destroyNow" in provider && typeof provider.destroyNow === "function" &&
    "replica" in provider && isObjectOrArray(provider.replica) &&
    "sync" in provider && typeof provider.sync === "function";
}

Deno.test("StorageManager.closeNow does not wait for a pending session sync", async () => {
  const signer = await Identity.fromPassphrase("storage-close-pending-sync");
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("http://localhost:65535"),
  }, new PendingSessionFactory());

  const provider = storage.open(signer.did());
  provider.sync("of:pending-session-sync" as URI);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    storage.closeNow().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 50);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "closed");
});

Deno.test("Provider.destroyNow force-closes after destroy is already pending", async () => {
  const signer = await Identity.fromPassphrase("storage-provider-destroy-now");
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("http://localhost:65535"),
  }, new PendingSessionFactory());

  const provider = storage.open(signer.did());
  if (!hasDestroyNowProvider(provider)) {
    throw new Error("test provider does not expose destroyNow");
  }

  let closeNowCalls = 0;
  provider.replica.synced = () => Promise.resolve();
  provider.replica.close = () => new Promise(() => {});
  provider.replica.closeNow = () => {
    closeNowCalls++;
  };

  void provider.destroy();
  await Promise.resolve();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    provider.destroyNow().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 50);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "closed");
  assertEquals(closeNowCalls, 1);
});

Deno.test("StorageManager.close drains a watch long-poll still in flight", async () => {
  const signer = await Identity.fromPassphrase("storage-close-watch-inflight");
  const storage = TestStorageManager.create(
    { as: signer, memoryHost: new URL("memory://") },
    new WithheldWatchSessionFactory(makeServer()),
  );

  const provider = storage.open(signer.did());
  // Open a watch by pulling a doc. Its `watch.add` response is withheld, so the
  // request stays in flight when we tear down — the exact state that used to
  // leave a transport promise pending past close() and trip the op sanitizer
  // with "Promise resolution is still pending...".
  void provider.sync("of:storage-close-watch-inflight" as URI);
  // Let the pull reach the transport before closing.
  await clock.settle();

  // close() must resolve without waiting on the withheld watch response: a
  // close() that blocked on the in-flight read would deadlock here. The default
  // op sanitizer additionally fails this test if close() leaves any transport
  // promise pending — the actual regression it guards.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    storage.close().then(() => "closed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 1000);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "closed");
});
