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
});
