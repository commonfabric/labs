import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isRetryableCommitRejection } from "../src/storage/rejection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("commit read basis");
const space = signer.did();
const signerY = await Identity.fromPassphrase("commit read basis second space");
const spaceY = signerY.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

const SHARED = "shared-doc";

describe("commit read basis", () => {
  // Two runtimes share one server whose fan-out runs only when a test flushes
  // it, so a frame can be delivered to the reader's replica at a chosen
  // point: after a transaction there has read a document, and before that
  // transaction commits. The transaction keeps the snapshot it read while
  // the replica moves on, and the commit's confirmed reads name the seqs the
  // replica holds when the commit is built. What ties those seqs to the
  // snapshot is the transaction's commit-time claim check, which re-reads
  // every snapshotted document from the replica and rejects the transaction
  // locally when a value differs — so a read set only reaches the wire when
  // its content is the content at the seqs it names.

  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await server.flushSessions([space, spaceY]);
    await clock.settle();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  const sharedCellOf = (runtime: Runtime) =>
    runtime.getCell(space, SHARED, valueSchema);

  const sharedId = () => sharedCellOf(rtB).getAsNormalizedFullLink().id;

  const derivedOf = (runtime: Runtime, tx?: IExtendedStorageTransaction) =>
    runtime.getCell(space, "b-derived-doc", valueSchema, tx);

  // Runtime A creates the shared document and the server delivers it to
  // runtime B's replica, whose subscription the caller has set up.
  const createSharedFromA = async () => {
    const txA = rtA.edit();
    sharedCellOf(rtA).withTx(txA).set({ value: 42 });
    const created = await txA.commit({ holdSyncedUntilCovered: false }).verdict;
    expect(created.error).toBeUndefined();
    await server.flushSessions([space]);
    await clock.settle();
    await storageB.synced();
  };

  // Runtime B reads the shared document as absent inside `tx` and derives a
  // write from that, then the document lands in B's replica while `tx` stays
  // open.
  const readAbsentThenLand = async (): Promise<IExtendedStorageTransaction> => {
    const shared = sharedCellOf(rtB);
    await shared.sync();
    const tx = rtB.edit();
    expect(shared.withTx(tx).get()).toBeUndefined();
    derivedOf(rtB, tx).set({ value: 1 });
    await createSharedFromA();
    return tx;
  };

  describe("a document read as absent that another client creates before the commit", () => {
    it("is held by the replica while the open transaction still reads the absence", async () => {
      const tx = await readAbsentThenLand();
      expect(sharedCellOf(rtB).get()).toEqual({ value: 42 });
      expect(sharedCellOf(rtB).withTx(tx).get()).toBeUndefined();
      tx.abort("inspection only");
    });

    it("exports the confirmed read at the seq the replica holds when the commit is built", async () => {
      const tx = await readAbsentThenLand();
      const replica = storageB.open(space).replica as SpaceReplica;
      const exported = replica.accessForTestingOnly.buildReads(tx.tx, 1)
        .confirmed.find((read) => read.id === sharedId());
      expect(exported?.seq).toBeGreaterThan(0);
      tx.abort("inspection only");
    });

    it("rejects the commit locally as `StorageTransactionInconsistent`, which commit paths retry", async () => {
      const tx = await readAbsentThenLand();
      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error?.name).toBe("StorageTransactionInconsistent");
      expect(isRetryableCommitRejection(committed.error)).toBe(true);

      // The derived write never lands.
      await server.flushSessions([space]);
      await clock.settle();
      await storageB.synced();
      expect(derivedOf(rtB).get()).toBeUndefined();
    });
  });

  describe("a document the commit pins create-only that lands before the commit", () => {
    it("is left to the server, which refuses it as `PreconditionFailedError`", async () => {
      // The pin is the stronger claim and the server answers it terminally,
      // so the local check must not pre-empt it with a retryable rejection.
      const shared = sharedCellOf(rtB);
      await shared.sync();
      const tx = rtB.edit();
      expect(shared.withTx(tx).get()).toBeUndefined();
      const link = shared.getAsNormalizedFullLink();
      tx.tx.markCreateOnly!({
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
      shared.withTx(tx).set({ value: 5 });
      await createSharedFromA();

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error?.name).toBe("PreconditionFailedError");
      expect(isRetryableCommitRejection(committed.error)).toBe(false);
    });
  });

  describe("a document whose own pending layer is confirmed before the commit", () => {
    it("is accepted, since the transaction's view included that layer", async () => {
      // B's first commit writes the shared document; its layer is pending
      // until the server's frame promotes it.
      const shared = sharedCellOf(rtB);
      const first = rtB.edit();
      shared.withTx(first).set({ value: 7 });
      const firstCommit =
        first.commit({ holdSyncedUntilCovered: false }).verdict;

      // The second transaction reads through that pending layer.
      const tx = rtB.edit();
      expect(shared.withTx(tx).get()).toEqual({ value: 7 });
      derivedOf(rtB, tx).set({ value: 2 });

      expect((await firstCommit).error).toBeUndefined();
      await server.flushSessions([space]);
      await clock.settle();
      await storageB.synced();

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error).toBeUndefined();
    });
  });

  describe("a transaction closed as one commit per space", () => {
    // B's transaction writes `space` first and `spaceY` second, and reads a
    // document in `spaceY` as absent. Runtime A creates that document while
    // B's first space is closing, so the frame lands after the transaction
    // was admitted and before its second space's read set is built.

    const sharedYOf = (runtime: Runtime) =>
      runtime.getCell(spaceY, SHARED, valueSchema);

    // Resolves once B's replica for `spaceY` holds the document A creates.
    const landInB = async () => {
      const cell = sharedYOf(rtB);
      const landed = new Promise<void>((resolve) => {
        const cancel = cell.sink((value) => {
          if (value?.value === 42) {
            cancel();
            resolve();
          }
        });
      });
      const txA = rtA.edit();
      sharedYOf(rtA).withTx(txA).set({ value: 42 });
      const created = await txA.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(created.error).toBeUndefined();
      await server.flushSessions([spaceY]);
      await clock.settle();
      await landed;
    };

    const openTwoSpaceTx = async () => {
      const shared = sharedYOf(rtB);
      await shared.sync();
      const tx = rtB.edit();
      tx.enableMultiSpaceWrites?.([space, spaceY]);
      rtB.getCell(space, "x-doc", valueSchema, tx).set({ value: 1 });
      expect(shared.withTx(tx).get()).toBeUndefined();
      rtB.getCell(spaceY, "y-derived-doc", valueSchema, tx).set({ value: 1 });
      return tx;
    };

    it("re-checks the later space's documents before building its read set", async () => {
      const tx = await openTwoSpaceTx();
      const replica = storageB.open(space).replica;
      const commitNative = replica.commitNative!.bind(replica);
      replica.commitNative = async (native, source, options) => {
        await landInB();
        return commitNative(native, source, options);
      };

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error?.name).toBe("StorageTransactionInconsistent");

      // The first space closed before the change was found; the second
      // never does.
      await storageB.synced();
      expect(rtB.getCell(space, "x-doc", valueSchema).get())
        .toEqual({ value: 1 });
      expect(rtB.getCell(spaceY, "y-derived-doc", valueSchema).get())
        .toBeUndefined();
    });

    it("leaves a document the commit pins create-only for the server to judge", async () => {
      // The pin is the stronger claim and the server answers it terminally,
      // so the local check must not pre-empt it with a retryable rejection.
      const tx = await openTwoSpaceTx();
      const link = sharedYOf(rtB).getAsNormalizedFullLink();
      tx.tx.markCreateOnly!({
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
      sharedYOf(rtB).withTx(tx).set({ value: 9 });
      const replica = storageB.open(space).replica;
      const commitNative = replica.commitNative!.bind(replica);
      replica.commitNative = async (native, source, options) => {
        await landInB();
        return commitNative(native, source, options);
      };

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error?.name).toBe("PreconditionFailedError");
    });

    it("re-checks a later space whose only pin names no document", async () => {
      // An `origin-committed` pin claims nothing about any document, so it
      // exempts none of them from the re-check.
      const tx = await openTwoSpaceTx();
      tx.tx.addCommitPrecondition!(spaceY, {
        kind: "origin-committed",
        originLocalSeq: 1,
      });
      const replica = storageB.open(space).replica;
      const commitNative = replica.commitNative!.bind(replica);
      replica.commitNative = async (native, source, options) => {
        await landInB();
        return commitNative(native, source, options);
      };

      rtB.prepareTxForCommit(tx);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error?.name).toBe("StorageTransactionInconsistent");
    });

    it("re-checks the later space's documents before sealing it", async () => {
      const tx = await openTwoSpaceTx();
      const sealed: string[] = [];
      const result = await tx.tx.sealInto!({
        sealSpaceCommit: async (sealing) => {
          if (sealing === space) await landInB();
          sealed.push(sealing);
          return { ok: {} };
        },
      });
      expect(result.error?.name).toBe("StorageTransactionInconsistent");
      expect(sealed).toEqual([space]);
    });
  });
});
