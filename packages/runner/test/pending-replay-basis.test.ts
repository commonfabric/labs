/**
 * What a runtime shows for its own pending write once another runtime's write
 * to the same document reaches it as confirmed state, before the server has
 * decided the pending one. Two runtimes share one real memory server whose
 * fan-out runs only when a test flushes it, and the second runtime's commits
 * are held on their way to the server until the test releases them, so the
 * peer's write is confirmed and delivered while the local one is still
 * pending. Each case then releases the held commit and checks the server's
 * verdict against what the runtime showed in the meantime.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  decodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  type Options,
  type SessionFactory,
  type SpaceReplica,
  StorageManager,
} from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pending replay basis");
const space = signer.did();

const listSchema = { type: "array", items: { type: "string" } } as const;
const recordSchema = {
  type: "object",
  properties: {
    list: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
} as const;

/**
 * A loopback transport that, while holding, keeps each commit it is handed
 * instead of passing it to the server, and passes the kept commits on when
 * released. Everything else goes straight through.
 */
class CommitHoldingTransport implements MemoryV2Client.Transport {
  readonly #inner: MemoryV2Client.Transport;
  readonly #held: string[] = [];
  #holding = false;

  /** Constructs an instance over a loopback connection to `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#inner = MemoryV2Client.loopback(server);
  }

  /** The commits held so far, as the server would receive them. */
  get heldCommits(): ClientCommit[] {
    return this.#held.map((payload) =>
      (decodeMemoryBoundary(payload) as unknown as { commit: ClientCommit })
        .commit
    );
  }

  /** Starts holding commits. */
  hold(): void {
    this.#holding = true;
  }

  /** Stops holding, and passes every held commit to the server in order. */
  async release(): Promise<void> {
    this.#holding = false;
    for (const payload of this.#held.splice(0)) {
      await this.#inner.send(payload);
    }
  }

  /** @inheritDoc */
  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as { type?: unknown };
    if (this.#holding && message.type === "transact") {
      this.#held.push(payload);
      return Promise.resolve();
    }
    return this.#inner.send(payload);
  }

  /** @inheritDoc */
  close(): Promise<void> {
    return this.#inner.close();
  }

  /** @inheritDoc */
  setReceiver(receiver: (payload: string) => void): void {
    this.#inner.setReceiver(receiver);
  }

  /** @inheritDoc */
  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#inner.setCloseReceiver?.(receiver);
  }

  /** @inheritDoc */
  delivered(): Promise<void> {
    return this.#inner.delivered?.() ?? Promise.resolve();
  }
}

/** Sessions over one {@link CommitHoldingTransport}. */
class HoldingSessionFactory implements SessionFactory {
  readonly #transport: CommitHoldingTransport;

  /** Constructs an instance whose sessions run over `transport`. */
  constructor(transport: CommitHoldingTransport) {
    this.#transport = transport;
  }

  /** @inheritDoc */
  async create(spaceId: MemorySpace, sessionSigner?: Signer) {
    const client = await MemoryV2Client.connect({ transport: this.#transport });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(sessionSigner),
    );
    return { client, session };
  }
}

/** A storage manager whose commits a {@link CommitHoldingTransport} carries. */
class HoldingStorageManager extends StorageManager {
  /** Constructs an instance over `transport`. */
  constructor(transport: CommitHoldingTransport) {
    super(
      { as: signer, memoryHost: new URL("memory://") } as Options,
      new HoldingSessionFactory(transport),
    );
  }

  /** @inheritDoc */
  override registerSpaceHostDetailed() {
    return { accepted: false, reason: "no-remote-resolution" } as const;
  }
}

describe("pending replay basis", () => {
  let server: MemoryV2Server.Server;
  let transportB: CommitHoldingTransport;
  let storageA: EmulatedStorageManager;
  let storageB: HoldingStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    transportB = new CommitHoldingTransport(server);
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = new HoldingStorageManager(transportB);
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
    await transportB.release();
    await server.flushSessions([space]);
    await clock.settle();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  const deliverToB = async () => {
    await server.flushSessions([space]);
    await clock.settle();
  };

  const confirmedSeqInB = (id: string) =>
    (storageB.open(space).replica as SpaceReplica).confirmedDocumentSeq(
      id as `${string}:${string}`,
    );

  describe("a positional write whose basis a peer's write has moved", () => {
    // Both runtimes append the same element to a two-element list by writing
    // the whole list from what they read, which commits a splice at index 2
    // carrying a read of the list.
    const cellOf = (runtime: Runtime) =>
      runtime.getCell<string[]>(space, "entries", listSchema);

    const appendM2 = (runtime: Runtime) => {
      const tx = runtime.edit();
      const cell = cellOf(runtime).withTx(tx);
      cell.set([...cell.get(), "m2"]);
      return tx.commit({ holdSyncedUntilCovered: false }).verdict;
    };

    it("shows the confirmed list, without its own write, until the server refuses it", async () => {
      const seed = rtA.edit();
      cellOf(rtA).withTx(seed).set(["m0", "m1"]);
      expect((await seed.commit({ holdSyncedUntilCovered: false }).verdict)
        .error).toBeUndefined();
      await cellOf(rtB).sync();
      await deliverToB();
      expect(cellOf(rtB).get()).toEqual(["m0", "m1"]);

      transportB.hold();
      const verdictB = appendM2(rtB);
      await clock.settle();
      expect(cellOf(rtB).get()).toEqual(["m0", "m1", "m2"]);
      const [heldCommit] = transportB.heldCommits;
      const id = cellOf(rtB).getAsNormalizedFullLink().id;
      expect(heldCommit.operations).toMatchObject([{
        op: "patch",
        id,
        patches: [{ op: "splice", path: "/value", index: 2, remove: 0 }],
      }]);
      expect(heldCommit.reads.confirmed).toContainEqual(
        expect.objectContaining({ id, path: ["value"] }),
      );

      const seqBeforePeer = confirmedSeqInB(id);
      expect((await appendM2(rtA)).error).toBeUndefined();
      await deliverToB();
      expect(confirmedSeqInB(id)).toBeGreaterThan(seqBeforePeer);
      expect(cellOf(rtB).get()).toEqual(["m0", "m1", "m2"]);

      await transportB.release();
      expect((await verdictB).error?.name).toBe("ConflictError");
      await deliverToB();
      expect(cellOf(rtB).get()).toEqual(["m0", "m1", "m2"]);
    });
  });

  describe("a positional write whose basis a peer's write leaves alone", () => {
    // The peer writes a sibling of the list the local write read, so the
    // local write's read stays valid and the server accepts it.
    const cellOf = (runtime: Runtime) =>
      runtime.getCell<{ list?: string[]; note?: string }>(
        space,
        "record",
        recordSchema,
      );

    it("shows its own write over the confirmed record, and the server accepts it", async () => {
      const seed = rtA.edit();
      cellOf(rtA).withTx(seed).set({ list: ["m0", "m1"], note: "a" });
      expect((await seed.commit({ holdSyncedUntilCovered: false }).verdict)
        .error).toBeUndefined();
      await cellOf(rtB).sync();
      await deliverToB();

      transportB.hold();
      const txB = rtB.edit();
      const listB = cellOf(rtB).withTx(txB).key("list");
      listB.set([...(listB.get() ?? []), "m2"]);
      const verdictB = txB.commit({ holdSyncedUntilCovered: false }).verdict;
      await clock.settle();
      const [heldCommit] = transportB.heldCommits;
      const id = cellOf(rtB).getAsNormalizedFullLink().id;
      expect(heldCommit.operations).toMatchObject([{
        op: "patch",
        id,
        patches: [{ op: "splice", path: "/value/list", index: 2, remove: 0 }],
      }]);

      const seqBeforePeer = confirmedSeqInB(id);
      const txA = rtA.edit();
      cellOf(rtA).withTx(txA).key("note").set("b");
      expect((await txA.commit({ holdSyncedUntilCovered: false }).verdict)
        .error).toBeUndefined();
      await deliverToB();
      expect(confirmedSeqInB(id)).toBeGreaterThan(seqBeforePeer);
      expect(cellOf(rtB).get()).toEqual({
        list: ["m0", "m1", "m2"],
        note: "b",
      });

      await transportB.release();
      expect((await verdictB).error).toBeUndefined();
      await deliverToB();
      expect(cellOf(rtB).get()).toEqual({
        list: ["m0", "m1", "m2"],
        note: "b",
      });
    });
  });

  describe("a mergeable append beside a peer's write to the same list", () => {
    // `push()` commits an `append` that carries no read of the list, so the
    // server folds it over the peer's write rather than refusing it.
    const cellOf = (runtime: Runtime) =>
      runtime.getCell<string[]>(space, "pushed", listSchema);

    it("shows the peer's element and its own appended after it, and the server accepts it", async () => {
      const seed = rtA.edit();
      cellOf(rtA).withTx(seed).set(["m0", "m1"]);
      expect((await seed.commit({ holdSyncedUntilCovered: false }).verdict)
        .error).toBeUndefined();
      await cellOf(rtB).sync();
      await deliverToB();

      transportB.hold();
      const txB = rtB.edit();
      cellOf(rtB).withTx(txB).push("b");
      const verdictB = txB.commit({ holdSyncedUntilCovered: false }).verdict;
      await clock.settle();
      const [heldCommit] = transportB.heldCommits;
      const id = cellOf(rtB).getAsNormalizedFullLink().id;
      expect(heldCommit.operations).toMatchObject([{
        op: "patch",
        id,
        patches: [{ op: "append", path: "/value" }],
      }]);

      const txA = rtA.edit();
      cellOf(rtA).withTx(txA).push("a");
      expect((await txA.commit({ holdSyncedUntilCovered: false }).verdict)
        .error).toBeUndefined();
      await deliverToB();
      expect(cellOf(rtB).get()).toEqual(["m0", "m1", "a", "b"]);

      await transportB.release();
      expect((await verdictB).error).toBeUndefined();
      await deliverToB();
      expect(cellOf(rtB).get()).toEqual(["m0", "m1", "a", "b"]);
    });
  });
});
