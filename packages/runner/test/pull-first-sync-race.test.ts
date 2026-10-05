/**
 * pull() must await its own first sync — the root-doc half of the
 * fresh-replica story (fresh-replica-read-asymmetry.test.ts covers the
 * link-target half).
 *
 * pull() used to KICK the cell's first sync without registering it anywhere
 * ("No await, just kicking this off"), then wait only on scheduler idle plus
 * the cross-space load pool. The root doc's own round-trip was in neither, so
 * pull resolved whenever the scheduler quiesced — which over a low-latency
 * link is AFTER the doc arrives, and over a real network is BEFORE. Measured
 * in production shape: a same-id retry's receipt readback (`cf piece call
 * --invocation`, the WS-D collision path reading the winner's receipt via
 * getCellFromLink → pull) returned the original result against a local
 * toolshed and `undefined` against a remote host, every time. sync()'s own
 * doc comment names the trap: code gating on idle() alone can race the
 * deferred sync; register it with trackUntilSettled so pull() awaits it.
 *
 * The gate below makes the race deterministic instead of latency-shaped: the
 * reader's syncCell for the target doc is held until the test has SEEN the
 * reader's scheduler go idle — the exact moment the unregistered kick used to
 * lose — and only then lets the "network" answer.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pull-first-sync-race");
const space = signer.did();

const RECEIPT_CAUSE = "receipt-race-doc";
const RECEIPT_VALUE = { note: { title: "Original", revision: 1 } };

describe("pull() and the first sync of an unseen doc", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writerRt: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    // The winner's receipt, as the collision path leaves it: a plain-JSON
    // outcome in a doc this writer committed and a later reader never saw.
    const tx = writerRt.edit();
    const receipt = writerRt.getCell(space, RECEIPT_CAUSE, undefined, tx);
    receipt.set(RECEIPT_VALUE);
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("resolves the doc's value even when the sync answer arrives after idle", async () => {
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const link = writerRt
        .getCell(space, RECEIPT_CAUSE, undefined)
        .getAsNormalizedFullLink();

      // Hold the target doc's sync until the test releases it; everything
      // else passes through. The gated promise is what pull() must await.
      const gate = Promise.withResolvers<void>();
      const originalSyncCell = readerStorage.syncCell.bind(readerStorage);
      readerStorage.syncCell = (<T>(cell: Cell<T>): Promise<Cell<T>> => {
        const target = cell.getAsNormalizedFullLink();
        if (target.id === link.id) {
          return gate.promise.then(() => originalSyncCell(cell));
        }
        return originalSyncCell(cell);
      }) as typeof readerStorage.syncCell;

      // The CLI readback shape exactly: getCellFromLink → pull, no schema.
      const receipt = readerRt.getCellFromLink<typeof RECEIPT_VALUE>(link);
      const pullPromise = receipt.pull();

      // Let the reader's scheduler go fully idle. This is the moment the
      // unregistered kick used to resolve at — with the doc still in flight.
      await readerRt.scheduler.idle();

      // Only now does the "network" answer.
      gate.resolve();

      expect(await pullPromise).toEqual(RECEIPT_VALUE);
    } finally {
      await readerRt.dispose();
      await readerStorage.close();
    }
  });

  it("waits for pending commits after a durable pull's required load completes", async () => {
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    const loadEntered = Promise.withResolvers<void>();
    const loadBarrier = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const commitEntered = Promise.withResolvers<void>();
    const commitBarrier = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let committing: Promise<unknown> | undefined;
    let pulling: Promise<unknown> | undefined;
    try {
      const target = readerRt.getCell<typeof RECEIPT_VALUE>(
        space,
        RECEIPT_CAUSE,
      );
      const otherSpace = (await Identity.fromPassphrase("pull-later-commit"))
        .did();
      const other = readerRt.getCell<number>(otherSpace, "later-write");
      await other.sync();
      const targetId = target.getAsNormalizedFullLink().id;
      const sync = readerStorage.syncCell.bind(readerStorage);
      using _sync = stub(readerStorage, "syncCell", async (cell, options) => {
        if (cell.getAsNormalizedFullLink().id === targetId) {
          loadEntered.resolve();
          await releaseLoad.promise;
        }
        return sync(cell, options);
      });
      const loadsSettled = readerStorage.crossSpaceSettled.bind(readerStorage);
      using _loads = stub(readerStorage, "crossSpaceSettled", () => {
        loadBarrier.resolve();
        return loadsSettled();
      });
      const commitsSettled = readerStorage.pendingCommitsSettled.bind(
        readerStorage,
      );
      using _commits = stub(readerStorage, "pendingCommitsSettled", () => {
        commitBarrier.resolve();
        return commitsSettled();
      });
      const transact = server.transact.bind(server);
      using _transact = stub(server, "transact", async (...args) => {
        commitEntered.resolve();
        await releaseCommit.promise;
        return transact(...args);
      });
      pulling = target.pull({ awaitDurability: true });
      await loadEntered.promise;
      // The initial durability pass is over, but the required load is held.
      await loadBarrier.promise;
      const tx = readerRt.edit();
      other.withTx(tx).set(7);
      committing = tx.startCommit().settled;
      await commitEntered.promise;
      releaseLoad.resolve();
      expect(
        await Promise.race([
          pulling.then(() => "read"),
          commitBarrier.promise.then(() => "commit-barrier"),
        ]),
      ).toBe("commit-barrier");
      expect(readerStorage.hasPendingCommits()).toBe(true);
      releaseCommit.resolve();
      await expect(pulling).resolves.toEqual(RECEIPT_VALUE);
    } finally {
      releaseLoad.resolve();
      releaseCommit.resolve();
      await committing;
      await pulling;
      await readerRt.dispose();
      await readerStorage.close();
    }
  });

  it("includes a sink's in-flight first sync in pull convergence", async () => {
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const link = writerRt
        .getCell(space, RECEIPT_CAUSE, undefined)
        .getAsNormalizedFullLink();
      const gate = Promise.withResolvers<void>();
      const originalSyncCell = readerStorage.syncCell.bind(readerStorage);
      readerStorage.syncCell = (<T>(cell: Cell<T>): Promise<Cell<T>> => {
        const target = cell.getAsNormalizedFullLink();
        if (target.id === link.id) {
          return gate.promise.then(() => originalSyncCell(cell));
        }
        return originalSyncCell(cell);
      }) as typeof readerStorage.syncCell;

      const receipt = readerRt.getCellFromLink<typeof RECEIPT_VALUE>(link);
      const seen: Array<typeof RECEIPT_VALUE | undefined> = [];
      const cancel = receipt.sink((value) => {
        seen.push(value);
      });
      const pullPromise = receipt.pull();
      let pullResolved = false;
      void pullPromise.then(() => {
        pullResolved = true;
      });

      await readerRt.scheduler.idle();
      await Promise.resolve();
      expect(pullResolved).toBe(false);

      gate.resolve();
      expect(await pullPromise).toEqual(RECEIPT_VALUE);
      expect(seen).toEqual([undefined, RECEIPT_VALUE]);
      cancel();
    } finally {
      await readerRt.dispose();
      await readerStorage.close();
    }
  });

  it("resolves from the replica when the first sync fails outright", async () => {
    // The swallow arm: a failed first sync must degrade to what the replica
    // holds (here: nothing), never reject or hang the pull. Same stance as
    // link-resolution's kicks — the read still resolves.
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const link = writerRt
        .getCell(space, RECEIPT_CAUSE, undefined)
        .getAsNormalizedFullLink();

      const originalSyncCell = readerStorage.syncCell.bind(readerStorage);
      readerStorage.syncCell = (<T>(cell: Cell<T>): Promise<Cell<T>> => {
        const target = cell.getAsNormalizedFullLink();
        if (target.id === link.id) {
          return Promise.reject(new Error("network unreachable"));
        }
        return originalSyncCell(cell);
      }) as typeof readerStorage.syncCell;

      const receipt = readerRt.getCellFromLink<typeof RECEIPT_VALUE>(link);
      expect(await receipt.pull()).toBeUndefined();
    } finally {
      await readerRt.dispose();
      await readerStorage.close();
    }
  });

  it("still resolves promptly when the doc is already in the replica (control)", async () => {
    // The writer's own replica: pull() must not begin waiting on network
    // confirmation it already has.
    const receipt = writerRt.getCell<typeof RECEIPT_VALUE>(
      space,
      RECEIPT_CAUSE,
      undefined,
    );
    expect(await receipt.pull()).toEqual(RECEIPT_VALUE);
  });
});
