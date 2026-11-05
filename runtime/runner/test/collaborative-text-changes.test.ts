import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  toValuePath,
} from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { hasOperationStorageCapability } from "../src/storage/interface.ts";
import { getDirectTransactionNativeCommit } from "../src/storage/transaction-inspection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("collaborative-text-changes");
const space = signer.did();
const CAUSE = "collaborative-text-note";

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

/** The note as a fresh session reads it off `server`. */
async function readDurable(server: MemoryV2Server.Server): Promise<Note> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<Note>(space, CAUSE, noteSchema);
    await cell.sync();
    await cell.pull();
    return cell.get() as Note;
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("collaborative-text-changes", () => {
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
   * waits for this session to see it.
   */
  const openAsEditor = async (note: Cell<Note>): Promise<void> => {
    const arrived = whenBodyIs(note, "abc");
    await type(note, "editor:1", null, [1, [0, "b"], 1]);
    await server.flushSessions();
    await arrived;
  };

  /** The `body` field's projection as the store reports it. */
  const bodyField = (note: Cell<Note>) => {
    const link = note.key("body").getAsNormalizedFullLink();
    return operationsOf(storage).queryOperationField({
      id: link.id,
      path: toValuePath(link.path),
    });
  };

  it("commits an edit to an active field and leaves the field active", async () => {
    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    const body = note.withTx(tx).key("body");
    body.applyChanges({ from: 3, insert: "d" });
    expect(body.get()).toBe("abcd");
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
    expect(note.key("body").get()).toBe("abcd");
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual({ title: "Notes", body: "abcd" });
    expect(await bodyField(note)).toMatchObject({
      active: true,
      cursor: { epoch: 1, version: 2 },
      materialized: "abcd",
    });
  });

  it("sends the edit as an `apply-op` without a base, carrying the hash of the value read, after a patch that leaves the field alone", async () => {
    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    note.withTx(tx).key("title").set("Agenda");
    note.withTx(tx).key("body").applyChanges([
      { from: 0, insert: "> " },
      { from: 3, insert: "d" },
    ]);
    const native = getDirectTransactionNativeCommit(tx, space);

    expect(native?.applyOps).toHaveLength(1);
    const edit = native?.applyOps?.[0];
    expect(edit).toMatchObject({
      op: "apply-op",
      path: ["body"],
      baselineHash: operationBaselineHash("abc"),
    });
    expect(edit !== undefined && Object.hasOwn(edit, "base")).toBe(false);
    const patch = native?.operations.find((operation) =>
      operation.op === "patch"
    );
    expect(patch).toMatchObject({
      patches: [{ op: "replace", path: "/value/title", value: "Agenda" }],
      value: { value: { title: "Agenda", body: "> abcd" } },
    });
    tx.abort();
  });

  it("commits an ordinary write to another field of the same document beside the edit", async () => {
    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    note.withTx(tx).key("title").set("Agenda");
    note.withTx(tx).key("body").applyChanges({ from: 0, insert: "> " });
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual({
      title: "Agenda",
      body: "> abc",
    });
    expect(note.get()).toEqual({ title: "Agenda", body: "> abc" });
  });

  it("commits two calls on one field as edits against the value each one found", async () => {
    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    const body = note.withTx(tx).key("body");
    body.applyChanges({ from: 3, insert: "d" });
    body.applyChanges({ from: 0, to: 1, insert: "A" });
    expect(body.get()).toBe("Abcd");
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual({ title: "Notes", body: "Abcd" });
  });

  it("commits the changes as they stood when recorded, however the caller's list changes later", async () => {
    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    const body = note.withTx(tx).key("body");
    const changes = [{ from: 3, insert: "d" }];
    body.applyChanges(changes);
    changes[0].insert = "WRONG";
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual({ title: "Notes", body: "abcd" });
  });

  it("carries the changed text in a whole-document write, with no `apply-op`", async () => {
    // A whole-document transaction that is not authoritative is the client
    // speculation overlay's seal, whose entries never reach the store.

    const note = await seed();
    await openAsEditor(note);

    const tx = rt.edit();
    note.withTx(tx).key("body").applyChanges({ from: 3, insert: "d" });
    tx.tx.markWholeDocumentWrites!();
    const native = getDirectTransactionNativeCommit(tx, space);

    expect(native?.applyOps).toBeUndefined();
    expect(native?.operations).toMatchObject([{
      op: "set",
      value: { value: { title: "Notes", body: "abcd" } },
    }]);
    tx.abort();
  });

  it("activates an inactive field from the value the transaction read", async () => {
    const note = await seed();

    const tx = rt.edit();
    note.withTx(tx).key("body").applyChanges({ from: 2, insert: "!" });
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
    await rt.storageManager.synced();

    expect(await bodyField(note)).toMatchObject({
      active: true,
      baselineHash: operationBaselineHash("ac"),
      materialized: "ac!",
    });
  });

  it("refuses the commit when the field moved after the transaction read it", async () => {
    const note = await seed();
    await openAsEditor(note);

    // A second session holds the note as it stood before the editor's next
    // keystroke, and fan-out is manual, so nothing refreshes it.
    const otherStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherStorage,
    });
    try {
      const stale = other.getCell<Note>(space, CAUSE, noteSchema);
      await stale.sync();
      await stale.pull();
      expect(stale.get()).toEqual({ title: "Notes", body: "abc" });

      await type(note, "editor:2", { epoch: 1, version: 1 }, [3, [0, "d"]]);

      const tx = other.edit();
      stale.withTx(tx).key("body").applyChanges({ from: 3, insert: "!" });
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(committed.error).toBeDefined();
      expect(await readDurable(server)).toEqual({
        title: "Notes",
        body: "abcd",
      });
    } finally {
      await other.dispose();
      await otherStorage.close();
    }
  });

  it("throws when building a commit whose text changes were recorded without their write", async () => {
    const note = await seed();

    const tx = rt.edit();
    tx.recordTextChanges!(note.key("body").getAsNormalizedFullLink(), [
      { from: 2, insert: "!" },
    ]);
    expect(() => getDirectTransactionNativeCommit(tx, space)).toThrow(
      "does not hold the text its recorded changes produce",
    );
    tx.abort();
  });

  it("throws when the cell holds no string", async () => {
    const note = await seed();

    const tx = rt.edit();
    expect(() => note.withTx(tx).applyChanges({ from: 0, insert: "x" }))
      .toThrow("string value");
    tx.abort();
  });

  it("throws when the transaction already wrote the field another way", async () => {
    const note = await seed();

    const tx = rt.edit();
    const body = note.withTx(tx).key("body");
    body.set("replaced");
    expect(() => body.applyChanges({ from: 0, insert: "x" })).toThrow(
      "already wrote the field another way",
    );
    tx.abort();
  });
});
