import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { makeFrame, runInFrame } from "../src/builder/pattern.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler.ts";
import type { ServedEventFailureOutcome } from "../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler event loading read");
const space = signer.did();
const foreignSpace = (await Identity.fromPassphrase(
  "scheduler event loading read, foreign",
)).did();

const offersSchema = {
  type: "array",
  items: { type: "string" },
  default: [],
} as const satisfies JSONSchema;

describe("scheduler-event-loading-read", () => {
  // The handler follows a holder's link to an inbox piece, as FabriChat's
  // room reaches a member's inbox, and reads the piece's `offers`, which is a
  // link to a store document of their own. The store is in no dependency the
  // event's preflight walks. The writer runtime stores every document; the
  // reader runtime, which runs the handler, holds the holder and the piece
  // but not the store, whose load the test keeps in flight. The schema's
  // `default` is what a read of the store returns until that load lands.

  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;
  let releaseHeldSync: (() => void) | undefined;

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
    releaseHeldSync = undefined;
  });

  afterEach(async () => {
    releaseHeldSync?.();
    await reader.dispose({ closeStorage: false });
    await writer.dispose({ closeStorage: false });
    await readerStorage.close();
    await writerStorage.close();
    await server.close();
  });

  /**
   * Holds every load of the document `id` the reader starts until the
   * returned function is called; every other load passes through.
   */
  function holdReaderSyncFor(id: string): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
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
              if (syncId === id) await promise;
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
    releaseHeldSync = resolve;
    return resolve;
  }

  /**
   * Stores, through the writer, a holder in the reader's space linking to an
   * inbox piece, the piece, whose `offers` links to a store document, and the
   * store holding `offers` unless that is `undefined`; the piece and the store
   * are in `inboxSpace`. Without `hop` there is no piece, and the holder links
   * to the store, which holds `{ offers }`. Returns the reader's cells for the
   * holder, the store, the log the handler appends to, and the event stream.
   * The reader has loaded the holder and the piece, and not the store.
   */
  async function standUp(
    name: string,
    offers: string[] | undefined,
    { inboxSpace = foreignSpace, hop = true }: {
      inboxSpace?: MemorySpace;
      hop?: boolean;
    } = {},
  ): Promise<{
    holder: Cell<{ inbox: unknown }>;
    store: Cell<unknown>;
    log: Cell<string[]>;
    eventCell: Cell<number>;
  }> {
    const commit = async (write: (tx: IExtendedStorageTransaction) => void) => {
      const tx = writer.edit();
      write(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    };
    const store = writer.getCell<unknown>(inboxSpace, `${name}-store`);
    const piece = writer.getCell<unknown>(inboxSpace, `${name}-piece`);
    if (offers !== undefined) {
      await commit((tx) => store.withTx(tx).set(hop ? offers : { offers }));
    }
    if (hop) {
      await commit((tx) =>
        piece.withTx(tx).set({ offers: store.getAsLink({ base: piece }) })
      );
    }
    await commit((tx) =>
      writer.getCell<unknown>(space, `${name}-holder`).withTx(tx).set({
        inbox: (hop ? piece : store).getAsLink(),
      })
    );
    await writerStorage.synced();

    const holder = reader.getCell<{ inbox: unknown }>(space, `${name}-holder`);
    await holder.sync();
    if (hop) await reader.getCell(inboxSpace, `${name}-piece`).sync();
    return {
      holder,
      store: reader.getCell(inboxSpace, `${name}-store`),
      log: reader.getCell<string[]>(space, `${name}-log`),
      eventCell: reader.getCell<number>(space, `${name}-events`),
    };
  }

  /**
   * Registers, on the reader, a handler that appends the offers of the inbox
   * `holder` links to onto `log`. It runs in a handler's frame, as a
   * pattern's handler does, and resolves the link while it runs. Returns the
   * offers each run read, and a promise of the first run.
   */
  function addAppendingHandler(
    holder: Cell<{ inbox: unknown }>,
    log: Cell<string[]>,
    eventCell: Cell<number>,
  ): { reads: string[][]; firstRun: Promise<void> } {
    const reads: string[][] = [];
    const firstRun = Promise.withResolvers<void>();
    const handler: EventHandler = (tx: IExtendedStorageTransaction) => {
      const frame = makeFrame({ frameKind: "handler", runtime: reader, tx });
      runInFrame(frame, () => {
        const offers = holder.withTx(tx).key("inbox").resolveAsCell()
          .key("offers").asSchema(offersSchema).get() as string[];
        reads.push([...offers]);
        log.withTx(tx).set([
          ...(log.withTx(tx).get() ?? []),
          offers.join(","),
        ]);
      });
      firstRun.resolve();
    };
    reader.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        holder.withTx(depTx).get();
      },
    );
    return { reads, firstRun: firstRun.promise };
  }

  /**
   * Queues `eventCell`'s event on the reader, served when `outcomes` is
   * given, which then collects the failure outcomes the event reports.
   * Resolves with the status of the transaction the event first settles on.
   */
  function send(
    eventCell: Cell<number>,
    outcomes?: ServedEventFailureOutcome[],
  ): Promise<string> {
    const settled = Promise.withResolvers<string>();
    const onCommit = (tx: IExtendedStorageTransaction) =>
      settled.resolve(tx.status().status);
    if (outcomes === undefined) {
      reader.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        onCommit,
      );
    } else {
      reader.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        false,
        onCommit,
        false,
        {
          served: {
            streamEntry: {
              sidecarId: "of:stream-events:loading-read",
              index: 0,
              seq: 1,
            },
            onFailure: (outcome) => outcomes.push(outcome),
          },
        },
      );
    }
    return settled.promise;
  }

  describe("a client dispatch", () => {
    it("runs the handler again once the load it read through the piece lands, and commits only the stored value", async () => {
      const { holder, log, eventCell, store } = await standUp("client", [
        "a",
        "b",
        "c",
      ]);
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
    });

    it("runs the handler again once the load of the document it resolved a cell to lands", async () => {
      // `resolveAsCell()` itself withdraws a run whose resolution stops at a
      // document still loading, so this shape never depended on what the run
      // read afterwards.

      const { holder, log, eventCell, store } = await standUp(
        "client-resolved",
        ["a", "b", "c"],
        { hop: false },
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
    });

    it("commits the schema default once the load it read finds no document", async () => {
      const { holder, log, eventCell, store } = await standUp(
        "client-absent",
        undefined,
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], []]);
      expect(log.get()).toEqual([""]);
    });

    it("commits only the stored value of a document it read while loading in a space it wrote", async () => {
      // The commit carries the run's reads in the space it wrote, and the
      // store refuses the one of a document it has a later value of.

      const { holder, log, eventCell, store } = await standUp(
        "client-same-space",
        ["a", "b", "c"],
        { inboxSpace: space },
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
    });
  });

  describe("a served dispatch", () => {
    it("withdraws the run that read a loading document through the piece, and runs it again once, after the load lands", async () => {
      const { holder, log, eventCell, store } = await standUp("served", [
        "a",
        "b",
        "c",
      ]);
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const outcomes: ServedEventFailureOutcome[] = [];
      const status = send(eventCell, outcomes);
      await firstRun;
      expect(await status).not.toBe("done");
      expect(reads).toEqual([[]]);
      expect(log.get()).toBeUndefined();
      release();

      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
      expect(outcomes).toEqual([]);
    });

    it("does not withdraw the run for a loading read in its home space", async () => {
      // A served run's own handling receipt is a document of its home space
      // that nothing has written, read while its load is in flight. The wave
      // holds a served run to its home-space reads, so such a read is no
      // reason to withdraw it.

      const { holder, log, eventCell, store } = await standUp(
        "served-home-space",
        undefined,
        { inboxSpace: space },
      );
      const { reads } = addAppendingHandler(holder, log, eventCell);
      holdReaderSyncFor(store.getAsNormalizedFullLink().id);

      const outcomes: ServedEventFailureOutcome[] = [];
      expect(await send(eventCell, outcomes)).toBe("done");
      expect(reads).toEqual([[]]);
      expect(log.get()).toEqual([""]);
      expect(outcomes).toEqual([]);
    });
  });
});
