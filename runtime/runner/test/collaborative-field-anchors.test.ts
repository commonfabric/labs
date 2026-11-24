/**
 * A collaborative field's anchors document and the `anchorsOf()` builtin,
 * against a real Memory engine: a transaction writes the anchors as it writes
 * any cell, its commit lands only while the field and the anchors are what it
 * read, and Memory moves the anchors through every edit.
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

  /** The anchors document of `note`'s `body`, as a cell of this session. */
  const anchorsOf = (
    note: Cell<Note>,
    tx?: IExtendedStorageTransaction,
  ): Cell<FieldAnchors | undefined> =>
    rt.getCellFromLink<FieldAnchors | undefined>(
      { space, id: anchorsDocIdOf(note), scope: "space", path: [] },
      undefined,
      tx,
    );

  /** Commits what `edit` does to `note`'s body and anchors in one transaction. */
  const commit = async (
    note: Cell<Note>,
    edit: (
      body: Cell<string>,
      anchors: Cell<FieldAnchors | undefined>,
    ) => void,
  ) => {
    const tx = rt.edit();
    edit(note.withTx(tx).key("body"), anchorsOf(note, tx));
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    await rt.storageManager.synced();
    return committed;
  };

  /** Anchors both ends of the `b` of `abc`, as a highlight of it would. */
  const highlightB = (note: Cell<Note>) =>
    commit(note, (_body, anchors) => anchors.set({ from: 1, to: 2 }));

  describe("a write of the anchors document", () => {
    it("stores the anchors on a field no editor has opened", async () => {
      const note = await seed();

      const committed = await commit(
        note,
        (_body, anchors) => anchors.set({ a: 1 }),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toEqual({ a: 1 });
    });

    it("stores the anchors on a field an editor has opened", async () => {
      const note = await seed();
      await openAsEditor(note);

      const committed = await highlightB(note);

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("abc");
      expect(await readAnchors(server, note)).toEqual({ from: 1, to: 2 });
    });

    it("replaces the anchors the document held", async () => {
      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      const committed = await commit(
        note,
        (_body, anchors) => anchors.set({ from: anchors.get()!.from }),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toEqual({ from: 1 });
    });

    it("refuses the commit when the field moved after the transaction read it", async () => {
      const note = await seed();
      await openAsEditor(note);

      const tx = rt.edit();
      expect(note.withTx(tx).key("body").get()).toBe("abc");
      anchorsOf(note, tx).set({ c: 2 });
      await type(note, "editor:2", { epoch: 1, version: 1 }, [[0, "x"], 3]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(committed.error?.name).toBe("ConflictError");
      expect(await readAnchors(server, note)).toBeUndefined();
    });

    it("refuses the commit when the anchors moved after the transaction read them", async () => {
      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      const tx = rt.edit();
      const anchors = anchorsOf(note, tx);
      expect(anchors.get()).toEqual({ from: 1, to: 2 });
      anchors.key("end").set(3);
      // An edit ahead of the anchors moves both, which rewrites the document
      // this transaction read.
      await type(note, "editor:2", { epoch: 1, version: 1 }, [[0, "x"], 3]);
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(committed.error?.name).toBe("ConflictError");
      expect(await readAnchors(server, note)).toEqual({ from: 2, to: 3 });
    });

    it("refuses a document that holds a range where an offset belongs", async () => {
      const note = await seed();

      const committed = await commit(
        note,
        (_body, anchors) => anchors.setRawUntyped({ a: { from: 0, to: 1 } }),
      );

      expect(committed.error?.name).toBe("ProtocolError");
      expect(await readAnchors(server, note)).toBeUndefined();
    });

    it("refuses a document that holds an anchor at a negative offset", async () => {
      const note = await seed();

      const committed = await commit(
        note,
        (_body, anchors) => anchors.set({ a: -1 }),
      );

      expect(committed.error?.name).toBe("ProtocolError");
      expect(await readAnchors(server, note)).toBeUndefined();
    });

    it("clears the anchors when the cell is set to `undefined`", async () => {
      const note = await seed();
      await highlightB(note);

      const committed = await commit(
        note,
        (_body, anchors) => anchors.set(undefined),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toBeUndefined();
    });

    it("throws when building a commit that writes the anchors after editing the field", async () => {
      // The commit would carry the write ahead of the edit, so Memory would
      // move anchors stated against the edited text through the edit again.

      const note = await seed();
      await openAsEditor(note);
      const tx = rt.edit();
      note.withTx(tx).key("body").applyChanges({ from: 0, insert: "XYZ" });
      anchorsOf(note, tx).set({ from: 0, to: 3 });

      expect(() => getDirectTransactionNativeCommit(tx, space)).toThrow(
        "after editing it; write them before the edit",
      );
      tx.abort();
    });

    it("moves the anchors a transaction writes before editing the field through that edit", async () => {
      const note = await seed();
      await openAsEditor(note);

      const committed = await commit(note, (body, anchors) => {
        anchors.set({ from: 1, to: 2 });
        body.applyChanges({ from: 0, insert: "XYZ" });
      });

      expect(committed.error).toBeUndefined();
      expect(await readBody(server)).toBe("XYZabc");
      expect(await readAnchors(server, note)).toEqual({ from: 4, to: 5 });
    });

    it("adds one anchor under its id beside those the document holds", async () => {
      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      const committed = await commit(
        note,
        (_body, anchors) => anchors.key("end").set(3),
      );

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toEqual({
        from: 1,
        to: 2,
        end: 3,
      });
    });
  });

  describe("an edit to the field", () => {
    it("keeps an anchor ahead of text inserted at it, and moves one past text inserted before it", async () => {
      // The highlight of `b` runs from the anchor at 1 to the anchor at 2. An
      // insert at 1 lands after the first anchor, inside the highlight.

      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      await type(note, "editor:2", { epoch: 1, version: 1 }, [1, [0, "X"], 2]);

      expect(await readBody(server)).toBe("aXbc");
      expect(await readAnchors(server, note)).toEqual({ from: 1, to: 3 });
    });

    it("leaves the anchors alone when text is inserted at the last one", async () => {
      // An insert at 2 lands after the anchor that ends the highlight of `b`,
      // outside it.

      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      await type(note, "editor:2", { epoch: 1, version: 1 }, [2, [0, "Y"], 1]);

      expect(await readBody(server)).toBe("abYc");
      expect(await readAnchors(server, note)).toEqual({ from: 1, to: 2 });
    });

    it("moves the anchor that ends a region one lower when another session deletes a character inside it", async () => {
      // One session anchors both ends of `abc`; another deletes the `b`.

      const note = await seed();
      await openAsEditor(note);
      await commit(note, (body, anchors) => {
        expect(body.get()).toBe("abc");
        anchors.set({ from: 0, to: 3 });
      });

      await type(note, "editor:2", { epoch: 1, version: 1 }, [1, [1], 1]);

      expect(await readBody(server)).toBe("ac");
      expect(await readAnchors(server, note)).toEqual({ from: 0, to: 2 });
    });

    it("brings both anchors to where deleted text began", async () => {
      const note = await seed();
      await openAsEditor(note);
      await highlightB(note);

      await type(note, "editor:2", { epoch: 1, version: 1 }, [1, [1], 1]);

      expect(await readBody(server)).toBe("ac");
      expect(await readAnchors(server, note)).toEqual({ from: 1, to: 1 });
    });

    it("takes an anchor past the end of the text as one at its end", async () => {
      const note = await seed();
      await openAsEditor(note);
      await commit(note, (_body, anchors) => anchors.set({ far: 99 }));

      await type(note, "editor:2", { epoch: 1, version: 1 }, [[0, "x"], 3]);

      expect(await readBody(server)).toBe("xabc");
      expect(await readAnchors(server, note)).toEqual({ far: 4 });
    });
  });

  describe("anchorsOf", () => {
    /** Runs a pattern whose result names the anchors of `note`'s body. */
    const runAnchored = async (note: Cell<Note>) => {
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
      return result;
    };

    /** Resolves once the anchors `result` names satisfy `test`. */
    const whenAnchors = (
      result: Cell<{ anchors: FieldAnchors | undefined }>,
      test: (anchors: FieldAnchors | undefined) => boolean,
    ): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const cancel = result.key("anchors").sink((anchors) => {
        if (test(anchors)) resolve();
      });
      return promise.then(() => cancel());
    };

    /**
     * Commits `anchors` as the anchors of `note`'s body. The session reads
     * the document through the running pattern, and fan-out is manual, so
     * this does not wait for the server to deliver the commit back.
     */
    const writeAnchors = async (note: Cell<Note>, anchors: FieldAnchors) => {
      const tx = rt.edit();
      anchorsOf(note, tx).set(anchors);
      return await tx.commit({ holdSyncedUntilCovered: false }).verdict;
    };

    it("refuses while the field's document has not arrived, then names its anchors", async () => {
      // The argument links to a note this session has not received, so the
      // chain to its body stops at a document still loading, which may yet
      // hold a link to the field that stores the text.

      const errors: Error[] = [];
      rt.scheduler.onError((error: Error) => errors.push(error));
      const { commonfabric } = createTrustedBuilder(rt);
      const anchored = commonfabric.pattern<{ body: string }>(({ body }) => ({
        anchors: commonfabric.anchorsOf(body),
      }));
      const later = rt.getCell<Note>(
        space,
        "collaborative-anchors-later",
        noteSchema,
      );
      const setup = rt.edit();
      const result = rt.run(
        setup,
        anchored,
        { body: later.key("body") },
        rt.getCell(
          space,
          "collaborative-anchors-later-reader",
          undefined,
          setup,
        ),
      );
      await setup.commit().verdict;
      void result.pull();
      await rt.scheduler.idle();
      // The result's slot redirects to the node's output, which holds the
      // link to the anchors document once the node has sent one.
      const beforeArrival = result.key("anchors").resolveAsCell().getRaw();

      const arrive = rt.edit();
      later.withTx(arrive).set({ title: "Later", body: "ac" });
      await arrive.commit({ holdSyncedUntilCovered: false }).verdict;
      await result.pull();
      const write = rt.edit();
      result.withTx(write).key("anchors").set({ a: 1 });
      const committed = await write.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(beforeArrival).toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
      expect(new Set(errors.map((error) => error.name))).toEqual(
        new Set(["UnresolvedInputError"]),
      );
      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, later)).toEqual({ a: 1 });
    });

    it("throws for a constant, which no document stores", async () => {
      const failed = Promise.withResolvers<Error>();
      rt.scheduler.onError((error: Error) => failed.resolve(error));
      const { commonfabric } = createTrustedBuilder(rt);
      const anchored = commonfabric.pattern<Record<string, never>>(() => ({
        anchors: commonfabric.anchorsOf("constant text"),
      }));
      const setup = rt.edit();
      const result = rt.run(
        setup,
        anchored,
        {},
        rt.getCell(space, "collaborative-anchors-constant", undefined, setup),
      );
      await setup.commit().verdict;
      void result.pull();

      expect((await failed.promise).message).toContain(
        "`anchorsOf()` needs a field stored in a document",
      );
    });

    it("returns `undefined` for a field with no anchors, and then the anchors written", async () => {
      const note = await seed();
      await openAsEditor(note);
      const result = await runAnchored(note);

      expect(result.key("anchors").get()).toBeUndefined();

      const arrived = whenAnchors(result, (anchors) => anchors !== undefined);
      const committed = await writeAnchors(note, { from: 1, to: 2 });
      await arrived;

      expect(committed.error).toBeUndefined();
      expect(result.key("anchors").get()).toEqual({ from: 1, to: 2 });
    });

    it("writes the anchors document through its result", async () => {
      const note = await seed();
      const result = await runAnchored(note);

      const tx = rt.edit();
      result.withTx(tx).key("anchors").set({ a: 1 });
      const committed = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;

      expect(committed.error).toBeUndefined();
      expect(await readAnchors(server, note)).toEqual({ a: 1 });
    });

    it("returns the anchors where an edit from another session left them", async () => {
      const note = await seed();
      await openAsEditor(note);
      const result = await runAnchored(note);
      await writeAnchors(note, { from: 1, to: 2 });

      const moved = whenAnchors(result, (anchors) => anchors?.to === 3);
      await type(note, "editor:2", { epoch: 1, version: 1 }, [1, [0, "X"], 2]);
      // Fan-out is manual, so this session sees the document Memory rewrote
      // once the server delivers it.
      await server.flushSessions();
      await moved;

      expect(result.key("anchors").get()).toEqual({ from: 1, to: 3 });
    });
  });
});
