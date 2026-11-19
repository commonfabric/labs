import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defineIndexedCollection,
  defineIndexedCollections,
  indexedCollectionDescriptorOf,
  indexedFieldPath,
  indexedKindOf,
} from "../../../src/builtins/indexed-collection/definition.ts";

describe("definition", () => {
  describe("defineIndexedCollection()", () => {
    it("returns one kind named `members`, and the two tables the runtime keeps", () => {
      const { tables, index } = defineIndexedCollection();

      expect(Object.keys(tables).sort()).toEqual([
        "collection_meta",
        "member_deps",
        "members",
      ]);
      expect(index).toEqual({
        kinds: {
          members: {
            table: "members",
            columns: [],
            relations: [],
            relationTables: {},
            paths: {},
            labels: {},
          },
        },
      });
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

    it("names a relation's table for the relation, indexed on both of its columns", () => {
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
      expect(index.kinds.members.relationTables).toEqual({
        pairsWith: "pairsWith",
      });
    });

    it("records the path of a column or relation read from a nested value", () => {
      const { tables, index } = defineIndexedCollection({
        columns: {
          name: "text",
          bakerName: { type: "text", path: ["baker", "name"] },
        },
        relations: { pairsWith: ["menu", "pairsWith"] },
      });

      expect(tables.members.properties.bakerName.sqlType).toBe("text");
      expect(index.kinds.members.columns).toEqual(["name", "bakerName"]);
      expect(index.kinds.members.paths).toEqual({
        bakerName: ["baker", "name"],
        pairsWith: ["menu", "pairsWith"],
      });
    });

    it("throws on a nested column or relation given no path", () => {
      expect(() =>
        defineIndexedCollection({
          columns: { name: { type: "text", path: [] } },
        })
      ).toThrow("needs a path");
      expect(() => defineIndexedCollection({ relations: { pairsWith: [] } }))
        .toThrow("needs a path");
    });

    it("throws on a field name that is not an identifier", () => {
      expect(() => defineIndexedCollection({ columns: { "a b": "text" } }))
        .toThrow("not an identifier");
      expect(() => defineIndexedCollection({ relations: ["a-b"] }))
        .toThrow("not an identifier");
    });

    it("throws on a relation named for one of the collection's own tables", () => {
      expect(() => defineIndexedCollection({ relations: ["members"] }))
        .toThrow("twice");
      expect(() => defineIndexedCollection({ relations: ["member_deps"] }))
        .toThrow("twice");
      expect(() => defineIndexedCollection({ relations: ["collection_meta"] }))
        .toThrow("twice");
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
      ).toThrow("twice");
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

  describe("defineIndexedCollections()", () => {
    it("names a kind's table for the kind, and a relation's for the kind and the relation", () => {
      const { tables, index } = defineIndexedCollections({
        donuts: { columns: { name: "text" } },
        orders: { columns: { placedAt: "integer" }, relations: ["donut"] },
      });

      expect(Object.keys(tables).sort()).toEqual([
        "collection_meta",
        "donuts",
        "member_deps",
        "orders",
        "orders_donut",
      ]);
      expect(index.kinds.orders).toEqual({
        table: "orders",
        columns: ["placedAt"],
        relations: ["donut"],
        relationTables: { donut: "orders_donut" },
        paths: {},
        labels: {},
      });
    });

    it("throws on two tables that would share a name", () => {
      expect(() =>
        defineIndexedCollections({
          orders: { relations: ["donut"] },
          orders_donut: {},
        })
      ).toThrow("twice");
    });

    it("throws on a declaration with no kind", () => {
      expect(() => defineIndexedCollections({})).toThrow(
        "a declaration per kind",
      );
    });
  });

  describe("indexedKindOf()", () => {
    const { index } = defineIndexedCollections({ donuts: {}, orders: {} });

    it("returns the kind named", () => {
      expect(indexedKindOf(index, "orders").descriptor.table).toBe("orders");
    });

    it("returns the one kind of a collection declared without kinds", () => {
      expect(indexedKindOf(defineIndexedCollection().index, undefined).kind)
        .toBe("members");
    });

    it("throws when several kinds are declared and none is named", () => {
      expect(() => indexedKindOf(index, undefined)).toThrow("several kinds");
    });

    it("throws on a kind that is not declared", () => {
      expect(() => indexedKindOf(index, "bakers")).toThrow(
        "no kind of member",
      );
    });
  });

  describe("indexedFieldPath()", () => {
    it("returns the field of the same name unless a path was declared", () => {
      const { index } = defineIndexedCollection({
        columns: {
          name: "text",
          bakerName: { type: "text", path: ["baker", "name"] },
        },
      });

      expect(indexedFieldPath(index.kinds.members, "name")).toEqual(["name"]);
      expect(indexedFieldPath(index.kinds.members, "bakerName")).toEqual([
        "baker",
        "name",
      ]);
    });
  });

  describe("indexedCollectionDescriptorOf()", () => {
    it("returns the descriptor a handle value carries", () => {
      const { index } = defineIndexedCollection({
        columns: { name: "text" },
        relations: ["pairsWith"],
      });

      expect(indexedCollectionDescriptorOf({ id: "x", index })).toEqual(index);
    });

    it("returns `undefined` for the handle of an ordinary database", () => {
      expect(indexedCollectionDescriptorOf({ id: "x", tables: {} }))
        .toBeUndefined();
      expect(indexedCollectionDescriptorOf(undefined)).toBeUndefined();
    });

    it("returns `undefined` for a descriptor naming anything but identifiers", () => {
      const { index } = defineIndexedCollection({ columns: { name: "text" } });

      expect(
        indexedCollectionDescriptorOf({
          id: "x",
          index: {
            kinds: {
              members: { ...index.kinds.members, columns: ["a b"] },
            },
          },
        }),
      ).toBeUndefined();
      expect(
        indexedCollectionDescriptorOf({
          id: "x",
          index: {
            kinds: {
              members: { ...index.kinds.members, table: "x; drop" },
            },
          },
        }),
      ).toBeUndefined();
    });
  });
});
