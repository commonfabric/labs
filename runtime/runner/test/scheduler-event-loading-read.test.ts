import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

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
  // A handler reaches a document through a link it resolves while it runs, so
  // the document is in no dependency the event's preflight walks. The writer
  // runtime stores the document; the reader runtime, which runs the handler,
  // holds the holder document but not the one it links to, whose load the
  // test keeps in flight. The schema's `default` is what a read of the
  // document returns until the load lands.

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
   * Stores, through the writer, a holder linking to an inbox in `inboxSpace`,
   * and the inbox itself unless `offers` is `undefined`. Returns the reader's
   * cells for the holder, the inbox, the log the handler appends to, and the
   * event stream. The reader has loaded the holder and not the inbox.
   */
  async function standUp(
    name: string,
    offers: string[] | undefined,
    inboxSpace: MemorySpace = foreignSpace,
  ): Promise<{
    holder: Cell<{ inbox: unknown }>;
    inbox: Cell<{ offers: string[] }>;
    log: Cell<string[]>;
    eventCell: Cell<number>;
  }> {
    const inboxTx = writer.edit();
    const stored = writer.getCell<{ offers: string[] }>(
      inboxSpace,
      `${name}-inbox`,
      undefined,
      inboxTx,
    );
    if (offers !== undefined) stored.set({ offers });
    expect((await inboxTx.commit().settled).error).toBeUndefined();
    const holderTx = writer.edit();
    writer.getCell<{ inbox: unknown }>(
      space,
      `${name}-holder`,
      undefined,
      holderTx,
    ).set({ inbox: stored.getAsLink() });
    expect((await holderTx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();

    const holder = reader.getCell<{ inbox: unknown }>(
      space,
      `${name}-holder`,
      undefined,
    );
    await holder.sync();
    return {
      holder,
      inbox: reader.getCell(inboxSpace, `${name}-inbox`, undefined),
      log: reader.getCell<string[]>(space, `${name}-log`, undefined),
      eventCell: reader.getCell<number>(space, `${name}-events`, undefined),
    };
  }

  /**
   * Registers, on the reader, a handler that appends the offers of the inbox
   * `holder` links to onto `log`, resolving that link while it runs. Returns
   * the offers each run read, and a promise of the first run.
   */
  function addAppendingHandler(
    holder: Cell<{ inbox: unknown }>,
    log: Cell<string[]>,
    eventCell: Cell<number>,
  ): { reads: string[][]; firstRun: Promise<void> } {
    const reads: string[][] = [];
    const firstRun = Promise.withResolvers<void>();
    const handler: EventHandler = (tx: IExtendedStorageTransaction) => {
      const offers = holder.withTx(tx).key("inbox").resolveAsCell()
        .key("offers").asSchema(offersSchema).get() as string[];
      reads.push([...offers]);
      log.withTx(tx).set([...(log.withTx(tx).get() ?? []), offers.join(",")]);
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
   * Resolves with the status of the transaction the event settles on.
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
    it("runs the handler again once the load it read lands, and commits only the stored value", async () => {
      const { holder, log, eventCell, inbox } = await standUp(
        "client",
        ["a", "b", "c"],
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(inbox.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
    });

    it("commits the schema default once the load it read finds no document", async () => {
      const { holder, log, eventCell, inbox } = await standUp(
        "client-absent",
        undefined,
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(inbox.getAsNormalizedFullLink().id);

      const status = send(eventCell);
      await firstRun;
      release();

      expect(await status).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], []]);
      expect(log.get()).toEqual([""]);
    });

    it("commits only the stored value of a document in its own space that it read while loading", async () => {
      const { holder, log, eventCell, inbox } = await standUp(
        "client-same-space",
        ["a", "b", "c"],
        space,
      );
      const { reads, firstRun } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(inbox.getAsNormalizedFullLink().id);

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
    it("withdraws the run that read a loading document, and a re-delivery once the load lands commits only the stored value", async () => {
      const { holder, log, eventCell, inbox } = await standUp(
        "served",
        ["a", "b", "c"],
      );
      const { reads } = addAppendingHandler(holder, log, eventCell);
      const release = holdReaderSyncFor(inbox.getAsNormalizedFullLink().id);

      const outcomes: ServedEventFailureOutcome[] = [];
      expect(await send(eventCell, outcomes)).not.toBe("done");
      expect(reads).toEqual([[]]);
      expect(outcomes).toEqual([{
        kind: "deferred",
        cause: "handler-not-run",
        message:
          `the run read \`${inbox.getAsNormalizedFullLink().id}\` while its document was still loading`,
      }]);
      await reader.idle();
      expect(log.get()).toBeUndefined();

      // The drain re-delivers a withdrawn entry; here the test does.
      release();
      await inbox.sync();
      expect(await send(eventCell, outcomes)).toBe("done");
      await reader.idle();
      expect(reads).toEqual([[], ["a", "b", "c"]]);
      expect(log.get()).toEqual(["a,b,c"]);
      expect(outcomes).toHaveLength(1);
    });
  });
});
