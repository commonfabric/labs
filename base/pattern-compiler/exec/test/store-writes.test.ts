import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";

import { Ref, sameStored, Store, type Undo } from "../store.ts";

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

    it("keeps a position of the array that holds nothing as one that holds nothing", () => {
      const store = listOf(2);
      store.write(new Ref("doc", ["items", "4"]), rows(1)[0]);

      store.write(new Ref("doc", ["items", "0", "title"]), "edited");
      const after = itemsOf(store);

      expect(after).toHaveLength(5);
      expect(2 in after).toBe(false);
      expect(3 in after).toBe(false);
      expect(after[4].id).toBe("i0");
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

  describe("a primitive of the data model", () => {
    const stamped = (nsec: bigint) => {
      const store = new Store({ parts: false });
      store.create("doc", "stamp", {
        at: new FabricEpochNsec(nsec),
        count: nsec,
        label: "a",
      });
      return store;
    };

    it("is held as the object it was given as, in a record that is frozen", () => {
      const at = new FabricEpochNsec(7n);
      const store = new Store({ parts: false });
      store.create("doc", "stamp", { at, label: "a" });

      const held = store.peek("doc", []) as { at: FabricEpochNsec };

      expect(Object.isFrozen(held)).toBe(true);
      expect(held.at).toBe(at);
      expect(held.at.value).toBe(7n);
    });

    it("is read as a `FabricEpochNsec` of the same time", () => {
      const store = stamped(7n);

      const read = store.read(new Ref("doc", [])) as {
        at: FabricEpochNsec;
        count: bigint;
      };

      expect(read.at).toBeInstanceOf(FabricEpochNsec);
      expect(read.at.value).toBe(7n);
      expect(read.count).toBe(7n);
    });

    it("is replaced by a write of another time, and by a put of one", () => {
      const store = stamped(7n);

      store.write(new Ref("doc", ["at"]), new FabricEpochNsec(8n));
      const written = (store.peek("doc", ["at"]) as FabricEpochNsec).value;
      store.put("doc", ["at"], new FabricEpochNsec(9n));
      const put = (store.peek("doc", ["at"]) as FabricEpochNsec).value;

      expect([written, put]).toEqual([8n, 9n]);
    });

    it("is replaced by a write of another `bigint`", () => {
      const store = stamped(7n);

      store.write(new Ref("doc", ["count"]), 8n);
      store.put("doc", ["label"], 9n);

      expect(store.peek("doc", ["count"])).toBe(8n);
      expect(store.peek("doc", ["label"])).toBe(9n);
    });

    it("copies no container for a write of an equal time", () => {
      const store = stamped(7n);
      const before = store.copiedByWrites;

      store.write(new Ref("doc", ["at"]), new FabricEpochNsec(7n));

      expect(store.copiedByWrites).toBe(before);
    });
  });

  describe("sameStored()", () => {
    it("takes two times of the data model as the same where they hold one time", () => {
      const same = sameStored(
        { at: new FabricEpochNsec(7n) },
        { at: new FabricEpochNsec(7n) },
      );
      const other = sameStored(
        { at: new FabricEpochNsec(7n) },
        { at: new FabricEpochNsec(8n) },
      );
      const record = sameStored(new FabricEpochNsec(7n), {});

      expect([same, other, record]).toEqual([true, false, false]);
    });

    it("takes a `bigint` as the same as an equal `bigint` only", () => {
      const results = [
        sameStored([7n], [7n]),
        sameStored([7n], [8n]),
        sameStored([7n], [7]),
        sameStored([7n], ["7"]),
      ];

      expect(results).toEqual([true, false, false, false]);
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
