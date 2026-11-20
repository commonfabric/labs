import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  mountOver,
  newSharedServer,
  ResponseHolder,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase("storage-v2 release pending");
const space: MemorySpace = signer.did();

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;

describe("storage/v2", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let commits: ResponseHolder;
  let readerStorage: TestStorageManager;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    commits = new ResponseHolder("transact");
    readerStorage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, {
      create: (space, signer, mountOptions) =>
        mountOver(
          commits.wrap(MemoryV2Client.loopback(server)),
          space,
          signer,
          mountOptions,
        ),
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
  });

  afterEach(async () => {
    await reader.dispose();
    await writer.dispose();
    await readerStorage.close();
    await writerStorage.close();
    await server.close();
  });

  describe("a document with a local write pending that the space refuses to watch again after its release", () => {
    // A document a local write holds during its release is watched again on
    // its own. When that watch fails, the document keeps its confirmed value
    // and is owed a watch, unless the space refused the watch outright: then
    // the release's removal empties it as if nothing held it. Either way the
    // pending write keeps its record: it is not reported dropped, and the
    // write still commits. The same refusal for a document nothing but a
    // read holds drops it (`document-release.test.ts`).

    /**
     * Refuses the watch again with `error`, and returns the seq the
     * document's confirmed base stands at once the refusal is logged.
     */
    const refuseWatchAgain = async (
      error: { name: string; message: string; retriable?: boolean },
    ): Promise<number> => {
      const tx = writer.edit();
      writer.getCell(space, "counter", counterSchema, tx).set({ n: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      await writerStorage.synced();
      const id = reader.getCell(space, "counter", counterSchema)
        .getAsNormalizedFullLink().id;
      const provider = readerStorage.open(space);
      expect((await provider.sync(id, { path: [], schema: false })).error)
        .toBeUndefined();
      expect(provider.replica.confirmedDocumentSeq(id)).toBeGreaterThan(0);
      await readerStorage.releaseUnreadDocuments();

      const removal = Promise.withResolvers<void>();
      const removalAsked = Promise.withResolvers<void>();
      const watchRemove = server.watchRemove.bind(server);
      server.watchRemove = async (message) => {
        removalAsked.resolve();
        await removal.promise;
        return await watchRemove(message);
      };
      const released = readerStorage.releaseUnreadDocuments();
      await removalAsked.promise;

      commits.holding = true;
      const write = reader.edit();
      reader.getCell(space, "counter", counterSchema, write).set({ n: 2 });
      const receipt = write.commit();
      await commits.firstSent;

      using logs = captureLogs("storage.v2");
      const dropped: URI[] = [];
      const unsubscribe = readerStorage.subscribeDocumentsDropped(
        (_space, addresses) => {
          for (const address of addresses) dropped.push(address.id);
        },
      );
      const watchAdd = server.watchAdd.bind(server);
      server.watchAdd = (message) => {
        server.watchAdd = watchAdd;
        return Promise.resolve({
          type: "response",
          requestId: message.requestId,
          error,
        });
      };
      removal.resolve();
      await released;
      await logs.first("watch-again-failed");
      const confirmedSeq = provider.replica.confirmedDocumentSeq(id);

      expect(provider.replica.hasPendingWrite(id)).toBe(true);
      expect(dropped).toEqual([]);
      unsubscribe();
      commits.release();
      expect((await receipt.settled).error).toBeUndefined();
      expect(await server.readDocument(space, id)).toEqual({ value: { n: 2 } });
      return confirmedSeq;
    };

    it("empties the confirmed base when the space refuses the watch outright", async () => {
      expect(
        await refuseWatchAgain({
          name: "AuthorizationError",
          message: "watch refused",
        }),
      ).toBe(0);
    });

    it("keeps the confirmed base when the space refuses the watch for now", async () => {
      expect(
        await refuseWatchAgain({
          name: "AuthorizationError",
          message: "watch refused for now",
          retriable: true,
        }),
      ).toBeGreaterThan(0);
    });
  });
});
