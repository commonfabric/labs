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
