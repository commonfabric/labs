import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CellImpl } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator optional link");
const space = signer.did();

describe("Cell with Optional Link", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe(".for() method", () => {
    it("should allow setting a cause on a cell", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);
      const cause = { type: "test-cause" };

      const result = cell.for(cause);

      // Should return the cell for chaining
      expect(result).toBe(cell);
    });

    it("should throw error if link already exists (default behavior)", () => {
      const existingCell = runtime.getCell<number>(
        space,
        "test-cell-with-link",
        undefined,
        tx,
      );
      existingCell.set(42);

      const cause = { type: "test-cause" };

      // Should throw by default
      expect(() => existingCell.for(cause)).toThrow(
        "Cannot set cause: cell already has a cause or link",
      );

      // Cell should still work normally
      expect(existingCell.get()).toBe(42);
    });

    it("should allow allowIfSet option to treat as suggestion", () => {
      const existingCell = runtime.getCell<number>(
        space,
        "test-cell-allow",
        undefined,
        tx,
      );
      existingCell.set(42);

      const cause = { type: "test-cause" };
      const result = existingCell.for(cause, true); // allowIfSet = true

      // Should return the cell for chaining without throwing
      expect(result).toBe(existingCell);
      // Cell should still work normally
      expect(existingCell.get()).toBe(42);
    });

    it("should support method chaining", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);
      const cause = { type: "test-cause" };

      // Chain .for() and .key()
      const result = cell.for(cause).key("foo");

      // Should return a cell (even without link)
      expect(result).toBeDefined();
    });

    describe("reserved cause keys", () => {
      it("rejects a top-level $generated key in record causes", () => {
        const cell = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(() => cell.for({ $generated: 0 })).toThrow(
          'top-level key "$generated" is reserved',
        );
        const cell2 = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(() => cell2.for({ $kind: "stream", $generated: 1 })).toThrow(
          "is reserved",
        );
      });

      it("reserves only $generated, not other $-prefixed keys", () => {
        // Every builder-minted cause carries `$generated`, so a cause without
        // it can never collide with one — other sigil-looking keys stay legal.
        const cell = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(cell.for({ $kind: "stream" })).toBe(cell);
        const cell2 = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(cell2.for({ $anythingElse: true })).toBe(cell2);
      });

      it("allows $generated nested below the top level", () => {
        const cell = new CellImpl(runtime, tx, { path: [], space }, false);
        // Nested keys can never collide with the flat generated causes
        expect(cell.for({ outer: { $generated: 0 } })).toBe(cell);
      });

      it("leaves non-record causes untouched", () => {
        const a = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(a.for("$generated")).toBe(a); // a string, not a record key
        const b = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(b.for(["$generated", 0])).toBe(b); // array elements aren't keys
        const c = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(c.for(42)).toBe(c);
      });

      it("stays a silent no-op when the cause is already set (allowIfSet)", () => {
        const existingCell = runtime.getCell<number>(
          space,
          "test-cell-reserved-ignored",
          undefined,
          tx,
        );
        existingCell.set(42);

        // The reserved cause never takes effect on this cell, so the
        // suggestion path stays a no-op rather than throwing.
        const result = existingCell.for({ $generated: 0 }, true);
        expect(result).toBe(existingCell);
        expect(existingCell.get()).toBe(42);
      });

      it("rejects reserved keys on a fresh cell even with allowIfSet", () => {
        const cell = new CellImpl(runtime, tx, { path: [], space }, false);
        expect(() => cell.for({ $generated: 0 }, true)).toThrow(
          "is reserved",
        );
      });
    });
  });

  describe(".key() without link", () => {
    it("should allow chaining .key() on cell without link", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);
      const cause = { type: "test-cause" };

      const child = cell.for(cause).key("foo");

      // Should create a child cell without throwing
      expect(child).toBeDefined();
    });

    it("should allow nested .key() calls without link", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);
      const cause = { type: "test-cause" };

      const nestedChild = cell.for(cause).key("foo").key("bar").key("baz");

      // Should create nested cells without throwing
      expect(nestedChild).toBeDefined();
    });

    it("should inherit cause from parent when using .key()", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);
      const cause = { type: "test-cause" };

      cell.for(cause);
      const child = cell.key("foo");

      // Child should inherit the cause
      // We can't directly test private fields, but we can verify it doesn't throw
      expect(child).toBeDefined();
    });
  });

  describe("ensureLink() error handling", () => {
    it("throws naming the missing space for a cell whose link and frame both lack one", () => {
      const cell = new CellImpl(runtime, tx);

      expect(() => cell.get()).toThrow(
        "Cannot create cell link - space required",
      );
    });

    it("should take space from link if no id provided", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);

      // Even without id provided, take space from link.
      expect(cell.space).toEqual(space);
    });

    it("should take space from frame if no id provided", () => {
      const frame = pushFrame({
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const cell = new CellImpl(runtime, tx);

      // Take space from frame.
      expect(cell.space).toEqual(space);

      popFrame(frame);
    });

    it("should not throw error when accessing path without cause", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);

      expect(cell.path).toEqual([]);
    });

    it("should create link when accessing cell with cause and space", () => {
      const cause = { type: "test-cause" };

      const frame = pushFrame({
        cause: { type: "lift-cause" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const cell = new CellImpl(runtime, tx);

      cell.for(cause);

      // With both cause and space, link should be created automatically
      expect(cell.space).toBe(space);
      expect(cell.path).toEqual([]);

      popFrame(frame);
    });

    it("should create link using frame cause when in handler context", () => {
      // Create a frame with a cause
      const frame = pushFrame({
        cause: { type: "handler-cause" },
        space,
        inHandler: true,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      try {
        const cell = new CellImpl(runtime, tx);

        // With frame cause and space, link should be created automatically
        expect(cell.space).toBe(space);
        expect(cell.path).toEqual([]);
      } finally {
        popFrame(frame);
      }
    });
  });

  describe("CellImpl backward compatibility", () => {
    it("should work with existing link-based cells", () => {
      const cell = runtime.getCell<{ value: number; nested?: number }>(
        space,
        "backward-compat-test",
        undefined,
        tx,
      );

      cell.set({ value: 100 });
      expect(cell.get()).toEqual({ value: 100 });

      const child = cell.key("nested");
      child.set(200);
      expect(child.get()).toBe(200);
    });

    it("should handle .for() on cells with existing links gracefully", () => {
      const cell = runtime.getCell<number>(
        space,
        "for-on-existing-link",
        undefined,
        tx,
      );

      cell.set(42);

      // Should not affect the cell
      cell.for({ type: "ignored-cause" }, true);

      expect(cell.get()).toBe(42);
    });
  });

  describe("Error messages", () => {
    it("should provide helpful error when cell is passed to .set() without link", () => {
      const targetCell = runtime.getCell<any>(
        space,
        "target-cell",
        undefined,
        tx,
      );
      const cellWithoutLink = new CellImpl(
        runtime,
        tx,
        { path: [], space },
        false,
      );

      // When trying to convert cellWithoutLink to a link, it should throw
      expect(() => targetCell.set(cellWithoutLink)).toThrow();
    });

    it("should suggest using .for() in error messages", () => {
      const cell = new CellImpl(runtime, tx, { path: [], space }, false);

      const frame = pushFrame({
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      try {
        cell.get();
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain(".for(cause)");
        expect(error.message).toContain("cause");
      } finally {
        popFrame(frame);
      }
    });
  });

  describe("Stream cells with optional links", () => {
    it("should handle streams created through CellImpl", () => {
      // Create a stream cell
      const streamCell = runtime.getCell<unknown>(
        space,
        "test-stream",
        { asCell: ["stream"] },
        tx,
      );

      const receivedEvents: any[] = [];
      streamCell.sink((event: any) => {
        receivedEvents.push(event);
      });

      streamCell.send({ type: "test-event" });

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0]).toEqual({ type: "test-event" });
    });
  });

  describe("Sibling cells share link creation", () => {
    it("should share cause across siblings created with .asSchema()", () => {
      const cause = { type: "shared-cause" };

      const frame = pushFrame({
        cause: { type: "frame-cause" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const cell1 = new CellImpl(runtime, tx);
      const cell2 = cell1.asSchema({ type: "object" });

      // Set cause on cell2
      cell2.for(cause);

      try {
        // Both should now have the same entity ID
        const id1 = cell1.entityId;
        const id2 = cell2.entityId;

        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
        expect(id1).toEqual(id2);
      } finally {
        popFrame(frame);
      }
    });

    it("should share cause across siblings created with .withTx()", () => {
      const cause = { type: "shared-cause" };

      const frame = pushFrame({
        cause: { type: "frame-cause" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const cell1 = new CellImpl(runtime, tx);
      const cell2 = cell1.withTx(tx);

      // Set cause on cell1
      cell1.for(cause);

      try {
        // Both should now have the same entity ID
        const id1 = cell1.entityId;
        const id2 = cell2.entityId;

        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
        expect(id1).toEqual(id2);
      } finally {
        popFrame(frame);
      }
    });

    it("should share link creation across siblings", () => {
      const cause = { type: "shared-cause" };

      const frame = pushFrame({
        cause: { type: "frame-cause" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const cell1 = new CellImpl(runtime, tx);
      const cell2 = cell1.asSchema({ type: "object" });
      const cell3 = cell2.withTx(tx);

      // Set cause on cell3
      cell3.for(cause);

      try {
        // All three should have the same entity ID and space
        const id1 = cell1.entityId;
        const id2 = cell2.entityId;
        const id3 = cell3.entityId;

        expect(id1).toEqual(id2);
        expect(id2).toEqual(id3);

        // Accessing space on any sibling should work
        expect(cell1.space).toBe(space);
        expect(cell2.space).toBe(space);
        expect(cell3.space).toBe(space);
      } finally {
        popFrame(frame);
      }
    });

    it("should share cause with children created via .key()", () => {
      const parentFrame = pushFrame({
        cause: { type: "first-frame" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const parent = new CellImpl(runtime, tx);

      const cause = { type: "parent-cause" };

      const childFrame = pushFrame({
        cause: { type: "second-frame" },
        space,
        generatedIdCounter: 0,
        reactives: new Set(),
      });

      const child = parent.key("child");

      // Set cause on parent
      parent.for(cause);

      try {
        // Parent and child should have same entity IDs
        const parentId = parent.entityId;
        const childId = child.entityId;

        expect(parentId).toBeDefined();
        expect(childId).toBeDefined();
        expect(parentId).toEqual(childId);
      } finally {
        popFrame(childFrame);
        popFrame(parentFrame);
      }
    });
  });
});
