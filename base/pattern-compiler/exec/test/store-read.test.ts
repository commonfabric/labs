import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Ref, type Schema, Store } from "../store.ts";

const link = (doc: string) => ({ $link: { doc, path: [] } });

describe("Store", () => {
  describe("a read that follows links", () => {
    it("gives a document that two links of one read lead to as one value", () => {
      // Each of 20 documents links to the two before it, as the mentions
      // of Topics do: the read follows each document once.
      const store = new Store({ parts: false });
      for (let index = 0; index < 20; index++) {
        store.create(`topic-${index}`, "topic", {
          title: `t${index}`,
          mentions: [index - 1, index - 2].filter((at) => at >= 0).map((at) =>
            link(`topic-${at}`)
          ),
        });
      }

      const top = store.read(new Ref("topic-19", [])) as {
        mentions: { mentions: unknown[] }[];
      };

      expect(top.mentions[0].mentions[0]).toBe(top.mentions[1]);
    });
  });

  describe("a read of an array of plain records in place", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `i${index}`,
        title: `t${index}`,
      }));
    const declared: Schema = {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" } },
      },
    };
    /** The key each member of what a read gave has in its address. */
    const keysOf = (store: Store, read: object[]) => {
      const below = new Map<object, Ref>();
      const handed = store.handed.get(read);
      if (handed !== undefined) store.addressesBelow(read, handed, below);
      return read.map((member) =>
        (store.addresses.get(member) ?? below.get(member))?.path.at(-1)
      );
    };

    it("gives the frozen array the store holds, and copies no container, among 10 members and among 1,000", () => {
      for (const count of [10, 1_000]) {
        const store = new Store({ parts: false });
        store.create("doc", "list", { items: rows(count) });
        const before = store.copiedByReads;

        const read = store.read(new Ref("doc", ["items"]));

        expect(read).toBe(store.peek("doc", ["items"]));
        expect(Object.isFrozen(read)).toBe(true);
        expect(store.copiedByReads - before).toBe(0);
      }
    });

    it("gives the array the store holds under a schema that declares every member, and examines no member again after a write of one", () => {
      const examined = [10, 1_000].map((count) => {
        const store = new Store({ parts: false });
        store.create("doc", "list", { items: rows(count) });
        const ref = new Ref("doc", ["items"]);
        store.read(ref, undefined, false, declared);
        store.write(new Ref("doc", ["items", "3", "title"]), "edited");
        const before = store.membersExamined;
        const copied = store.copiedByReads;

        const read = store.read(ref, undefined, false, declared);

        expect(read).toBe(store.peek("doc", ["items"]));
        expect(store.copiedByReads - copied).toBe(0);
        return store.membersExamined - before;
      });

      expect(examined).toEqual([0, 0]);
    });

    it("gives a value read before a write as it was read", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(3) });
      const before = store.read(new Ref("doc", ["items"])) as {
        title: string;
      }[];

      store.write(new Ref("doc", ["items", "1", "title"]), "edited");
      const after = store.read(new Ref("doc", ["items"])) as {
        title: string;
      }[];

      expect(before.map(({ title }) => title)).toEqual(["t0", "t1", "t2"]);
      expect(after.map(({ title }) => title)).toEqual(["t0", "edited", "t2"]);
      expect(after[0]).toBe(before[0]);
    });

    it("names where the array was read from, and forms no key for the read", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(5) });
      const before = store.keyings;

      const read = store.read(new Ref("doc", ["items"])) as object[];

      expect(store.keyings - before).toBe(0);
      expect(store.handed.get(read)?.at.doc).toBe("doc");
      expect(store.handed.get(read)?.at.path).toEqual(["items"]);
    });

    it("names a member that is stepped to from the array by the key of the member", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(3) });
      const read = store.read(new Ref("doc", [])) as { items: object[] };

      store.handMember(read, "items", read.items);
      store.handMember(read.items, "1", read.items[1]);

      expect(store.handed.get(read.items)?.at.path).toEqual(["items"]);
      expect(store.handed.get(read.items[1])?.at.path).toEqual([
        "items",
        keysOf(store, read.items)[1],
      ]);
    });

    it("forms the keys of the array for the first two askings of the addresses below it and for no later one", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(5) });
      const read = store.read(new Ref("doc", ["items"])) as object[];
      const before = store.keyings;

      const first = keysOf(store, read);
      keysOf(store, read);
      const third = keysOf(store, read);
      keysOf(store, read);

      expect(store.keyings - before).toBe(2);
      expect(new Set(first).size).toBe(5);
      expect(third).toEqual(first);
    });

    it("gives a changed member another key and the others the same, with no keys formed again", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(5) });
      const first = store.read(new Ref("doc", ["items"])) as object[];
      keysOf(store, first);
      const keys = keysOf(store, first);
      const before = store.keyings;

      store.write(new Ref("doc", ["items", "2", "title"]), "edited");
      const second = store.read(new Ref("doc", ["items"])) as object[];
      const now = keysOf(store, second);

      expect(store.keyings - before).toBe(0);
      expect(now[2]).not.toBe(keys[2]);
      expect(now.filter((_key, index) => index !== 2)).toEqual(
        keys.filter((_key, index) => index !== 2),
      );
    });

    it("copies the array, and forms its keys again, for a read under a schema that leaves a member out", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(3) });
      const schema: Schema = {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } } },
      };
      const before = store.keyings;

      const read = store.read(
        new Ref("doc", ["items"]),
        undefined,
        false,
        schema,
      );
      store.read(new Ref("doc", ["items"]), undefined, false, schema);

      expect(read).toEqual([{ id: "i0" }, { id: "i1" }, { id: "i2" }]);
      expect(read).not.toBe(store.peek("doc", ["items"]));
      expect(store.keyings - before).toBe(2);
    });

    it("copies the array for a read under a schema that declares a default a member lacks", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(2) });
      const schema: Schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            done: { type: "boolean", default: false },
          },
        },
      };

      const read = store.read(
        new Ref("doc", ["items"]),
        undefined,
        false,
        schema,
      );

      expect(read).toEqual([
        { id: "i0", title: "t0", done: false },
        { id: "i1", title: "t1", done: false },
      ]);
      expect(read).not.toBe(store.peek("doc", ["items"]));
    });

    it("copies the array for a read through a handle", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(2) });

      const read = store.read(new Ref("doc", ["items"]), undefined, true);

      expect(read).toEqual(rows(2));
      expect(read).not.toBe(store.peek("doc", ["items"]));
      expect(Object.isFrozen(read)).toBe(false);
    });
  });

  describe("a read of an array of links", () => {
    it("copies the array, and gives each document a link leads to as the object the store holds", () => {
      const store = new Store({ parts: false });
      store.create("a", "row", { title: "a" });
      store.create("b", "row", { title: "b" });
      store.create("doc", "list", { items: [link("a"), link("b")] });

      const read = store.read(new Ref("doc", ["items"])) as object[];

      expect(read).toEqual([{ title: "a" }, { title: "b" }]);
      expect(read).not.toBe(store.peek("doc", ["items"]));
      expect(read[0]).toBe(store.peek("a", []));
      expect(store.handed.get(read[1])?.at.doc).toBe("b");
    });
  });

  describe("a read under a schema", () => {
    it("leaves out a member the schema does not declare and gives a reference stand-in at `unknown`", () => {
      const store = new Store({ parts: false });
      store.create("target", "topic", { title: "t" });
      store.create("doc", "row", {
        name: "a",
        extra: 1,
        topic: link("target"),
      });
      const schema: Schema = {
        type: "object",
        properties: { name: { type: "string" }, topic: {} },
      };

      const read = store.read(new Ref("doc", []), undefined, false, schema) as {
        topic: object;
      };

      expect(read).toEqual({ name: "a", topic: {} });
      expect(store.addresses.get(read.topic)?.doc).toBe("target");
    });
  });
});
