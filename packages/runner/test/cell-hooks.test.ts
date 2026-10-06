// toCell and toReactive hook tests: verifying that objects returned from
// cell.get() can be converted back to cells via Symbol hooks.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { toCell } from "../src/back-to-cell.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("toCell and toReactive hooks", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Basic hook functionality", () => {
    it("should add toCell and toReactive symbols to objects returned from Cell.get()", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-object",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(typeof (result as any)[toCell]).toBe("function");
    });

    it("should add hooks to arrays returned from Cell.get()", () => {
      const schema = {
        type: "array",
        items: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<number[]>(
        space,
        "hook-basic-array",
        schema,
        tx,
      );
      c.set([1, 2, 3]);

      const result = c.get();
      expect(toCell in result).toBe(true);
    });

    it("should not add hooks to primitive values", () => {
      const numberCell = runtime.getCell<number>(
        space,
        "hook-basic-number",
        undefined,
        tx,
      );
      numberCell.set(42);
      const numberResult = numberCell.get();
      expect(toCell in Object(numberResult)).toBe(false);

      const stringCell = runtime.getCell<string>(
        space,
        "hook-basic-string",
        undefined,
        tx,
      );
      stringCell.set("hello");
      const stringResult = stringCell.get();
      expect(toCell in Object(stringResult)).toBe(false);

      const boolCell = runtime.getCell<boolean>(
        space,
        "hook-basic-bool",
        undefined,
        tx,
      );
      boolCell.set(true);
      const boolResult = boolCell.get();
      expect(toCell in Object(boolResult)).toBe(false);
    });

    it("should not add hooks to existing cells", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "hook-basic-inner-cell",
        undefined,
        tx,
      );
      innerCell.set({ inner: 42 });

      const schema = {
        type: "object",
        properties: {
          cell: {},
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ cell: any }>(
        space,
        "hook-basic-outer-cell",
        schema,
        tx,
      );
      c.set({ cell: innerCell });

      const result = c.get();
      // The outer object gets hooks
      expect(toCell in result).toBe(true);

      // When a cell is stored in another cell, it's dereferenced to its value
      // The value itself doesn't have hooks (no schema on inner cell)
      expect(isCell(result.cell)).toBe(false);
      expect(result.cell).toEqual({ inner: 42 });
      expect(toCell in result.cell).toBe(false);
    });

    it("should not add hooks to query result proxies", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-basic-query-result",
        undefined,
        tx,
      );
      c.set({ value: 42 });

      const proxy = c.getAsQueryResult();
      expect(isCellResult(proxy)).toBe(true);
      // Query results don't have the hooks because they're proxies, not plain objects
      expect(toCell in proxy).toBe(false);
    });
  });

  describe("toCell behavior", () => {
    it("should return a cell pointing to the original data", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-basic",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      // The linked cell returns the same result with hooks
      const linkedResult = linkedCell.get();
      // Compare just the value property, not the whole object with symbols
      expect(linkedResult.value).toBe(42);
      expect(linkedCell.equals(c)).toBe(true);
    });

    it("should return cells for nested paths", () => {
      const schema = {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "object",
                properties: {
                  c: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ a: { b: { c: number } } }>(
        space,
        "hook-getcelllink-nested",
        schema,
        tx,
      );
      c.set({ a: { b: { c: 42 } } });

      const nestedValue = c.key("a").key("b").get();
      const linkedCell = (nestedValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.c).toBe(42);
      expect(linkedCell.equals(c.key("a").key("b"))).toBe(true);
    });

    it("should allow mutations through the returned cell", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }>(
        space,
        "hook-getcelllink-mutation",
        schema,
        tx,
      );
      c.set({ value: 42 });

      const result = c.get();
      const linkedCell = (result as any)[toCell]();

      linkedCell.set({ value: 100 });
      const updatedResult = c.get();
      expect(updatedResult.value).toBe(100);
    });

    it("should work with array elements", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ items: { name: string }[] }>(
        space,
        "hook-getcelllink-array",
        schema,
        tx,
      );
      c.set({ items: [{ name: "first" }, { name: "second" }] });

      const itemValue = c.key("items").key(0).get();
      const linkedCell = (itemValue as any)[toCell]();

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.name).toBe("first");

      linkedCell.set({ name: "updated" });
      const updatedItems = c.get().items;
      expect(updatedItems[0].name).toBe("updated");
    });

    it("should maintain the same link with array elements", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ items: { name: string }[] }>(
        space,
        "hook-getcelllink-array",
        schema,
        tx,
      );
      c.set({ items: [{ name: "first" }, { name: "second" }] });

      const itemValue = c.key("items").key(0).get();
      const itemCell = c.key("items").key(0);
      const linkedCell = (itemValue as any)[toCell]();
      expect(linkedCell.getAsNormalizedFullLink()).toEqual(
        itemCell.getAsNormalizedFullLink(),
      );

      expect(isCell(linkedCell)).toBe(true);
      const linkedResult = linkedCell.get();
      expect(linkedResult.name).toBe("first");

      linkedCell.set({ name: "updated" });
      const updatedItems = c.get().items;
      expect(updatedItems[0].name).toBe("updated");
    });
  });

  describe("Pattern integration", () => {
    it("should pass query results for patterns without argumentSchema", () => {
      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-pattern-no-schema",
        undefined,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does when no argumentSchema
      const argument = inputCell.getAsQueryResult([], tx);

      // Should be a proxy, not have hooks
      expect(isCellResult(argument)).toBe(true);
      expect(toCell in argument).toBe(false);
      expect(argument.value).toBe(42);
    });

    it("should pass objects with hooks for patterns with argumentSchema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ value: number }>(
        space,
        "hook-pattern-with-schema",
        schema,
        tx,
      );
      inputCell.set({ value: 42 });

      // Simulate what runner.ts does with argumentSchema
      const argument = inputCell.asSchema(schema).get();

      // Should have hooks
      expect(toCell in argument).toBe(true);
      expect(argument.value).toBe(42);
    });

    it("should allow pattern code to convert back to cells", () => {
      const schema = {
        type: "object",
        properties: {
          data: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const inputCell = runtime.getCell<{ data: string }>(
        space,
        "hook-pattern-convert",
        schema,
        tx,
      );
      inputCell.set({ data: "test" });

      const argument = inputCell.asSchema(schema).get();

      // Pattern code can use toCell to get back to the cell
      const cellFromHook = (argument as any)[toCell]();
      expect(isCell(cellFromHook)).toBe(true);
      const cellResult = cellFromHook.get();
      expect(cellResult.data).toBe("test");

      // Can mutate through the cell
      cellFromHook.set({ data: "updated" });
      const updatedResult = inputCell.get();
      expect(updatedResult.data).toBe("updated");
    });
  });

  describe("Schema interactions", () => {
    it("should add hooks to schema-validated results", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ name: string; age: number }>(
        space,
        "hook-schema-basic",
        schema,
        tx,
      );
      c.set({ name: "John", age: 30 });

      const result = c.get();
      expect(toCell in result).toBe(true);
    });

    it("top level defaults work for cells with undefined value", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number", default: 10 },
        },
        default: { value: 100 },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value?: number }>(
        space,
        "hook-schema-default",
        schema,
        tx,
      );

      const result = c.get();
      expect(result.value).toBe(100);
      expect(toCell in result).toBe(true);
    });

    it("should add hooks to default values from schema", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number", default: 100 },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value?: number }>(
        space,
        "hook-schema-default",
        schema,
        tx,
      );
      c.set({});

      const result = c.get();
      expect(result.value).toBe(100);
      expect(toCell in result).toBe(true);
    });

    it("defaults for missing properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Bob" },
          address: {
            type: "object",
            properties: {
              street: { type: "string", default: "234 Street" },
              city: { type: "string", default: "Citysville" },
            },
            default: {
              street: "123 Street",
              city: "Townsville",
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { name?: string; address?: { street?: string; city?: string } }
      >(
        space,
        "hook-schema-default",
        schema,
        tx,
      );
      c.set({});

      let result = c.get();
      expect(result.name).toBe("Bob");
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Street",
        city: "Townsville",
      });

      c.set({ name: "Ted" });
      result = c.get();
      expect(result.name).toBe("Ted");
      // address missing, so we get the default for the address property
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Street",
        city: "Townsville",
      });

      c.set({ name: "Ted", address: { street: "123 Avenue" } });
      result = c.get();
      expect(result.name).toBe("Ted");
      // address present, but city missing, so we get the default for city
      expect(result.address).toEqualIgnoringSymbols({
        street: "123 Avenue",
        city: "Citysville",
      });
    });

    it("should not double-wrap asCell properties", () => {
      const schema = {
        type: "object",
        properties: {
          regular: { type: "string" },
          cellProp: {
            type: "object",
            properties: { value: { type: "number" } },
            asCell: ["cell"],
          },
        },
        required: ["regular", "cellProp"],
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { regular: string; cellProp: { value: number } }
      >(
        space,
        "hook-schema-ascell",
        schema,
        tx,
      );
      c.set({ regular: "test", cellProp: { value: 42 } });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);

      // cellProp should be a cell, not have hooks
      expect(isCell(result.cellProp)).toBe(true);
      // Cells themselves have toReactive (part of Cell interface) but not toCell
      expect(toCell in result.cellProp).toBe(false);
    });

    it("should add hooks to additionalProperties results", () => {
      const schema = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        additionalProperties: { type: "number" },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ known: string; [key: string]: any }>(
        space,
        "hook-schema-additional",
        schema,
        tx,
      );
      c.set({ known: "test", extra1: 10, extra2: 20 });

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);
      expect(result.extra1).toBe(10);
      expect(result.extra2).toBe(20);
    });

    it("should add hooks to array items", () => {
      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ value: number }[]>(
        space,
        "hook-schema-array",
        schema,
        tx,
      );
      c.set([{ value: 1 }, { value: 2 }]);

      const result = c.asSchema(schema).get();
      expect(toCell in result).toBe(true);

      // Each item should also have hooks
      expect(toCell in result[0]).toBe(true);
      expect(toCell in result[1]).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle null and undefined values", () => {
      const schema = {
        type: "object",
        properties: {
          nullable: { type: ["string", "null"] },
          optional: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{ nullable: string | null; optional?: string }>(
        space,
        "hook-edge-null",
        schema,
        tx,
      );
      c.set({ nullable: null });

      const result = c.get();
      expect(toCell in result).toBe(true);
      expect(result.nullable).toBe(null);
      expect(result.optional).toBeUndefined();
    });

    it("should handle empty objects and arrays", () => {
      const schema = {
        type: "object",
        properties: {
          emptyObj: { type: "object" },
          emptyArr: { type: "array" },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<
        { emptyObj: Record<string, never>; emptyArr: any[] }
      >(
        space,
        "hook-edge-empty",
        schema,
        tx,
      );
      c.set({ emptyObj: {}, emptyArr: [] });

      const result = c.get();
      expect(toCell in result).toBe(true);

      // Empty objects and arrays should also have hooks
      expect(toCell in result.emptyObj).toBe(true);
      expect(toCell in result.emptyArr).toBe(true);
    });

    it("should handle deeply nested structures", () => {
      const schema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "object",
                    properties: {
                      value: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<any>(
        space,
        "hook-edge-deep",
        schema,
        tx,
      );
      c.set({
        level1: {
          level2: {
            level3: {
              value: 42,
            },
          },
        },
      });

      const result = c.get();

      // Each level should have hooks
      expect(toCell in result).toBe(true);
      expect(toCell in result.level1).toBe(true);
      expect(toCell in result.level1.level2).toBe(true);
      expect(toCell in result.level1.level2.level3).toBe(true);

      // Can navigate to deep cells
      const deepCell = (result.level1.level2.level3 as any)[toCell]();
      expect(isCell(deepCell)).toBe(true);
      expect(deepCell.get().value).toBe(42);
    });
  });
});

describe("toCell and toReactive hooks: circular references", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle circular references gracefully", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            name: { type: "string" },
            self: { $ref: "#/$defs/Root" },
          },
        },
      },
    } as const satisfies JSONSchema;

    const c = runtime.getCell<any>(
      space,
      "hook-edge-circular",
      schema,
      tx,
    );

    const data: any = { name: "circular" };
    data.self = data;
    c.set(data);

    const result = c.get();
    expect(toCell in result).toBe(true);
    expect(result.name).toBe("circular");
    // With circular references, the self reference points back to the
    // same data.
    expect(result.self.name).toBe("circular");
    // Can navigate infinitely.
    expect(result.self.self.name).toBe("circular");
  });
});
