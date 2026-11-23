import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Ref, Store, type Undo } from "../store.ts";

type Row = { id: string; title: string; tags: string[] };

const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `i${index}`,
    title: `t${index}`,
    tags: ["a", "b"],
  }));

const listOf = (count: number): Store => {
  const store = new Store({ parts: false });
  store.create("doc", "list", { items: rows(count) });
  return store;
};

const itemsOf = (store: Store): Row[] => store.peek("doc", ["items"]) as Row[];

/** Whether a value and every container in it is frozen. */
const frozenDeep = (value: unknown): boolean =>
  typeof value !== "object" || value === null ||
  (Object.isFrozen(value) && Object.values(value).every(frozenDeep));

describe("Store", () => {
  describe("a write below a stored array", () => {
    it("copies the same number of containers for one member among 10 and among 1,000", () => {
      const copied = [10, 1_000].map((count) => {
        const store = listOf(count);
        const before = store.copiedByWrites;
        store.write(new Ref("doc", ["items", "3", "title"]), "edited");
        return store.copiedByWrites - before;
      });

      // The root record, the array and the member.
      expect(copied).toEqual([3, 3]);
    });

    it("leaves the array it replaced as it was, and shares every member it did not change", () => {
      const store = listOf(5);
      const before = itemsOf(store);
      const titles = before.map(({ title }) => title);

      store.write(new Ref("doc", ["items", "3", "title"]), "edited");
      const after = itemsOf(store);

      expect(before.map(({ title }) => title)).toEqual(titles);
      expect(after[3].title).toBe("edited");
      expect(after).not.toBe(before);
      expect(after[3]).not.toBe(before[3]);
      expect(after[3].tags).toBe(before[3].tags);
      for (const index of [0, 1, 2, 4]) {
        expect(after[index]).toBe(before[index]);
      }
    });

    it("copies nothing and reports no change for a write of the value a path holds", () => {
      const store = listOf(5);
      const before = itemsOf(store);
      const copied = store.copiedByWrites;
      const clock = store.clock;

      store.write(new Ref("doc", ["items", "3"]), {
        tags: ["a", "b"],
        title: "t3",
        id: "i3",
      });

      expect(itemsOf(store)).toBe(before);
      expect(store.copiedByWrites).toBe(copied);
      expect(store.clock).toBe(clock);
    });
  });

  describe("a splice of a stored array", () => {
    it("copies the array and the root alone, among 10 members and among 1,000", () => {
      const copied = [10, 1_000].map((count) => {
        const store = listOf(count);
        const before = store.copiedByWrites;
        store.splice(new Ref("doc", ["items"]), count, 0, rows(1));
        return store.copiedByWrites - before;
      });

      expect(copied).toEqual([2, 2]);
    });

    it("leaves the array it replaced as it was, and shares the members that stay", () => {
      const store = listOf(4);
      const before = itemsOf(store);

      store.splice(new Ref("doc", ["items"]), 1, 2, [{
        id: "n",
        title: "new",
        tags: [],
      }]);
      const after = itemsOf(store);

      expect(before.map(({ id }) => id)).toEqual(["i0", "i1", "i2", "i3"]);
      expect(after.map(({ id }) => id)).toEqual(["i0", "n", "i3"]);
      expect(after[0]).toBe(before[0]);
      expect(after[2]).toBe(before[3]);
    });
  });

  describe("what it holds", () => {
    it("is frozen with every container in it after a create, a write, a splice and a put", () => {
      const store = listOf(3);
      store.write(new Ref("doc", ["items", "0", "extra", "deep"]), { n: 1 });
      store.splice(new Ref("doc", ["items"]), 1, 1, rows(2));
      store.put("doc", ["count"], { of: [1, 2] });

      expect(frozenDeep(store.peek("doc", []))).toBe(true);
      expect(() => {
        itemsOf(store)[0].title = "changed in place";
      }).toThrow(TypeError);
    });

    it("freezes the value a caller wrote and holds that value", () => {
      const store = listOf(1);
      const written = { id: "w", tags: ["x"], title: "w" };

      store.write(new Ref("doc", ["items", "0"]), written);

      expect(itemsOf(store)[0]).toBe(written);
      expect(frozenDeep(written)).toBe(true);
    });

    it("holds the members of a record in the order of the storage", () => {
      const store = new Store({ parts: false });
      store.create("doc", "record", { b: 1, a: { d: 1, c: 2 } });
      store.write(new Ref("doc", ["aa"]), 3);

      expect(Object.keys(store.peek("doc", []) as object)).toEqual([
        "a",
        "aa",
        "b",
      ]);
      expect(Object.keys(store.peek("doc", ["a"]) as object)).toEqual([
        "c",
        "d",
      ]);
    });
  });

  describe("undo()", () => {
    it("puts back what the changes replaced, and a member that a splice took out as the object it was", () => {
      const store = listOf(4);
      const before = itemsOf(store);
      const journal: Undo[] = [];
      store.journal = journal;
      store.write(new Ref("doc", ["items", "1", "title"]), "edited");
      store.splice(new Ref("doc", ["items"]), 0, 2, []);
      store.put("doc", ["count"], 2);
      store.journal = undefined;

      store.undo(journal);
      const after = itemsOf(store);

      expect(store.peek("doc", [])).toEqual({ items: rows(4) });
      // The member at 1 was written below before the splice took it out.
      for (const index of [0, 2, 3]) expect(after[index]).toBe(before[index]);
      expect(frozenDeep(store.peek("doc", []))).toBe(true);
    });
  });
});
