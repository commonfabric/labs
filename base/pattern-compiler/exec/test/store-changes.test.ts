import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Ref, type Schema, Store } from "../store.ts";

/** The changes a store reports while `run` makes them. */
const changesOf = (store: Store, run: () => void) => {
  const seen: {
    path: readonly string[];
    covers?: readonly string[];
    schema?: Schema;
  }[] = [];
  store.onChange = ({ path, covers, schema }) =>
    seen.push({
      path,
      ...(covers === undefined ? {} : { covers }),
      ...(schema === undefined ? {} : { schema }),
    });
  run();
  store.onChange = undefined;
  return seen;
};

describe("Store", () => {
  describe("the changes it reports", () => {
    it("names the root as covered by a write below a root that held no container", () => {
      const store = new Store({ parts: false });
      store.create("doc", "state", undefined);

      expect(
        changesOf(store, () => store.write(new Ref("doc", ["a", "b"]), 1)),
      ).toEqual([{ path: ["a", "b"], covers: [] }]);
      expect(store.docs.get("doc")?.value).toEqual({ a: { b: 1 } });
    });

    it("names the shortest replaced member as covered by a write below a member that held no container", () => {
      const store = new Store({ parts: false });
      store.create("doc", "state", { a: "text", c: 2 });

      expect(
        changesOf(
          store,
          () => store.write(new Ref("doc", ["a", "b", "x"]), 1),
        ),
      ).toEqual([{ path: ["a", "b", "x"], covers: ["a"] }]);
    });

    it("names nothing as covered by a write below containers that exist", () => {
      const store = new Store({ parts: false });
      store.create("doc", "state", { a: { b: 0 } });

      expect(
        changesOf(store, () => store.write(new Ref("doc", ["a", "b"]), 1)),
      ).toEqual([{ path: ["a", "b"] }]);
    });

    it("gives the schema of the reference a write was made through", () => {
      const store = new Store({ parts: false });
      store.create("doc", "state", { a: "" });
      const schema: Schema = {
        type: "string",
        ifc: { confidentiality: ["alice"] },
      } as Schema;

      expect(
        changesOf(
          store,
          () => store.write(new Ref("doc", ["a"], schema), "x"),
        ),
      ).toEqual([{ path: ["a"], schema }]);
    });
  });

  describe("appendedFrom()", () => {
    const tracked = (value: unknown) => {
      const store = new Store({ parts: false });
      store.create("doc", "state", value);
      store.appended = new Map();
      return store;
    };
    const list = new Ref("doc", ["list"]);

    it("gives the first position of the members that splices at the end of a list added", () => {
      const store = tracked({ list: ["a"] });
      store.splice(list, 1, 0, ["b"]);
      store.splice(list, 2, 0, ["c"]);

      expect(store.appendedFrom(list)).toBe(1);
      expect(store.changedOtherwiseAt(list)).toBe(false);
    });

    it("gives nothing for a list that nothing was added to", () => {
      const store = tracked({ list: ["a"] });

      expect(store.appendedFrom(list)).toBeUndefined();
    });

    it("gives nothing after a removal, and the position of a later addition with the removal noted", () => {
      const store = tracked({ list: ["a"] });
      store.splice(list, 1, 0, ["b"]);
      store.splice(list, 0, 1, []);

      expect(store.appendedFrom(list)).toBeUndefined();

      store.splice(list, 1, 0, ["c"]);

      expect(store.appendedFrom(list)).toBe(1);
      expect(store.changedOtherwiseAt(list)).toBe(true);
    });

    it("gives nothing after a write of the whole list with other members", () => {
      const store = tracked({ list: ["a"] });
      store.splice(list, 1, 0, ["b"]);
      store.write(list, ["b", "a"]);

      expect(store.appendedFrom(list)).toBeUndefined();
    });

    it("takes a write of the whole list with members added at its end as an addition", () => {
      const store = tracked({ list: ["a"] });
      store.write(list, ["a", "b"]);

      expect(store.appendedFrom(list)).toBe(1);
    });

    it("gives nothing after a write of a position at or behind the first added one", () => {
      const store = tracked({ list: ["a"] });
      store.splice(list, 1, 0, ["b"]);
      store.write(list.key("1"), "c");

      expect(store.appendedFrom(list)).toBeUndefined();
    });

    it("keeps the position after a write below a member", () => {
      const store = tracked({ list: [{ done: false }] });
      store.splice(list, 1, 0, [{ done: false }]);
      store.write(list.key("0", "done"), true);

      expect(store.appendedFrom(list)).toBe(1);
    });

    it("gives nothing where the store keeps no track", () => {
      const store = new Store({ parts: false });
      store.create("doc", "state", { list: [] });
      store.splice(list, 0, 0, ["a"]);

      expect(store.appendedFrom(list)).toBeUndefined();
    });
  });
});
