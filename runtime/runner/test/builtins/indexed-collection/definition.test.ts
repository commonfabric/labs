import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defineIndexedCollection,
  indexedCollectionDescriptorOf,
} from "../../../src/builtins/indexed-collection/definition.ts";

describe("definition", () => {
  describe("defineIndexedCollection()", () => {
    it("returns a `members` and a `member_deps` table for an empty declaration", () => {
      const { tables, index } = defineIndexedCollection();

      expect(Object.keys(tables).sort()).toEqual(["member_deps", "members"]);
      expect(index).toEqual({ columns: [], relations: [] });
    });

    it("gives the `members` table a column per mirrored field, after the member reference", () => {
      const { tables } = defineIndexedCollection({
        columns: { name: "text", price: "real" },
      });

      expect(Object.keys(tables.members.properties)).toEqual([
        "member_cf_link",
        "name",
        "price",
      ]);
      expect(tables.members.properties.price.sqlType).toBe("real");
    });

    it("declares the secondary indexes of the `members` table", () => {
      const { tables } = defineIndexedCollection({
        columns: { name: "text", price: "real" },
        indexes: [["price"], ["name", "price"]],
      });

      expect(tables.members.indexes).toEqual([["price"], ["name", "price"]]);
    });

    it("returns a table per relation, indexed on both of its columns", () => {
      const { tables, index } = defineIndexedCollection({
        relations: ["pairsWith"],
      });

      expect(Object.keys(tables.pairsWith.properties)).toEqual([
        "source_cf_link",
        "target_cf_link",
      ]);
      expect(tables.pairsWith.indexes).toEqual([
        ["source_cf_link"],
        ["target_cf_link"],
      ]);
      expect(index.relations).toEqual(["pairsWith"]);
    });

    it("throws on a field name that is not an identifier", () => {
      expect(() => defineIndexedCollection({ columns: { "a b": "text" } }))
        .toThrow("not an identifier");
      expect(() => defineIndexedCollection({ relations: ["a-b"] }))
        .toThrow("not an identifier");
    });

    it("throws on a relation named for one of the collection's own tables", () => {
      expect(() => defineIndexedCollection({ relations: ["members"] }))
        .toThrow("reserved table");
      expect(() => defineIndexedCollection({ relations: ["member_deps"] }))
        .toThrow("reserved table");
    });

    it("throws on a column named for the member reference", () => {
      expect(() =>
        defineIndexedCollection({ columns: { member_cf_link: "text" } })
      ).toThrow("member reference");
    });

    it("throws on a field declared as both a column and a relation", () => {
      expect(() =>
        defineIndexedCollection({
          columns: { pairsWith: "text" },
          relations: ["pairsWith"],
        })
      ).toThrow("declared twice");
    });

    it("throws on an index naming a column that is not mirrored", () => {
      expect(() =>
        defineIndexedCollection({
          columns: { name: "text" },
          indexes: [["price"]],
        })
      ).toThrow("undeclared column");
    });
  });

  describe("indexedCollectionDescriptorOf()", () => {
    it("returns the descriptor a handle value carries", () => {
      const { index } = defineIndexedCollection({
        columns: { name: "text" },
        relations: ["pairsWith"],
      });

      expect(indexedCollectionDescriptorOf({ id: "x", index })).toEqual({
        columns: ["name"],
        relations: ["pairsWith"],
      });
    });

    it("returns `undefined` for the handle of an ordinary database", () => {
      expect(indexedCollectionDescriptorOf({ id: "x", tables: {} }))
        .toBeUndefined();
    });

    it("returns `undefined` for a descriptor whose lists are not lists of names", () => {
      expect(
        indexedCollectionDescriptorOf({
          id: "x",
          index: { columns: [1], relations: [] },
        }),
      ).toBeUndefined();
      expect(indexedCollectionDescriptorOf(undefined)).toBeUndefined();
    });
  });
});
