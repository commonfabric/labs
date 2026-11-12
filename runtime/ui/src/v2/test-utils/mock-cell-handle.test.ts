import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CellHandle, CellReadRefusedError } from "@commonfabric/runtime-client";

import {
  countSubscriptions,
  createMockCellHandle,
  failResolutions,
  holdReads,
  holdWrites,
  pushRefusal,
  pushUpdate,
  refuseReads,
  writesSent,
} from "./mock-cell-handle.ts";
import { createRenderableCellHandle } from "./mock-vdom-connection.ts";

describe("mock-cell-handle", () => {
  describe("createMockCellHandle()", () => {
    describe("a child's `set()`", () => {
      it("writes the value into the root that holds one", async () => {
        const root = createMockCellHandle<{ a: number; b: number }>({
          a: 0,
          b: 2,
        });
        await root.key("a").set(1);
        expect(root.get()).toEqual({ a: 1, b: 2 });
      });

      it("writes the value into an array the root holds", async () => {
        const root = createMockCellHandle<{ list: number[] }>({ list: [1, 2] });
        await root.key("list").key(1).set(5);
        expect(root.get()).toEqual({ list: [1, 5] });
      });

      it("leaves a root that has read nothing unread", async () => {
        const root = createMockCellHandle<{ a: number }>();
        await root.key("a").set(1);
        expect(root.lastRead()).toEqual({ unread: true });
      });
    });

    describe("`resolveAsCell()`", () => {
      it("returns the cell a stored link names", async () => {
        const root = createMockCellHandle<{ a: unknown }>({
          a: { $link: { id: "of:linked" } },
        });
        const resolved = await root.key("a").resolveAsCell();
        expect(resolved.ref()).toEqual({
          id: "of:linked",
          space: "did:key:mock",
          scope: "space",
          path: [],
          schema: undefined,
        });
      });

      it("returns the asking cell where its path runs past the value", async () => {
        const root = createMockCellHandle<
          Record<string, Record<string, number>>
        >(
          {},
        );
        const asking = root.key("a").key("b");
        const resolved = await asking.resolveAsCell();
        expect(resolved.ref()).toEqual(asking.ref());
      });
    });
  });

  describe("runtime()", () => {
    it("finds no piece", async () => {
      const handle = createMockCellHandle(0);
      expect(await handle.runtime().getPiece("of:piece", "did:key:mock"))
        .toBeNull();
    });
  });

  describe("writesSent()", () => {
    it("returns the writes sent through the handle and those reached from it", async () => {
      const root = createMockCellHandle<{ a: number }>({ a: 0 });
      await root.set({ a: 1 });
      await root.key("a").set(2);
      expect(writesSent(root).map(({ type, value }) => ({ type, value })))
        .toEqual([
          { type: "cell:set", value: { a: 1 } },
          { type: "cell:set", value: 2 },
        ]);
    });

    it("throws, naming itself, for a handle the mock did not make", () => {
      const { cell } = createRenderableCellHandle({ a: 0 });
      expect(() => writesSent(cell)).toThrow(
        "writesSent() takes a handle createMockCellHandle() made",
      );
      expect(() => holdReads(cell)).toThrow(
        "holdReads() takes a handle createMockCellHandle() made",
      );
    });
  });

  describe("holdReads()", () => {
    it("answers the reads it held with the answer it is given", async () => {
      const handle = createMockCellHandle<number>();
      const answer = holdReads(handle);
      const read = handle.pull();
      expect(handle.lastRead()).toEqual({ unread: true });
      answer({ value: 5 });
      expect(await read).toBe(5);
    });

    it("fails the reads it held with the error it is given", async () => {
      const handle = createMockCellHandle<number>();
      const answer = holdReads(handle);
      const read = handle.pull();
      answer(new Error("the worker went away"));
      await expect(read).rejects.toThrow("the worker went away");
    });

    it("lets reads through once it has answered", async () => {
      const handle = createMockCellHandle<number>();
      holdReads(handle)({ value: 5 });
      expect(await handle.pull()).toBeUndefined();
    });
  });

  describe("holdWrites()", () => {
    it("leaves a child's write out of the root until it lets it through", async () => {
      const root = createMockCellHandle<{ a: number }>({ a: 0 });
      const release = holdWrites(root);
      const write = root.key("a").set(1);
      await Promise.resolve();
      expect(root.get()).toEqual({ a: 0 });
      release();
      await write;
      expect(root.get()).toEqual({ a: 1 });
    });
  });

  describe("refuseReads()", () => {
    it("refuses every read, by the display ceiling unless told otherwise", async () => {
      const handle = createMockCellHandle<number>();
      refuseReads(handle);
      await expect(handle.pull()).rejects.toBeInstanceOf(CellReadRefusedError);
      expect(handle.lastRead()).toEqual({
        refused: { refusedBy: "display-ceiling" },
      });
    });
  });

  describe("failResolutions()", () => {
    it("fails every resolution", async () => {
      const handle = createMockCellHandle(0);
      failResolutions(handle);
      await expect(handle.resolveAsCell()).rejects.toThrow(
        "the cell cannot be resolved",
      );
    });
  });

  describe("pushRefusal()", () => {
    it("reaches the handle and the others subscribed to its cell", () => {
      const handle = createMockCellHandle<number>(0);
      const other = new CellHandle<number>(handle.runtime(), handle.ref(), {
        value: 0,
      });
      const heard: string[] = [];
      for (
        const [name, each] of [["handle", handle], ["other", other]] as const
      ) {
        each.subscribe(() => {}, {
          onRefused: ({ refusedBy }) => heard.push(`${name}: ${refusedBy}`),
        });
      }
      pushRefusal(handle);
      expect(heard).toEqual([
        "handle: display-ceiling",
        "other: display-ceiling",
      ]);
    });
  });

  describe("countSubscriptions()", () => {
    it("returns the subscriptions held on the handle and the reads asked of it", async () => {
      const handle = createMockCellHandle(0);
      const count = countSubscriptions(handle);
      const cancelFirst = handle.subscribe(() => {}, { onRefused: () => {} });
      handle.subscribe(() => {}, { onRefused: () => {} });
      await handle.pull({ awaitDurability: false });
      expect(count).toEqual({ live: 2, reads: 1 });
      cancelFirst();
      expect(count).toEqual({ live: 1, reads: 1 });
    });

    it("leaves the subscriptions working as before", () => {
      const handle = createMockCellHandle(0);
      countSubscriptions(handle);
      const heard: number[] = [];
      const cancel = handle.subscribe((value) => {
        heard.push(value ?? -1);
      }, { onRefused: () => {} });
      pushUpdate(handle, 1);
      cancel();
      pushUpdate(handle, 2);
      expect(heard).toEqual([0, 1]);
    });
  });

  describe("pushUpdate()", () => {
    it("reaches the handles subscribed to the same path, and only those", () => {
      const handle = createMockCellHandle<number>(0, { path: ["a/b"] });
      const subscribedAt = (path: string[]) => {
        const other = new CellHandle<number>(
          handle.runtime(),
          { ...handle.ref(), path },
          { value: 0 },
        );
        other.subscribe(() => {}, { onRefused: () => {} });
        return other;
      };
      const samePath = subscribedAt(["a/b"]);
      const splitPath = subscribedAt(["a", "b"]);
      pushUpdate(handle, 1);
      expect(samePath.get()).toBe(1);
      expect(splitPath.get()).toBe(0);
    });
  });
});
