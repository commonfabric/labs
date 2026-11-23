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
    const keyOf = (store: Store, member: object) =>
      store.addresses.get(member)?.path.at(-1);

    it("forms the keys of the array for its first two reads and for no later one", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(5) });
      const before = store.keyings;

      const first = store.read(new Ref("doc", ["items"])) as object[];
      store.read(new Ref("doc", ["items"]));
      const third = store.read(new Ref("doc", ["items"])) as object[];
      store.read(new Ref("doc", ["items"]));

      expect(store.keyings - before).toBe(2);
      expect(third.map((member) => keyOf(store, member))).toEqual(
        first.map((member) => keyOf(store, member)),
      );
    });

    it("gives a changed member another key and the others the same, with no keys formed again", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(5) });
      const first = store.read(new Ref("doc", ["items"])) as object[];
      store.read(new Ref("doc", ["items"]));
      const keys = first.map((member) => keyOf(store, member));
      const before = store.keyings;

      store.write(new Ref("doc", ["items", "2", "title"]), "edited");
      const second = store.read(new Ref("doc", ["items"])) as object[];
      const now = second.map((member) => keyOf(store, member));

      expect(store.keyings - before).toBe(0);
      expect(now[2]).not.toBe(keys[2]);
      expect(now.filter((_key, index) => index !== 2)).toEqual(
        keys.filter((_key, index) => index !== 2),
      );
    });

    it("forms the keys again for a read under a schema that leaves a member out", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(3) });
      const schema: Schema = {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } } },
      };
      const before = store.keyings;

      store.read(new Ref("doc", ["items"]), undefined, false, schema);
      store.read(new Ref("doc", ["items"]), undefined, false, schema);

      expect(store.keyings - before).toBe(2);
    });

    it("forms the keys twice for three reads under a schema that declares every member", () => {
      const store = new Store({ parts: false });
      store.create("doc", "list", { items: rows(3) });
      const schema: Schema = {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, title: { type: "string" } },
        },
      };
      const before = store.keyings;

      store.read(new Ref("doc", ["items"]), undefined, false, schema);
      store.read(new Ref("doc", ["items"]), undefined, false, schema);
      store.read(new Ref("doc", ["items"]), undefined, false, schema);

      expect(store.keyings - before).toBe(2);
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
