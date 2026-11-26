import { expect } from "@std/expect";
import {
  defineIndexedCollections,
  indexedCollectionDescriptorOf,
  indexedFieldPath,
  indexedKindOf,
} from "../../../src/builtins/indexed-collection/definition.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("definition", () => {
  describe("defineIndexedCollections()", () => {
    it("returns a table per kind, and the two tables the runtime keeps", () => {
      const { tables, index } = defineIndexedCollections({ donuts: {} });

      expect(Object.keys(tables).sort()).toEqual([
        "collection_meta",
        "donuts",
        "member_deps",
      ]);
      expect(index).toEqual({
        kinds: {
          donuts: {
            table: "donuts",
            columns: [],
            relations: [],
            relationTables: {},
            paths: {},
            labels: {},
          },
        },
      });
    });

    it("gives a kind's table a column per mirrored field, after the member reference", () => {
      const { tables } = defineIndexedCollections({
        donuts: { columns: { name: "text", price: "real" } },
      });

      expect(Object.keys(tables.donuts.properties)).toEqual([
        "member_cf_link",
        "name",
        "price",
      ]);
      expect(tables.donuts.properties.price.sqlType).toBe("real");
    });

    it("declares the secondary indexes of a kind's table", () => {
      const { tables } = defineIndexedCollections({
        donuts: {
          columns: { name: "text", price: "real" },
          indexes: [["price"], ["name", "price"]],
        },
      });

      expect(tables.donuts.indexes).toEqual([["price"], ["name", "price"]]);
    });

    it("names a relation's table for the kind and the relation, indexed on both of its columns", () => {
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
      expect(Object.keys(tables.orders_donut.properties)).toEqual([
        "source_cf_link",
        "target_cf_link",
      ]);
      expect(tables.orders_donut.indexes).toEqual([
        ["source_cf_link"],
        ["target_cf_link"],
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

    it("records the path of a column or relation read from a nested value", () => {
      const { tables, index } = defineIndexedCollections({
        donuts: {
          columns: {
            name: "text",
            bakerName: { type: "text", path: ["baker", "name"] },
          },
          relations: { pairsWith: ["menu", "pairsWith"] },
        },
      });

      expect(tables.donuts.properties.bakerName.sqlType).toBe("text");
      expect(index.kinds.donuts.columns).toEqual(["name", "bakerName"]);
      expect(index.kinds.donuts.paths).toEqual({
        bakerName: ["baker", "name"],
        pairsWith: ["menu", "pairsWith"],
      });
    });

    it("throws on a nested column or relation given no path", () => {
      expect(() =>
        defineIndexedCollections({
          donuts: { columns: { name: { type: "text", path: [] } } },
        })
      ).toThrow("needs a path");
      expect(() =>
        defineIndexedCollections({ donuts: { relations: { pairsWith: [] } } })
      ).toThrow("needs a path");
    });

    it("throws on a field name that is not an identifier", () => {
      expect(() =>
        defineIndexedCollections({ donuts: { columns: { "a b": "text" } } })
      ).toThrow("not an identifier");
      expect(() => defineIndexedCollections({ donuts: { relations: ["a-b"] } }))
        .toThrow("not an identifier");
    });

    it("throws on a name that an object reads as its prototype", () => {
      expect(() => defineIndexedCollections({ ["__proto__"]: {} }))
        .toThrow("not an identifier");
      expect(() =>
        defineIndexedCollections({
          donuts: { columns: { ["__proto__"]: "text" } },
        })
      ).toThrow("not an identifier");
    });

    it("throws on a kind named for one of the collection's own tables", () => {
      expect(() => defineIndexedCollections({ member_deps: {} }))
        .toThrow("twice");
      expect(() => defineIndexedCollections({ collection_meta: {} }))
        .toThrow("twice");
    });

    it("throws on a column named for the member reference", () => {
      expect(() =>
        defineIndexedCollections({
          donuts: { columns: { member_cf_link: "text" } },
        })
      ).toThrow("member reference");
    });

    it("throws on a field declared as both a column and a relation", () => {
      expect(() =>
        defineIndexedCollections({
          donuts: {
            columns: { pairsWith: "text" },
            relations: ["pairsWith"],
          },
        })
      ).toThrow("twice");
    });

    it("throws on an index naming a column that is not mirrored", () => {
      expect(() =>
        defineIndexedCollections({
          donuts: { columns: { name: "text" }, indexes: [["price"]] },
        })
      ).toThrow("undeclared column");
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

    it("throws on a kind that is not declared", () => {
      expect(() => indexedKindOf(index, "bakers")).toThrow(
        "no kind of member",
      );
    });
  });

  describe("indexedFieldPath()", () => {
    it("returns the field of the same name unless a path was declared", () => {
      const { index } = defineIndexedCollections({
        donuts: {
          columns: {
            name: "text",
            bakerName: { type: "text", path: ["baker", "name"] },
          },
        },
      });

      expect(indexedFieldPath(index.kinds.donuts, "name")).toEqual(["name"]);
      expect(indexedFieldPath(index.kinds.donuts, "bakerName")).toEqual([
        "baker",
        "name",
      ]);
    });
  });

  describe("indexedCollectionDescriptorOf()", () => {
    it("returns the descriptor a handle value carries", () => {
      const { index } = defineIndexedCollections({
        donuts: { columns: { name: "text" }, relations: ["pairsWith"] },
      });

      expect(indexedCollectionDescriptorOf({ id: "x", index })).toEqual(index);
    });

    it("returns `undefined` for the handle of an ordinary database", () => {
      expect(indexedCollectionDescriptorOf({ id: "x", tables: {} }))
        .toBeUndefined();
      expect(indexedCollectionDescriptorOf(undefined)).toBeUndefined();
    });

    it("returns `undefined` for a descriptor naming anything but identifiers", () => {
      const { index } = defineIndexedCollections({
        donuts: { columns: { name: "text" } },
      });

      expect(
        indexedCollectionDescriptorOf({
          id: "x",
          index: {
            kinds: {
              donuts: { ...index.kinds.donuts, columns: ["a b"] },
            },
          },
        }),
      ).toBeUndefined();
      expect(
        indexedCollectionDescriptorOf({
          id: "x",
          index: {
            kinds: {
              donuts: { ...index.kinds.donuts, table: "x; drop" },
            },
          },
        }),
      ).toBeUndefined();
    });
  });
});
