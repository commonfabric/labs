/**
 * A replica's promotion of its own accepted patches against a live in-process
 * server that leaves the patched document out of the writer's frame: for
 * every patch op the writer's confirmed document is the one the store holds,
 * although the writer was never sent it. Fan-out is flushed by hand, so each
 * case states which commits share a frame.
 */

import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  type EntityDocument,
  type PatchOp,
  type ServerMessage,
  type SessionSync,
} from "@commonfabric/memory/v2";
import {
  applyPatchToDocument,
  patchOpDescriptors,
} from "@commonfabric/memory/v2/patch";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { NativeStorageCommit } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("own patch promotion");
const space = signer.did();
const TYPE = "application/json" as const;

/** What one connection to the server sent and was sent, oldest first. */
type Wire = {
  /** The ids of the documents each sync frame carried. */
  frames: string[][];

  /** The patch op kinds of each `transact` the connection sent. */
  patches: string[][];
};

/**
 * For each patch op, a document and patches of that kind to apply to it. The
 * table is typed by the union of ops, so an op added to the union has no entry
 * until one is written here.
 */
const CASES: Record<
  PatchOp["op"],
  { seed: FabricValue; patches: PatchOp[] }
> = {
  replace: {
    seed: { items: ["a", "b", "c"] },
    patches: [{ op: "replace", path: "/value/items/1", value: "B" }],
  },
  add: {
    seed: { members: { a: 1 } },
    patches: [{ op: "add", path: "/value/members/b", value: 2 }],
  },
  remove: {
    seed: { members: { a: 1, b: 2 } },
    patches: [{ op: "remove", path: "/value/members/a" }],
  },
  move: {
    seed: { members: { a: 1, b: 2 } },
    patches: [{
      op: "move",
      from: "/value/members/a",
      path: "/value/members/c",
    }],
  },
  splice: {
    seed: { items: ["a", "b", "c", "d"] },
    patches: [{
      op: "splice",
      path: "/value/items",
      index: 1,
      remove: 2,
      add: ["x", "y", "z"],
    }],
  },
  append: {
    seed: { items: ["a"] },
    patches: [{ op: "append", path: "/value/items", values: ["b", "c"] }],
  },
  "add-unique": {
    seed: { items: ["a", "b"] },
    patches: [{ op: "add-unique", path: "/value/items", values: ["b", "c"] }],
  },
  "remove-by-value": {
    seed: { items: ["a", "b", "a"] },
    patches: [{ op: "remove-by-value", path: "/value/items", value: "a" }],
  },
  increment: {
    seed: { count: 4 },
    patches: [{ op: "increment", path: "/value/count", by: 3 }],
  },
};

describe("own-patch-promotion", () => {
  let server: MemoryV2Server.Server;
  let connecting: Stub;
  let wires: Wire[];
  let writerManager: EmulatedStorageManager;
  let observerManager: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    wires = [];
    const connect = server.connect.bind(server);
    connecting = stub(server, "connect", (send, ...rest) => {
      const wire: Wire = { frames: [], patches: [] };
      wires.push(wire);
      const connection = connect((message: ServerMessage, payload) => {
        if (message.type === "session/effect") {
          wire.frames.push(
            (message.effect as unknown as SessionSync).upserts.map((upsert) =>
              upsert.id
            ),
          );
        }
        send(message, payload);
      }, ...rest);
      const receive = connection.receive.bind(connection);
      stub(connection, "receive", (payload) => {
        const sent = decodeMemoryBoundary(payload) as {
          type?: string;
          commit?: { operations: Array<{ patches?: PatchOp[] }> };
        };
        if (sent.type === "transact") {
          wire.patches.push(
            sent.commit!.operations.flatMap((operation) =>
              (operation.patches ?? []).map((patch) => patch.op)
            ),
          );
        }
        return receive(payload);
      });
      return connection;
    });
    writerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    observerManager = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await writerManager.close();
    await observerManager.close();
    connecting.restore();
    await server.close();
  });

  /** Fans out what the server holds back and lets both replicas apply it. */
  const delivered = async (): Promise<void> => {
    await server.flushSessions([space]);
    await clock.settle();
    await writerManager.synced();
    await observerManager.synced();
  };

  /**
   * Commits `operations` through `manager` and resolves at the store's
   * verdict, which it expects to be an accept. The frame that covers the
   * commit is held until the next `delivered()`.
   */
  const commit = async (
    manager: EmulatedStorageManager,
    operations: NativeStorageCommit["operations"],
  ): Promise<void> => {
    const verdict = await manager.open(space).replica.commitNative!(
      { operations },
      undefined,
      { resolveAt: "verdict" },
    );
    expect(verdict.error).toBeUndefined();
  };

  /**
   * Leaves the document `id` stored as `{ value: seed }`, watched and held by
   * the writer, which connects first, and by the observer.
   */
  const seeded = async (id: URI, seed: FabricValue): Promise<void> => {
    expect((await writerManager.open(space).sync(id)).error).toBeUndefined();
    await commit(writerManager, [
      { op: "set", id, type: TYPE, value: { value: seed } },
    ]);
    await delivered();
    expect((await observerManager.open(space).sync(id)).error).toBeUndefined();
    await delivered();
  };

  /**
   * Commits `patches` to `id` through `manager`, as computed over the document
   * `base`, and returns the document so computed.
   */
  const patch = async (
    manager: EmulatedStorageManager,
    id: URI,
    base: EntityDocument,
    patches: PatchOp[],
  ): Promise<EntityDocument> => {
    const computed = applyPatchToDocument(base, patches) as EntityDocument;
    await commit(manager, [
      { op: "patch", id, type: TYPE, patches, value: computed },
    ]);
    return computed;
  };

  /** The writer's and the observer's confirmed view of `id`, and the store's. */
  const views = async (id: URI) => {
    const writer = writerManager.open(space).replica;
    const observer = observerManager.open(space).replica;
    return {
      writer: writer.getDocument(id),
      writerSeq: writer.confirmedDocumentSeq!(id),
      observer: observer.getDocument(id),
      observerSeq: observer.confirmedDocumentSeq!(id),
      store: await server.readDocument(space, id),
    };
  };

  for (const kind of Object.keys(patchOpDescriptors) as PatchOp["op"][]) {
    it(`promotes a \`${kind}\` to the document the store holds, without being sent it`, async () => {
      const id = `of:own-patch-${kind}` as URI;
      const { seed, patches } = CASES[kind];
      await seeded(id, seed);
      const [writerWire, observerWire] = wires;
      writerWire!.frames.length = 0;
      observerWire!.frames.length = 0;

      const computed = await patch(
        writerManager,
        id,
        { value: seed },
        patches,
      );
      await delivered();

      expect(writerWire!.patches.at(-1)).toEqual([kind]);
      expect(writerWire!.frames.flat()).toEqual([]);
      expect(observerWire!.frames.flat()).toEqual([id]);
      const seen = await views(id);
      expect(seen.store).toEqual(computed);
      expect(seen.writer).toEqual(seen.store);
      expect(seen.observer).toEqual(seen.store);
      // The writer's confirmed base stands at the head the observer was sent.
      expect(seen.writerSeq).toBe(seen.observerSeq);
    });
  }

  it("promotes a run of patches committed before one flush, over a base another session patched", async () => {
    const id = "of:own-patch-run" as URI;
    await seeded(id, { items: ["a"] });
    const theirs = await patch(
      observerManager,
      id,
      { value: { items: ["a"] } },
      [
        { op: "append", path: "/value/items", values: ["theirs"] },
      ],
    );
    await delivered();
    const [writerWire] = wires;
    writerWire!.frames.length = 0;

    const first = await patch(writerManager, id, theirs, [
      { op: "splice", path: "/value/items", index: 0, remove: 1, add: [] },
    ]);
    await patch(writerManager, id, first, [
      { op: "append", path: "/value/items", values: ["mine"] },
    ]);
    await delivered();

    expect(writerWire!.frames.flat()).toEqual([]);
    const seen = await views(id);
    expect(seen.store).toEqual({ value: { items: ["theirs", "mine"] } });
    expect(seen.writer).toEqual(seen.store);
    expect(seen.writerSeq).toBe(seen.observerSeq);
  });

  it("promotes a patch committed after the writer's own `set` in the same batch", async () => {
    const id = "of:own-patch-after-set" as URI;
    await seeded(id, { items: ["a"] });
    const [writerWire] = wires;
    writerWire!.frames.length = 0;

    await commit(writerManager, [
      { op: "set", id, type: TYPE, value: { value: { items: ["b"] } } },
    ]);
    await patch(writerManager, id, { value: { items: ["b"] } }, [
      { op: "append", path: "/value/items", values: ["c"] },
    ]);
    await delivered();

    expect(writerWire!.frames.flat()).toEqual([]);
    const seen = await views(id);
    expect(seen.store).toEqual({ value: { items: ["b", "c"] } });
    expect(seen.writer).toEqual(seen.store);
    expect(seen.writerSeq).toBe(seen.observerSeq);
  });

  it("promotes a patch committed after one the store elided as an identity", async () => {
    const id = "of:own-patch-after-identity" as URI;
    await seeded(id, { count: 1, items: ["a"] });
    const [writerWire] = wires;
    writerWire!.frames.length = 0;

    // Replacing a member by the value it holds changes nothing, so the store
    // writes no revision for it.
    const unchanged = await patch(
      writerManager,
      id,
      { value: { count: 1, items: ["a"] } },
      [{ op: "replace", path: "/value/count", value: 1 }],
    );
    await delivered();
    await patch(writerManager, id, unchanged, [
      { op: "append", path: "/value/items", values: ["b"] },
    ]);
    await delivered();

    expect(writerWire!.frames.flat()).toEqual([]);
    const seen = await views(id);
    expect(seen.store).toEqual({ value: { count: 1, items: ["a", "b"] } });
    expect(seen.writer).toEqual(seen.store);
    expect(seen.writerSeq).toBe(seen.observerSeq);
  });

  it("converges on the merged document when another session's patch shares the batch", async () => {
    const id = "of:own-patch-merged" as URI;
    await seeded(id, { items: ["a"] });
    const [writerWire] = wires;
    writerWire!.frames.length = 0;

    // The store has applied the other session's patch by the time it applies
    // the writer's, which the writer computed without it.
    await patch(observerManager, id, { value: { items: ["a"] } }, [
      { op: "append", path: "/value/items", values: ["theirs"] },
    ]);
    await patch(writerManager, id, { value: { items: ["a"] } }, [
      { op: "append", path: "/value/items", values: ["mine"] },
    ]);
    await delivered();

    expect(writerWire!.frames.flat()).toEqual([id]);
    const seen = await views(id);
    expect(seen.store).toEqual({ value: { items: ["a", "theirs", "mine"] } });
    expect(seen.writer).toEqual(seen.store);
  });

  it("promotes a splice a cell's write produced over the array its transaction read", async () => {
    const schema = {
      type: "array",
      items: { type: "string" },
    } as const satisfies JSONSchema;
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    try {
      const seedTx = runtime.edit();
      runtime.getCell<string[]>(space, "own-patch-cell", schema, seedTx)
        .set(["a", "b", "c", "d"]);
      const seeding = seedTx.commit({ holdSyncedUntilCovered: false });
      expect((await seeding.verdict).error).toBeUndefined();
      await delivered();
      const cell = runtime.getCell<string[]>(space, "own-patch-cell", schema);
      await cell.sync();
      await delivered();
      const id = cell.getAsNormalizedFullLink().id as URI;
      const [writerWire] = wires;
      writerWire!.frames.length = 0;

      const tx = runtime.edit();
      const list = cell.withTx(tx);
      expect(list.get()).toEqual(["a", "b", "c", "d"]);
      list.set(["a", "x", "b", "c", "d"]);
      const written = tx.commit({ holdSyncedUntilCovered: false });
      expect((await written.verdict).error).toBeUndefined();
      await delivered();
      await runtime.idle();

      expect(writerWire!.patches.at(-1)).toContain("splice");
      expect(writerWire!.frames.flat()).toEqual([]);
      const store = await server.readDocument(space, id);
      expect(store).toEqual({ value: ["a", "x", "b", "c", "d"] });
      const replica = writerManager.open(space).replica;
      expect(replica.getDocument(id)).toEqual(store);
      expect(cell.get()).toEqual(["a", "x", "b", "c", "d"]);
    } finally {
      await runtime.dispose();
    }
  });
});
