/**
 * `Cell.addAnchor()`, `Cell.removeAnchor()` and the `anchorsOf()` builtin,
 * against a real Memory engine: what the commit carries to the store, and the
 * anchors document Memory writes from it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue, FieldAnchors } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationAnchorsDocId,
  operationBaselineHash,
  toValuePath,
} from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import {
  hasOperationStorageCapability,
  type IExtendedStorageTransaction,
  type NativeStorageCommit,
} from "../src/storage/interface.ts";
import { getDirectTransactionNativeCommit } from "../src/storage/transaction-inspection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { toURI } from "../src/uri-utils.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("collaborative-field-anchors");
const space = signer.did();
const CAUSE = "collaborative-anchors-note";

type Note = { title: string; body: string };

const noteSchema = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  // deno-lint-ignore no-explicit-any
} as any;

/** The operation-field capability of `storage`'s replica for the test space. */
const operationsOf = (storage: EmulatedStorageManager) => {
  const replica = storage.open(space).replica;
  if (!hasOperationStorageCapability(replica)) {
    throw new Error("the emulated replica lacks the operation capability");
  }
  return replica;
};

/** Resolves once `note`'s `body` holds `text` in its session's replica. */
const whenBodyIs = (note: Cell<Note>, text: string): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const cancel = note.key("body").sink((value) => {
    if (value === text) resolve();
  });
  return promise.then(() => cancel());
};

/** The id of the anchors document of `note`'s `body`. */
const anchorsDocIdOf = (note: Cell<Note>) => {
  const { id, scope, path } = note.key("body").getAsNormalizedFullLink();
  return toURI(operationAnchorsDocId({ id, scope, path }));
};

/** The anchors document of `note`'s `body`, as a fresh session reads it. */
async function readAnchors(
  server: MemoryV2Server.Server,
  note: Cell<Note>,
): Promise<FieldAnchors | undefined> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCellFromLink<FieldAnchors | undefined>({
      space,
      id: anchorsDocIdOf(note),
      scope: "space",
      path: [],
    });
    await cell.sync();
    await cell.pull();
    return cell.get();
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

/** The note's body as a fresh session reads it. */
async function readBody(server: MemoryV2Server.Server): Promise<string> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<Note>(space, CAUSE, noteSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() as Note).body;
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

/** The `apply-op`s `native` carries, as the store receives them. */
const applyOpsOf = (native: NativeStorageCommit | undefined) =>
  native?.applyOps ?? [];

describe("collaborative-field-anchors", () => {
  let server: MemoryV2Server.Server;
  let storage: EmulatedStorageManager;
  let editorStorage: EmulatedStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    // Fan-out is manual, so a session sees another's write only once the
    // test has the server deliver it.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    editorStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await editorStorage?.close();
    await storage?.close();
    await server?.close();
  });

  /** Submits one editor keystroke batch from the editor's own session. */
  const type = (
    note: Cell<Note>,
    submissionId: string,
    base: { epoch: number; version: number } | null,
    changes: FabricValue[],
  ) => {
    const link = note.key("body").getAsNormalizedFullLink();
    return operationsOf(editorStorage).applyOperation({
      op: "apply-op",
      id: link.id,
      path: toValuePath(link.path),
      codec: CODEMIRROR_CHANGESET_CODEC,
      submissionId,
      base,
      ...(base === null ? { baselineHash: operationBaselineHash("ac") } : {}),
      payload: { updates: [{ clientId: "editor", changes }] },
    });
  };

  /** Writes the note `{ title: "Notes", body: "ac" }` and waits for it. */
  const seed = async (): Promise<Cell<Note>> => {
    const tx = rt.edit();
    rt.getCell<Note>(space, CAUSE, noteSchema, tx).set({
      title: "Notes",
      body: "ac",
    });
    await tx.commit({ holdSyncedUntilCovered: false }).verdict;
    await rt.storageManager.synced();
    const note = rt.getCell<Note>(space, CAUSE, noteSchema);
    await note.sync();
    return note;
  };

  /**
   * Opens a field epoch on `body` from the editor's session, typing a `b`, and
   * waits for this session to see it: the body is `abc` at version 1.
   */
  const openAsEditor = async (note: Cell<Note>): Promise<void> => {
    const arrived = whenBodyIs(note, "abc");
    await type(note, "editor:1", null, [1, [0, "b"], 1]);
    await server.flushSessions();
    await arrived;
  };

  /** Commits `edit`'s writes to `note` in one transaction. */
  const commit = async (
    note: Cell<Note>,
    edit: (body: Cell<string>) => void,
  ) => {
    const tx = rt.edit();
    edit(note.withTx(tx).key("body"));
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    await rt.storageManager.synced();
    return committed;
  };

  describe("without a base", () => {
    it("sends an anchor alone on an `apply-op` with an empty payload and the hash of the value read", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 });
      const native = getDirectTransactionNativeCommit(tx, space);

      expect(native?.operations).toEqual([]);
      expect(applyOpsOf(native)).toEqual([expect.objectContaining({
        op: "apply-op",
        path: ["body"],
        baselineHash: operationBaselineHash("abc"),
        payload: { updates: [] },
        anchors: { add: [{ id: "b", from: 1, to: 2 }] },
      })]);
      tx.abort();
    });

    it("commits an anchor alone, which Memory stores and writes to the anchors document", async () => {
      const note = await seed();
      await openAsEditor(note);

      const committed = await commit(
        note,
        (body) => body.addAnchor("b", { from: 1, to: 2 }),
      );

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("abc");
      expect(await readAnchors(server, note)).toEqual({
        epoch: 1,
        version: 1,
        anchors: [{ id: "b", from: 1, to: 2 }],
      });
    });

    it("activates an inactive field to anchor it", async () => {
      const note = await seed();

      const committed = await commit(
        note,
        (body) => body.addAnchor("a", { from: 0, to: 1 }),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toEqual({
        epoch: 1,
        version: 0,
        anchors: [{ id: "a", from: 0, to: 1 }],
      });
    });

    it("carries an anchor added after text changes on their `apply-op`, stated against the text they leave", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.applyChanges({ from: 3, insert: "d" });
      body.addAnchor("cd", { from: 2, to: 4 });
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));

      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        baselineHash: operationBaselineHash("abc"),
        anchors: { add: [{ id: "cd", from: 2, to: 4 }] },
      });
      expect(ops[0].payload).not.toEqual({ updates: [] });
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      await rt.storageManager.synced();

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("abcd");
      expect(await readAnchors(server, note)).toEqual({
        epoch: 1,
        version: 2,
        anchors: [{ id: "cd", from: 2, to: 4 }],
      });
    });

    it("sends an anchor added before text changes on an `apply-op` ahead of theirs, so that Memory moves it through them", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.addAnchor("bc", { from: 1, to: 3 });
      body.applyChanges({ from: 0, insert: "> " });
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));

      expect(
        ops.map(({ baselineHash, anchors }) => ({ baselineHash, anchors })),
      )
        .toEqual([
          {
            baselineHash: operationBaselineHash("abc"),
            anchors: { add: [{ id: "bc", from: 1, to: 3 }] },
          },
          { baselineHash: operationBaselineHash("abc"), anchors: undefined },
        ]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      await rt.storageManager.synced();

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("> abc");
      expect(await readAnchors(server, note)).toMatchObject({
        anchors: [{ id: "bc", from: 3, to: 5 }],
      });
    });

    it("refuses the commit when the field moved after the transaction read it", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 });
      await type(note, "editor:2", { epoch: 1, version: 1 }, [3, [0, "d"]]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(committed.error).toBeDefined();
      expect(await readAnchors(server, note)).toBeUndefined();
    });
  });

  describe("with a base", () => {
    it("sends the anchor on an `apply-op` naming the base, with an empty payload and no hash", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("a", { from: 0, to: 1 }, {
        base: { epoch: 1, version: 0 },
      });
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));

      expect(ops).toEqual([expect.objectContaining({
        base: { epoch: 1, version: 0 },
        payload: { updates: [] },
        anchors: { add: [{ id: "a", from: 0, to: 1 }] },
      })]);
      expect(Object.hasOwn(ops[0], "baselineHash")).toBe(false);
      tx.abort();
    });

    it("commits a range stated at an older version, which Memory maps over the edits since", async () => {
      // `c` is 1..2 in `ac`, at version 0; the editor's `b` moves it to 2..3.

      const note = await seed();
      await openAsEditor(note);

      const committed = await commit(
        note,
        (body) =>
          body.addAnchor("c", { from: 1, to: 2 }, {
            base: { epoch: 1, version: 0 },
          }),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toMatchObject({
        anchors: [{ id: "c", from: 2, to: 3 }],
      });
    });

    it("lands although the field moved after the transaction read it", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 }, {
        base: { epoch: 1, version: 1 },
      });
      await type(note, "editor:2", { epoch: 1, version: 1 }, [[0, "> "], 3]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      await rt.storageManager.synced();

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toMatchObject({
        anchors: [{ id: "b", from: 3, to: 4 }],
      });
    });

    it("refuses the commit when another field of the document the transaction read moved", async () => {
      // Only the reads incidental to the anchored field leave the conflict
      // set; the transaction's read of the title stays a precondition.

      const note = await seed();
      await openAsEditor(note);
      const otherStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const other = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: otherStorage,
      });
      try {
        const tx = rt.edit();
        expect(note.withTx(tx).key("title").get()).toBe("Notes");
        note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 }, {
          base: { epoch: 1, version: 1 },
        });
        await other.getCell<Note>(space, CAUSE, noteSchema).sync();
        const retitle = other.edit();
        other.getCell<Note>(space, CAUSE, noteSchema, retitle).key("title")
          .set("Agenda");
        expect((await retitle.commit().verdict).error).toBeUndefined();
        const committed = await tx.commit({ holdSyncedUntilCovered: false })
          .verdict;

        expect(committed.error?.name).toBe("ConflictError");
        expect(await readAnchors(server, note)).toBeUndefined();
      } finally {
        await other.dispose();
        await otherStorage.close();
      }
    });

    it("sends the based anchor after the text edit of the same transaction", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.applyChanges({ from: 0, insert: "> " });
      body.addAnchor("c", { from: 2, to: 3 }, {
        base: { epoch: 1, version: 1 },
      });
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));

      expect(ops.map((op) => op.base)).toEqual([undefined, {
        epoch: 1,
        version: 1,
      }]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      await rt.storageManager.synced();

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("> abc");
      expect(await readAnchors(server, note)).toMatchObject({
        anchors: [{ id: "c", from: 4, to: 5 }],
      });
    });
  });

  describe("removeAnchor", () => {
    /** Anchors `a` at 0..1 and `b` at 1..2. */
    const anchorTwo = (note: Cell<Note>) =>
      commit(note, (body) => {
        body.addAnchor("a", { from: 0, to: 1 });
        body.addAnchor("b", { from: 1, to: 2 });
      });

    it("sends a remove on an `apply-op` with neither a base nor a hash", async () => {
      const note = await seed();
      await openAsEditor(note);
      await anchorTwo(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").removeAnchor("a");
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));

      expect(ops).toEqual([expect.objectContaining({
        payload: { updates: [] },
        anchors: { remove: ["a"] },
      })]);
      expect(Object.hasOwn(ops[0], "base")).toBe(false);
      expect(Object.hasOwn(ops[0], "baselineHash")).toBe(false);
      tx.abort();
    });

    it("removes an anchor the field holds although the field moved after the transaction read it", async () => {
      const note = await seed();
      await openAsEditor(note);
      await anchorTwo(note);

      const tx = rt.edit();
      note.withTx(tx).key("body").removeAnchor("a");
      await type(note, "editor:2", { epoch: 1, version: 1 }, [3, [0, "d"]]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      await rt.storageManager.synced();

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("abcd");
      expect(await readAnchors(server, note)).toMatchObject({
        anchors: [{ id: "b", from: 1, to: 2 }],
      });
    });

    it("removes an anchor whose add is still in flight", async () => {
      // The remove is recorded while the add's commit has not landed, so no
      // anchors document this session holds names the id yet.

      const note = await seed();
      await openAsEditor(note);

      const add = rt.edit();
      note.withTx(add).key("body").addAnchor("x", { from: 0, to: 1 });
      const added = add.commit({ holdSyncedUntilCovered: false }).verdict;
      const remove = rt.edit();
      note.withTx(remove).key("body").removeAnchor("x");
      expect(applyOpsOf(getDirectTransactionNativeCommit(remove, space)))
        .toEqual([expect.objectContaining({ anchors: { remove: ["x"] } })]);
      const removed = remove.commit({ holdSyncedUntilCovered: false }).verdict;

      expect((await added).error).toBeUndefined();
      expect((await removed).error).toBeUndefined();
      await rt.storageManager.synced();
      expect(await readAnchors(server, note)).toMatchObject({ anchors: [] });
    });

    it("leaves an inactive field inactive when it removes an anchor", async () => {
      const note = await seed();

      const remove = rt.edit();
      note.withTx(remove).key("body").removeAnchor("a");
      expect(applyOpsOf(getDirectTransactionNativeCommit(remove, space)))
        .toEqual([expect.objectContaining({ anchors: { remove: ["a"] } })]);
      expect(
        (await remove.commit({ holdSyncedUntilCovered: false }).verdict)
          .error,
      ).toBeUndefined();
      await rt.storageManager.synced();

      const set = await commit(note, (body) => body.set("replaced"));
      expect(set.error).toBeUndefined();
      expect(await readBody(server)).toBe("replaced");
      expect(await readAnchors(server, note)).toBeUndefined();
    });
  });

  describe("folding", () => {
    /** The anchor changes of the `apply-op`s `edit` makes, in order. */
    const anchorChanges = async (edit: (body: Cell<string>) => void) => {
      const note = await seed();
      await openAsEditor(note);
      const tx = rt.edit();
      edit(note.withTx(tx).key("body"));
      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));
      tx.abort();
      return ops.map((op) => op.anchors);
    };

    it("sends the later of two adds of one id", async () => {
      expect(
        await anchorChanges((body) => {
          body.addAnchor("a", { from: 0, to: 1 });
          body.addAnchor("a", { from: 1, to: 3 });
        }),
      ).toEqual([{ add: [{ id: "a", from: 1, to: 3 }] }]);
    });

    it("sends only the remove of an id added and then removed", async () => {
      expect(
        await anchorChanges((body) => {
          body.addAnchor("a", { from: 0, to: 1 });
          body.addAnchor("a", { from: 0, to: 1 }, {
            base: { epoch: 1, version: 1 },
          });
          body.removeAnchor("a");
        }),
      ).toEqual([{ remove: ["a"] }]);
    });

    it("sends only the add of an id removed and then added", async () => {
      expect(
        await anchorChanges((body) => {
          body.removeAnchor("a");
          body.addAnchor("a", { from: 0, to: 1 }, {
            base: { epoch: 1, version: 1 },
          });
        }),
      ).toEqual([{ add: [{ id: "a", from: 0, to: 1 }] }]);
    });

    it("keeps an id out of an earlier text edit's `apply-op` once a later call names it", async () => {
      expect(
        await anchorChanges((body) => {
          body.addAnchor("a", { from: 0, to: 1 });
          body.applyChanges({ from: 3, insert: "d" });
          body.addAnchor("a", { from: 3, to: 4 });
        }),
      ).toEqual([{ add: [{ id: "a", from: 3, to: 4 }] }]);
    });
  });

  describe("refusals", () => {
    it("throws outside a transaction", async () => {
      const note = await seed();

      expect(() => note.key("body").addAnchor("a", { from: 0, to: 1 }))
        .toThrow("requires a transaction");
      expect(() => note.key("body").removeAnchor("a"))
        .toThrow("requires a transaction");
    });

    it("throws when the cell holds no string", async () => {
      const note = await seed();

      const tx = rt.edit();
      expect(() => note.withTx(tx).addAnchor("a", { from: 0, to: 1 }))
        .toThrow("string value");
      expect(() =>
        note.withTx(tx).addAnchor("a", { from: 0, to: 1 }, {
          base: { epoch: 1, version: 0 },
        })
      ).toThrow("string value");
      expect(() => note.withTx(tx).removeAnchor("a")).toThrow("string value");
      tx.abort();
    });

    it("throws when a range does not fit the value, or is not a range", async () => {
      const note = await seed();

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      expect(() => body.addAnchor("a", { from: 0, to: 3 })).toThrow(
        "falls outside a text of length 2",
      );
      expect(() => body.addAnchor("a", { from: 2, to: 1 })).toThrow(
        "falls outside",
      );
      expect(() => body.addAnchor("a", { from: 0.5, to: 1 })).toThrow(
        "falls outside",
      );
      expect(() =>
        body.addAnchor("a", { from: -1, to: 1 }, {
          base: { epoch: 1, version: 0 },
        })
      ).toThrow("falls outside any text");
      expect(applyOpsOf(getDirectTransactionNativeCommit(tx, space)))
        .toEqual([]);
      tx.abort();
    });

    it("throws for an empty id", async () => {
      const note = await seed();

      const tx = rt.edit();
      expect(() => note.withTx(tx).key("body").removeAnchor("")).toThrow(
        "non-empty string",
      );
      tx.abort();
    });

    it("throws when the transaction already wrote the field another way", async () => {
      const note = await seed();

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.set("replaced");
      expect(() => body.addAnchor("a", { from: 0, to: 1 })).toThrow(
        "already wrote the field another way",
      );
      tx.abort();
    });

    it("throws when a base is not a version", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      for (
        const base of [
          { epoch: 0, version: 0 },
          { epoch: 1, version: -1 },
          { epoch: 1.5, version: 0 },
        ]
      ) {
        expect(() => body.addAnchor("a", { from: 0, to: 1 }, { base }))
          .toThrow("an anchor's base must name an epoch from 1");
      }
      expect(applyOpsOf(getDirectTransactionNativeCommit(tx, space)))
        .toEqual([]);
      tx.abort();
    });

    it("fails a handler whose anchor names a version the field does not have, without running it again", async () => {
      const note = await seed();
      await openAsEditor(note);
      let runs = 0;
      const stream = rt.getCell<unknown>(space, "collaborative-anchors-stale");
      rt.scheduler.addEventHandler((tx) => {
        runs++;
        note.withTx(tx).key("body").addAnchor("a", { from: 0, to: 1 }, {
          base: { epoch: 2, version: 0 },
        });
      }, stream.getAsNormalizedFullLink());
      const settled = Promise.withResolvers<IExtendedStorageTransaction>();

      rt.scheduler.queueEvent(
        stream.getAsNormalizedFullLink(),
        {},
        true,
        (tx) => settled.resolve(tx),
      );
      const handled = await settled.promise;
      await rt.idle();

      expect(handled.status()).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("epoch mismatch") },
      });
      expect(runs).toBe(1);
      expect(await readAnchors(server, note)).toBeUndefined();
    });

    it("records none of a list of changes when one of them is refused", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      expect(() =>
        tx.recordAnchorChanges(note.key("body").getAsNormalizedFullLink(), [
          { op: "add", id: "a", from: 0, to: 1 },
          { op: "remove", id: "b" },
          { op: "add", id: "c", from: 0, to: 9 },
        ])
      ).toThrow("falls outside a text of length 3");
      expect(applyOpsOf(getDirectTransactionNativeCommit(tx, space)))
        .toEqual([]);
      tx.abort();
    });

    it("throws when anchors of one field name two versions", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.addAnchor("a", { from: 0, to: 1 }, {
        base: { epoch: 1, version: 0 },
      });
      expect(() =>
        body.addAnchor("b", { from: 0, to: 1 }, {
          base: { epoch: 1, version: 1 },
        })
      ).toThrow("name one version");
      tx.abort();
    });

    it("commits only the later add when one id is added against two versions", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.addAnchor("a", { from: 0, to: 1 }, {
        base: { epoch: 1, version: 0 },
      });
      body.addAnchor("a", { from: 1, to: 2 }, {
        base: { epoch: 1, version: 1 },
      });

      const ops = applyOpsOf(getDirectTransactionNativeCommit(tx, space));
      expect(ops).toHaveLength(1);
      expect(ops[0].base).toEqual({ epoch: 1, version: 1 });
      expect(ops[0].anchors).toEqual({ add: [{ id: "a", from: 1, to: 2 }] });
      tx.abort();
    });

    it("throws when building a commit whose field was written after its anchors", async () => {
      const note = await seed();

      const tx = rt.edit();
      const body = note.withTx(tx).key("body");
      body.addAnchor("a", { from: 0, to: 1 });
      body.set("replaced");
      expect(() => getDirectTransactionNativeCommit(tx, space)).toThrow(
        "does not hold the text its recorded changes produce",
      );
      tx.abort();
    });

    it("leaves anchors out of a whole-document write", async () => {
      // A whole-document transaction that is not authoritative is the client
      // speculation overlay's seal, whose entries never reach the store.

      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      note.withTx(tx).key("title").set("Agenda");
      note.withTx(tx).key("body").addAnchor("a", { from: 0, to: 1 });
      tx.tx.markWholeDocumentWrites!();
      const native = getDirectTransactionNativeCommit(tx, space);

      expect(native?.applyOps).toBeUndefined();
      expect(native?.operations).toMatchObject([{
        op: "set",
        value: { value: { title: "Agenda", body: "abc" } },
      }]);
      tx.abort();
    });

    it("refuses anchors in a store commit built ahead of its seal", async () => {
      const note = await seed();

      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("a", { from: 0, to: 1 });
      const native = getDirectTransactionNativeCommit(tx, space)!;
      const replica = storage.open(space).replica;
      expect(() => replica.storeCommitOf!(native, tx)).toThrow(
        "cannot carry collaborative-field",
      );
      tx.abort();
    });
  });

  describe("anchorsOf", () => {
    it("returns `undefined` for a field with no anchors, and then the anchors document Memory writes", async () => {
      const note = await seed();
      await openAsEditor(note);
      const { commonfabric } = createTrustedBuilder(rt);
      const anchored = commonfabric.pattern<{ body: string }>(({ body }) => ({
        anchors: commonfabric.anchorsOf(body),
      }));
      const setup = rt.edit();
      const result = rt.run(
        setup,
        anchored,
        { body: note.key("body") },
        rt.getCell(space, "collaborative-anchors-reader", undefined, setup),
      );
      await setup.commit().verdict;
      await result.pull();

      expect(result.key("anchors").get()).toBeUndefined();

      const arrived = Promise.withResolvers<void>();
      const cancel = result.key("anchors").sink((anchors) => {
        if (anchors !== undefined) arrived.resolve();
      });
      const tx = rt.edit();
      note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 });
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      expect(committed.error).toBeUndefined();
      // Memory writes the anchors document, and fan-out is manual, so this
      // session sees it once the server delivers it.
      await server.flushSessions();
      await arrived.promise;
      cancel();

      expect(result.key("anchors").get()).toEqual({
        epoch: 1,
        version: 1,
        anchors: [{ id: "b", from: 1, to: 2 }],
      });
    });

    it("delivers the anchors document to a lift in the session that wrote the anchor", async () => {
      // The emulated storage `cf test` runs on, whose fan-out is prompt. The
      // lift commits what it computes from the anchors document, and that
      // commit is refused until this session holds the document Memory wrote.

      const local = EmulatedStorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: local,
      });
      try {
        const seeded = runtime.edit();
        const note = runtime.getCell<Note>(space, CAUSE, noteSchema, seeded);
        note.set({ title: "Notes", body: "abc" });
        await seeded.commit().verdict;
        const { commonfabric } = createTrustedBuilder(runtime);
        const ids = commonfabric.lift((anchors: FieldAnchors | undefined) =>
          (anchors?.anchors ?? []).map(({ id }) => id)
        );
        const anchored = commonfabric.pattern<{ body: string }>((
          { body },
        ) => ({ ids: ids(commonfabric.anchorsOf(body)) }));
        const setup = runtime.edit();
        const result = runtime.run(
          setup,
          anchored,
          { body: note.key("body") },
          runtime.getCell(
            space,
            "collaborative-anchors-lift",
            undefined,
            setup,
          ),
        );
        await setup.commit().verdict;
        const arrived = Promise.withResolvers<void>();
        const cancel = result.key("ids").sink((value) => {
          if (Array.isArray(value) && value.length > 0) arrived.resolve();
        });
        const tx = runtime.edit();
        note.withTx(tx).key("body").addAnchor("b", { from: 1, to: 2 });
        expect((await tx.commit().verdict).error).toBeUndefined();
        await arrived.promise;
        cancel();
        await runtime.idle();

        expect(result.key("ids").get()).toEqual(["b"]);
      } finally {
        await runtime.dispose();
        await local.close();
      }
    });
  });
});
