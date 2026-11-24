/// <reference path="./clock.d.ts" />
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler event load park cov");
const space = signer.did();
const storeSpace = (await Identity.fromPassphrase(
  "scheduler event load park cov, store",
)).did();

/** A read of no document returns `undefined` under this schema. */
const offersSchema = {
  type: "array",
  items: { type: "string" },
} as const satisfies JSONSchema;

describe("scheduler event load park", () => {
  // The handler follows a holder's link to a store document in another space
  // and reads the store's offers. The reader runtime, which runs the handler,
  // holds the holder but not the store, whose load the test fails once the
  // handler has run: a load failing otherwise than by authorization ends the
  // event the run was withdrawn for.

  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;
  let releases: (() => void)[];

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    releases = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    await reader.dispose({ closeStorage: false });
    await writer.dispose({ closeStorage: false });
    await readerStorage.close();
    await writerStorage.close();
    await server.close();
  });

  /**
   * Makes the reader's loads of the document `id` fail with a transport
   * error once the returned function is called.
   */
  function failReaderSyncFor(id: string): () => void {
    const gate = Promise.withResolvers<void>();
    const manager = readerStorage as unknown as {
      open: (space: string) => {
        sync: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const originalOpen = manager.open.bind(manager);
    manager.open = (openSpace: string) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async (syncId: unknown, ...rest: unknown[]) => {
              if (syncId === id) {
                await gate.promise;
                return {
                  error: { name: "TransportError", message: "load lost" },
                };
              }
              return (target.sync as (...a: unknown[]) => Promise<unknown>)(
                syncId,
                ...rest,
              );
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    releases.push(gate.resolve);
    return gate.resolve;
  }

  /**
   * Stores, through the writer, a store holding offers in `storeSpace` and a
   * holder in the reader's space linking to it, and loads the holder on the
   * reader. Returns the reader's cells for the holder, the store, and the
   * event stream.
   */
  async function standUp(name: string): Promise<{
    holder: Cell<{ inbox: unknown }>;
    store: Cell<unknown>;
    eventCell: Cell<number>;
  }> {
    const commit = async (write: (tx: IExtendedStorageTransaction) => void) => {
      const tx = writer.edit();
      write(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    };
    const store = writer.getCell<unknown>(storeSpace, `${name}-store`);
    await commit((tx) => store.withTx(tx).set({ offers: ["a", "b"] }));
    await commit((tx) =>
      writer.getCell<unknown>(space, `${name}-holder`).withTx(tx).set({
        inbox: store.getAsLink(),
      })
    );
    await writerStorage.synced();

    const holder = reader.getCell<{ inbox: unknown }>(space, `${name}-holder`);
    await holder.sync();
    return {
      holder,
      store: reader.getCell(storeSpace, `${name}-store`),
      eventCell: reader.getCell<number>(space, `${name}-events`),
    };
  }

  /**
   * Registers, on the reader, a handler that reads the offers of the store
   * `holder` links to, and throws `thrown()` when they read as `undefined`.
   * Returns how many runs there were, and a promise of the first run.
   */
  function addThrowingHandler(
    holder: Cell<{ inbox: unknown }>,
    eventCell: Cell<number>,
    thrown: () => unknown,
  ): { runs: { count: number }; firstRun: Promise<void> } {
    const runs = { count: 0 };
    const firstRun = Promise.withResolvers<void>();
    reader.scheduler.addEventHandler(
      (tx: IExtendedStorageTransaction) => {
        runs.count++;
        firstRun.resolve();
        const offers = holder.withTx(tx).key("inbox").resolveAsCell()
          .key("offers").asSchema(offersSchema).get();
        if (offers === undefined) throw thrown();
      },
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        holder.withTx(depTx).get();
      },
    );
    return { runs, firstRun: firstRun.promise };
  }

  /** Queues `eventCell`'s event, resolving with the status it settles on. */
  function send(eventCell: Cell<number>): Promise<string> {
    const settled = Promise.withResolvers<string>();
    reader.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );
    return settled.promise;
  }

  describe("a withdrawn run whose load fails", () => {
    it("reports a value the run threw that is not an `Error` as an `Error` carrying it", async () => {
      const { holder, eventCell, store } = await standUp("thrown-string");
      const errors: Error[] = [];
      reader.scheduler.onError((error) => errors.push(error));
      const { runs, firstRun } = addThrowingHandler(
        holder,
        eventCell,
        () => "offers unreadable",
      );
      const fail = failReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      fail();

      expect(await status).not.toBe("done");
      await reader.idle();
      expect(runs.count).toBe(1);
      expect(errors.map((error) => [error.name, error.message])).toEqual([
        ["Error", "offers unreadable"],
      ]);
    });

    it("reports an `Error` the run threw as itself", async () => {
      const { holder, eventCell, store } = await standUp("thrown-error");
      const errors: Error[] = [];
      reader.scheduler.onError((error) => errors.push(error));
      const { runs, firstRun } = addThrowingHandler(
        holder,
        eventCell,
        () => new RangeError("offers out of range"),
      );
      const fail = failReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      fail();

      expect(await status).not.toBe("done");
      await reader.idle();
      expect(runs.count).toBe(1);
      expect(errors.map((error) => [error.name, error.message])).toEqual([
        ["RangeError", "offers out of range"],
      ]);
    });

    it("reports nothing once the scheduler parked on the load is disposed", async () => {
      const { holder, eventCell, store } = await standUp("disposed-park");
      const errors: Error[] = [];
      reader.scheduler.onError((error) => errors.push(error));
      const { runs, firstRun } = addThrowingHandler(
        holder,
        eventCell,
        () => new RangeError("offers out of range"),
      );
      const fail = failReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      let settled = false;
      void status.then(() => (settled = true));
      await firstRun;
      reader.scheduler.dispose();
      fail();
      await clock.settle();

      expect(runs.count).toBe(1);
      expect(errors).toEqual([]);
      expect(settled).toBe(false);
    });
  });
});
