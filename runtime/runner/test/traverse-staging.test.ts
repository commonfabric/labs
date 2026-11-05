import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internPathSelector } from "@commonfabric/data-model-schema";

import { MapSetStringToPathSelectors } from "../src/traverse.ts";

describe("MapSetStringToPathSelectors", () => {
  describe("instance members", () => {
    describe("stage()", () => {
      for (const hashing of [false, true]) {
        it(`isolates existing selectors and the permissive index with hashing ${hashing}`, () => {
          const original = new MapSetStringToPathSelectors(hashing);
          const broad = internPathSelector({ path: [], schema: true });
          const narrow = internPathSelector({ path: ["child"], schema: false });
          original.add("root", broad);
          const abandoned = original.stage();
          abandoned.value.deleteValue("root", broad);
          abandoned.value.add("root", narrow);
          expect([...original.values("root")]).toEqual([broad]);
          expect([...original.trueSchemaSelectors("root")]).toEqual([broad]);
          expect([...abandoned.value.trueSchemaSelectors("root")]).toEqual([]);

          const published = original.stage();
          published.value.add("root", narrow);
          expect([...published.value.values("root")][0]).toBe(broad);
          expect([...original.values("root")]).toEqual([broad]);
          const { changedKeys } = published;
          expect([...changedKeys()]).toEqual(["root"]);
          published.commit();
          expect([...original.values("root")]).toEqual([broad, narrow]);
          expect([...original.trueSchemaSelectors("root")]).toEqual([broad]);

          const removal = original.stage();
          removal.value.delete("root");
          removal.commit();
          expect(original.has("root")).toBe(false);
          expect([...original.trueSchemaSelectors("root")]).toEqual([]);
        });
      }
    });
  });
});
