import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import type { IStorageProvider } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase("storage-v2 crossing load cov");
const space = signer.did();
const farSpace =
  (await Identity.fromPassphrase("storage-v2 crossing load cov far")).did();

const topSchema = {
  type: "object",
  properties: {
    next: { type: "object", properties: { name: { type: "string" } } },
  },
} as const;

describe("storage/v2", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    // Only a serving manager follows crossings.
    readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
      servingHomeSpace: space,
    });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
  });

  afterEach(async () => {
    await writer.dispose();
    await reader.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  it("logs a crossing load whose sync throws, and settles the load with its target absent", async () => {
    using logs = captureLogs("storage.v2");
    const leafTx = writer.edit();
    const leaf = writer.getCell<{ name?: string }>(
      farSpace,
      "crossing load leaf",
      undefined,
      leafTx,
    );
    leaf.withTx(leafTx).set({ name: "Ada" });
    expect((await leafTx.commit().settled).error).toBeUndefined();
    const topTx = writer.edit();
    const top = writer.getCell<{ next?: unknown; rev?: number }>(
      space,
      "crossing load top",
      undefined,
      topTx,
    );
    top.withTx(topTx).set({ next: leaf, rev: 1 });
    expect((await topTx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();

    const leafLink = leaf.getAsNormalizedFullLink();
    const leafKey = entityKey(leafLink, readerStorage.scopeKeyIdentity());
    const provider = readerStorage.open(farSpace);
    const realSync = provider.sync.bind(provider);
    let leafSyncs = 0;
    provider.sync = (...args: Parameters<IStorageProvider["sync"]>) => {
      if (args[0] !== leafLink.id) return realSync(...args);
      leafSyncs++;
      return Promise.reject(new Error("the crossing load threw"));
    };

    const readerTop = reader.getCellFromLink<{ next?: { name?: string } }>({
      ...top.getAsNormalizedFullLink(),
      schema: topSchema,
    });
    await readerTop.sync();
    await readerStorage.loadsSettled([leafKey]);
    expect(leafSyncs).toBe(1);
    expect(readerStorage.pendingCrossingLoadAddresses?.()).toEqual([]);
    expect(logs.messagesOf("sync-load-failure")).toEqual([[
      `sync completed without data for ${leafLink.id} in ${farSpace}: ` +
      "Error: the crossing load threw",
    ]]);
    expect(
      readerStorage.open(farSpace).replica.getDocument?.(leafLink.id),
    ).toBeUndefined();
    expect(readerTop.get()).toEqual({ next: undefined });
  });
});
