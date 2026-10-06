// asCell tests: converting values to cells with and without schemas,
// link resolution, and schema-driven cell creation.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import {
  areNormalizedLinksSame,
  isPrimitiveCellLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("asCell", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should create a simple cell interface", () => {
    const simpleCell = runtime.getCell<{ x: number; y: number }>(
      space,
      "should create a simple cell interface",
      undefined,
      tx,
    );
    simpleCell.set({ x: 1, y: 2 });

    expect(simpleCell.get()).toEqual({ x: 1, y: 2 });

    simpleCell.set({ x: 3, y: 4 });
    expect(simpleCell.get()).toEqual({ x: 3, y: 4 });

    simpleCell.send({ x: 5, y: 6 });
    expect(simpleCell.get()).toEqual({ x: 5, y: 6 });
  });

  it("should create a simple cell for nested properties", () => {
    const c = runtime.getCell<{ nested: { value: number } }>(
      space,
      "should create a simple cell for nested properties",
      undefined,
      tx,
    );
    c.set({ nested: { value: 42 } });
    const nestedCell = c.key("nested").key("value");

    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(c.get()).toEqual({ nested: { value: 100 } });
  });

  it("should support the key method for nested access", () => {
    const simpleCell = runtime.getCell<{ a: { b: { c: number } } }>(
      space,
      "should support the key method for nested access",
      undefined,
      tx,
    );
    simpleCell.set({ a: { b: { c: 42 } } });

    const nestedCell = simpleCell.key("a").key("b").key("c");
    expect(nestedCell.get()).toBe(42);

    nestedCell.set(100);
    expect(simpleCell.get()).toEqual({ a: { b: { c: 100 } } });
  });

  it("should call sink only when the cell changes on the subpath", async () => {
    const c = runtime.getCell<{ a: { b: number; c: number }; d: number }>(
      space,
      "should call sink only when the cell changes on the subpath",
      undefined,
      tx,
    );
    c.set({ a: { b: 42, c: 10 }, d: 5 });
    tx.commit();
    tx = runtime.edit();
    const values: number[] = [];
    c.key("a").key("b").sink((value) => {
      values.push(value);
    });
    expect(values).toEqual([42]); // Initial call
    c.withTx(tx).key("d").set(50);
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).key("a").key("c").set(100);
    tx.commit();
    tx = runtime.edit();
    c.withTx(tx).key("a").key("b").set(42);
    tx.commit();
    tx = runtime.edit();
    expect(values).toEqual([42]); // Didn't get called again
    c.withTx(tx).key("a").key("b").set(300);
    tx.commit();
    await runtime.idle();
    expect(c.get()).toEqual({ a: { b: 300, c: 100 }, d: 50 });
    expect(values).toEqual([42, 300]); // Got called again
  });

  it("does not trigger sink for changes in the same change group", async () => {
    const c = runtime.getCell<number>(
      space,
      "sink-change-group",
      undefined,
      tx,
    );
    c.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const changeGroup = {};
    const values: number[] = [];
    const cancel = c.sink((value) => {
      values.push(value);
    }, { changeGroup });

    await runtime.idle();
    expect(values).toEqual([0]);

    const sameGroupTx = runtime.edit({ changeGroup });
    c.withTx(sameGroupTx).set(1);
    await sameGroupTx.commit().settled;
    await runtime.idle();
    expect(values).toEqual([0]);

    const otherGroupTx = runtime.edit({ changeGroup: {} });
    c.withTx(otherGroupTx).set(2);
    await otherGroupTx.commit().settled;
    await runtime.idle();
    expect(values).toEqual([0, 2]);

    const noGroupTx = runtime.edit();
    c.withTx(noGroupTx).set(3);
    await noGroupTx.commit().settled;
    await runtime.idle();
    expect(values).toEqual([0, 2, 3]);

    cancel();
  });

  it("should trigger sink when linked cell changes and is read during callback", async () => {
    // This test verifies that cell reads happening DURING the sink callback
    // are properly tracked for reactivity. The fix moves txToReactivityLog()
    // to after the callback so that reads like JSON.stringify traversing
    // through linked cells are captured in the subscription.

    // Create an inner cell that will be linked to
    const innerCell = runtime.getCell<{ value: string }>(
      space,
      "sink-callback-reads-inner",
      undefined,
      tx,
    );
    innerCell.set({ value: "initial" });

    // Create a container cell with schema: true (no validation, raw access)
    // that contains a link to the inner cell
    const containerCell = runtime.getCell<{ nested: unknown }>(
      space,
      "sink-callback-reads-container",
      true, // schema: true means no schema validation
      tx,
    );
    containerCell.setRaw({
      nested: innerCell.getAsLink(),
    });

    tx.commit();
    tx = runtime.edit();

    // Track callback invocations - use JSON.stringify to force reading
    // through the link during the callback
    const callbackResults: string[] = [];
    const cancel = containerCell.sink((value) => {
      // This read through the linked cell happens DURING the callback.
      // Before the fix, this read wasn't tracked, so changes to innerCell
      // wouldn't trigger this sink to re-run.
      const serialized = JSON.stringify(value);
      callbackResults.push(serialized);
    });

    // Should have been called once with initial value
    expect(callbackResults.length).toBe(1);
    expect(callbackResults[0]).toContain("initial");

    // Now update the inner cell
    innerCell.withTx(tx).set({ value: "updated" });
    tx.commit();
    tx = runtime.edit();

    await runtime.idle();

    // The sink should have been triggered again because we read through
    // the link during the callback
    expect(callbackResults.length).toBe(2);
    expect(callbackResults[1]).toContain("updated");

    cancel();
  });

  it("behaves correctly when setting a cell to itself", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c);
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, any schema", () => {
    const c = runtime.getCell<{ a: number }>(
      space,
      "behaves correctly when setting a cell to itself, any schema",
      undefined,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get()).toEqual({ a: 1 });
  });

  it("behaves correctly when setting a cell to itself, asCell schema", () => {
    const c = runtime.getCell(
      space,
      "behaves correctly when setting a cell to itself, asCell schema",
      {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
        asCell: ["cell"],
      } as const satisfies JSONSchema,
      tx,
    );
    c.set({ a: 1 });
    c.set(c.get());
    expect(c.get().get()).toEqualIgnoringSymbols({ a: 1 });
  });
});

describe("asCell with schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should validate and transform according to schema", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
      nested: { value: number };
    }>(
      space,
      "should validate and transform according to schema",
      undefined,
      tx,
    );
    c.set({
      name: "test",
      age: 42,
      tags: ["a", "b"],
      nested: {
        value: 123,
      },
    });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        nested: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
        },
      },
      required: ["name", "age", "tags", "nested"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get() as any;

    expect(value.name).toBe("test");
    expect(value.age).toBe(42);
    expect(value.tags).toEqualIgnoringSymbols(["a", "b"]);
    expect(value.nested.value).toBe(123);
  });

  it("should return a Cell for reference properties", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should return a Cell for reference properties",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          asCell: ["cell"],
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(true);

    // The metadata cell should behave like a normal cell
    const metadataValue = value.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle recursive schemas with $ref", () => {
    const c = runtime.getCell<{
      name: string;
      children: Array<{
        name: string;
        children: any[];
      }>;
    }>(
      space,
      "should handle recursive schemas with $ref",
      undefined,
      tx,
    );
    c.set({
      name: "root",
      children: [
        {
          name: "child1",
          children: [],
        },
        {
          name: "child2",
          children: [
            {
              name: "grandchild",
              children: [],
            },
          ],
        },
      ],
    });

    const schema = {
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/Root" },
            },
          },
          required: ["name", "children"],
        },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get();

    expect(value.name).toBe("root");
    expect(value.children[0].name).toBe("child1");
    expect(value.children[1].name).toBe("child2");
    expect(value.children[1].children[0].name).toBe("grandchild");
  });

  it("should propagate schema through key() navigation", () => {
    const c = runtime.getCell<{
      user: {
        profile: {
          name: string;
          settings: {
            theme: string;
            notifications: boolean;
          };
        };
        metadata: {
          id: string;
          type: string;
        };
      };
    }>(
      space,
      "should propagate schema through key() navigation",
      undefined,
      tx,
    );
    c.set({
      user: {
        profile: {
          name: "John",
          settings: {
            theme: "dark",
            notifications: true,
          },
        },
        metadata: {
          id: "123",
          type: "admin",
        },
      },
    });

    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                name: { type: "string" },
                settings: {
                  type: "object",
                  asCell: ["cell"],
                },
              },
              required: ["name", "settings"],
            },
            metadata: {
              type: "object",
              asCell: ["cell"],
            },
          },
          required: ["profile", "metadata"],
        },
      },
      required: ["user"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const userCell = cell.key("user");
    const profileCell = userCell.key("profile");

    const value = profileCell.get();
    expect(value.name).toBe("John");
    expect(isCell(value.settings)).toBe(true);

    // Test that references are preserved through the entire chain
    const userValue = userCell.get();
    expect(isCell(userValue.metadata)).toBe(true);
  });

  it("should fall back to query result proxy when no schema is present", () => {
    const c = runtime.getCell<{
      data: {
        value: number;
        nested: {
          str: string;
        };
      };
    }>(
      space,
      "should fall back to query result proxy when no schema is present",
      undefined,
      tx,
    );
    c.set({
      data: {
        value: 42,
        nested: {
          str: "hello",
        },
      },
    });

    const value = c.get();

    // Should behave like a query result proxy
    expect(value.data.value).toBe(42);
    expect(value.data.nested.str).toBe("hello");
  });

  it("should allow changing schema with asSchema", () => {
    const c = runtime.getCell<{
      id: number;
      metadata: {
        createdAt: string;
        type: string;
      };
    }>(
      space,
      "should allow changing schema with asSchema",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      metadata: {
        createdAt: "2025-01-06",
        type: "user",
      },
    });

    // Start with a schema that doesn't mark metadata as a reference
    const initialSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    // Create a schema that marks metadata as a reference
    const referenceSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        metadata: {
          type: "object",
          properties: {
            createdAt: { type: "string" },
            type: { type: "string" },
          },
          asCell: ["cell"],
        },
      },
      required: ["id", "metadata"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(initialSchema);
    const value = cell.get();

    // With initial schema, metadata is not a Cell
    expect(value.id).toBe(1);
    expect(isCell(value.metadata)).toBe(false);
    expect(value.metadata.createdAt).toBe("2025-01-06");

    // Switch to reference schema
    const referenceCell = cell.asSchema(referenceSchema);
    const refValue = referenceCell.get();

    // Now metadata should be a Cell
    expect(refValue.id).toBe(1);
    expect(isCell(refValue.metadata)).toBe(true);

    // But we can still get the raw value
    const metadataValue = refValue.metadata.get();
    expect(metadataValue.createdAt).toBe("2025-01-06");
    expect(metadataValue.type).toBe("user");
  });

  it("should handle objects with additional properties as references", () => {
    const c = runtime.getCell<{
      id: number;
      context: {
        user: { name: string };
        settings: { theme: string };
        data: { value: number };
      };
    }>(
      space,
      "should handle objects with additional properties as references",
      undefined,
      tx,
    );
    c.set({
      id: 1,
      context: {
        user: { name: "John" },
        settings: { theme: "dark" },
        data: { value: 42 },
      },
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        context: {
          type: "object",
          additionalProperties: {
            type: "object",
            asCell: ["cell"],
          },
        },
      },
      required: ["id", "context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // Regular property works normally
    expect(value.id).toBe(1);

    // Each property in context should be a Cell
    expect(isCell(value.context.user)).toBe(true);
    expect(isCell(value.context.settings)).toBe(true);
    expect(isCell(value.context.data)).toBe(true);

    // But we can still get their values
    expect(value.context.user.get().name).toBe("John");
    expect(value.context.settings.get().theme).toBe("dark");
    expect(value.context.data.get().value).toBe(42);
  });

  it("should handle additional properties with just reference: true", () => {
    const c = runtime.getCell<{
      context: {
        number: number;
        string: string;
        object: { value: number };
        array: number[];
      };
    }>(
      space,
      "should handle additional properties with just reference: true",
      undefined,
      tx,
    );
    c.set({
      context: {
        number: 42,
        string: "hello",
        object: { value: 123 },
        array: [1, 2, 3],
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: ["cell"] },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All properties in context should be Cells regardless of their type
    expect(isCell(value.context.number)).toBe(true);
    expect(isCell(value.context.string)).toBe(true);
    expect(isCell(value.context.object)).toBe(true);
    expect(isCell(value.context.array)).toBe(true);

    // Values should be preserved
    expect(value.context.number.get()).toBe(42);
    expect(value.context.string.get()).toBe("hello");
    expect(value.context.object.get()).toEqual({ value: 123 });
    expect(value.context.array.get()).toEqual([1, 2, 3]);
  });

  it("should handle references in underlying cell", () => {
    // Create a cell with a reference
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle references in underlying cell",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    // Create a cell that uses that reference
    const c = runtime.getCell<{
      context: {
        inner: any;
      };
    }>(
      space,
      "should handle references in underlying cell outer",
      undefined,
      tx,
    );
    c.set({
      context: {
        inner: innerCell,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: ["cell"] },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // The inner reference should be preserved but wrapped in a new Cell
    expect(isCell(value.context.inner)).toBe(true);
    expect(value.context.inner.get().value).toBe(42);

    // Changes to the original cell should propagate
    innerCell.send({ value: 100 });
    expect(value.context.inner.get().value).toBe(100);
  });

  it("should handle all types of references in underlying cell", () => {
    // Create cells with different types of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle all types of references in underlying cell: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });
    const cellRef = innerCell.getAsLink();
    const aliasRef = innerCell.getAsWriteRedirectLink();

    // Create a cell that uses all reference types
    const c = runtime.getCell<{
      context: {
        cell: any;
        reference: any;
        alias: any;
      };
    }>(
      space,
      "should handle all types of references in underlying cell main",
      undefined,
      tx,
    );
    c.set({
      context: {
        cell: innerCell,
        reference: cellRef,
        alias: aliasRef,
      },
    });

    const schema = {
      type: "object",
      properties: {
        context: {
          type: "object",
          additionalProperties: { asCell: ["cell"] },
        },
      },
      required: ["context"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const value = cell.get();

    // All references should be preserved but wrapped in Cells
    expect(isCell(value.context.cell)).toBe(true);
    expect(isCell(value.context.reference)).toBe(true);
    expect(isCell(value.context.alias)).toBe(true);

    // All should point to the same value
    expect(value.context.cell.get().value).toBe(42);
    expect(value.context.reference.get().value).toBe(42);
    expect(value.context.alias.get().value).toBe(42);

    // Changes to the original cell should propagate to all references
    innerCell.send({ value: 100 });
    expect(value.context.cell.get().value).toBe(100);
    expect(value.context.reference.get().value).toBe(100);
    expect(value.context.alias.get().value).toBe(100);
  });

  it("should handle nested references", () => {
    // Create a chain of references
    const innerCell = runtime.getCell<{ value: number }>(
      space,
      "should handle nested references: inner",
      undefined,
      tx,
    );
    innerCell.set({ value: 42 });

    const ref1 = innerCell.getAsLink();

    const ref2Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref2",
      undefined,
      tx,
    );
    ref2Cell.set({ ref: ref1 });
    const ref2 = ref2Cell.key("ref").getAsLink();

    const ref3Cell = runtime.getCell<{ ref: any }>(
      space,
      "should handle nested references: ref3",
      undefined,
      tx,
    );
    ref3Cell.setRaw({ ref: ref2 });
    const ref3 = ref3Cell.key("ref").getAsLink();

    // Create a cell that uses the nested reference
    const cell = runtime.getCell<{
      context: {
        nested: any;
      };
    }>(
      space,
      "should handle nested references main",
      {
        type: "object",
        properties: {
          context: {
            type: "object",
            additionalProperties: { asCell: ["cell"] },
          },
        },
        required: ["context"],
      } as const satisfies JSONSchema,
      tx,
    );
    cell.set({
      context: {
        nested: ref3,
      },
    });

    const value = cell.get() as any;

    // The nested reference should be followed all the way to the inner value
    expect(isCell(value.context.nested)).toBe(true);
    expect(value.context.nested.get().value).toBe(42);

    // Check that exactly the 4 documents in the chain were read (by entity
    // ID; journal read paths are rooted at the document facet, so cells are
    // matched by document id rather than by full link equality).
    const log = txToReactivityLog(tx);
    const readEntityIds = new Set(log.reads.map((r) => r.id));
    expect(readEntityIds.size).toBe(4);
    expect(readEntityIds.has(cell.getAsNormalizedFullLink().id)).toBe(true);
    expect(readEntityIds.has(ref3Cell.getAsNormalizedFullLink().id)).toBe(true);
    expect(readEntityIds.has(ref2Cell.getAsNormalizedFullLink().id)).toBe(true);
    expect(readEntityIds.has(innerCell.getAsNormalizedFullLink().id)).toBe(
      true,
    );

    // Changes to the original cell should propagate through the chain
    innerCell.send({ value: 100 });
    expect(value.context.nested.get().value).toBe(100);
  });

  it("should handle array schemas in key() navigation", () => {
    const c = runtime.getCell<{
      items: Array<{ name: string; value: number }>;
    }>(
      space,
      "should handle array schemas in key() navigation",
      undefined,
      tx,
    );
    c.set({
      items: [
        { name: "item1", value: 1 },
        { name: "item2", value: 2 },
      ],
    });

    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "number" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["items"],
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);
    const itemsCell = cell.key("items");
    const firstItemCell = itemsCell.key(0);
    const secondItemCell = itemsCell.key(1);

    expect(firstItemCell.get()).toEqualIgnoringSymbols({
      name: "item1",
      value: 1,
    });
    expect(secondItemCell.get()).toEqualIgnoringSymbols({
      name: "item2",
      value: 2,
    });
  });

  it("should handle additionalProperties in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra1: { value: 1 },
      extra2: { value: 2 },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional properties
    const extra1Cell = cell.key("extra1");
    const extra2Cell = cell.key("extra2");
    expect(extra1Cell.get()).toEqualIgnoringSymbols({ value: 1 });
    expect(extra2Cell.get()).toEqualIgnoringSymbols({ value: 2 });
  });

  it("should handle additionalProperties: true in key() navigation", () => {
    const c = runtime.getCell<{
      defined: string;
      [key: string]: any;
    }>(
      space,
      "should handle additionalProperties: true in key() navigation",
      undefined,
      tx,
    );
    c.set({
      defined: "known property",
      extra: { anything: "goes" },
    });

    const schema = {
      type: "object",
      properties: {
        defined: { type: "string" },
      },
      additionalProperties: {
        type: "object",
        properties: { anything: { asCell: ["cell"] } },
      },
    } as const satisfies JSONSchema;

    const cell = c.asSchema(schema);

    // Test defined property
    const definedCell = cell.key("defined");
    expect(definedCell.get()).toBe("known property");

    // Test additional property with a schema that generates a reference
    const extraCell = cell.key("extra");
    const extraValue = extraCell.get();
    expect(isCell(extraValue.anything)).toBe(true);
  });

  it("should partially update object values using update method", () => {
    const c = runtime.getCell<{
      name: string;
      age: number;
      tags: string[];
    }>(
      space,
      "should partially update object values using update method",
      undefined,
      tx,
    );
    c.set({ name: "test", age: 42, tags: ["a", "b"] });

    c.update({ age: 43, tags: ["a", "b", "c"] });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
      tags: ["a", "b", "c"],
    });

    // Should preserve unmodified fields
    c.update({ name: "updated" });
    expect(c.get()).toEqual({
      name: "updated",
      age: 43,
      tags: ["a", "b", "c"],
    });
  });

  it("should handle update when there is no previous value", () => {
    const c = runtime.getCell<
      { name: string; age: number } | undefined
    >(
      space,
      "should handle update when there is no previous value",
      undefined,
      tx,
    );
    c.set(undefined);

    c.update({ name: "test", age: 42 });
    expect(c.get()).toEqual({
      name: "test",
      age: 42,
    });

    // Should still work for subsequent updates
    c.update({ age: 43 });
    expect(c.get()).toEqual({
      name: "test",
      age: 43,
    });
  });

  it("should push values to array using push method", () => {
    const c = runtime.getCell<{ items: number[] }>(
      space,
      "push-test",
      undefined,
      tx,
    );
    c.set({ items: [1, 2, 3] });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toEqual([1, 2, 3]);
    arrayCell.push(4);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4]);

    arrayCell.push(5);
    expect(arrayCell.get()).toEqual([1, 2, 3, 4, 5]);
  });

  it("should preserve holes when pushing onto a sparse array", () => {
    const c = runtime.getCell<{ items: number[] }>(
      space,
      "push-sparse-preserve",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const sparse: any[] = new Array(3);
    sparse[0] = 10;
    sparse[2] = 30;
    c.set({ items: sparse });

    const arrayCell = c.key("items");
    arrayCell.push(40);

    const result = arrayCell.get() as number[];
    expect(result.length).toBe(4);
    expect(result[0]).toBe(10);
    expect(1 in result).toBe(false); // original hole preserved
    expect(result[2]).toBe(30);
    expect(result[3]).toBe(40); // pushed element
  });

  it("should throw when pushing values to `null`", () => {
    const c = runtime.getCell<{ items: null }>(
      space,
      "push-to-null",
      undefined,
      tx,
    );
    c.set({ items: null });
    const arrayCell = c.key("items");
    expect(arrayCell.get()).toBeNull();

    // @ts-ignore - types correctly disallowed pushing to non-array
    expect(() => arrayCell.push(1)).toThrow();
  });

  it("should push values to undefined array with schema default", () => {
    const schema = {
      type: "array",
      default: [10, 20],
    } as const satisfies JSONSchema;

    const c = runtime.getCell<{ items?: number[] }>(
      space,
      "push-to-undefined-schema",
      undefined,
      tx,
    );
    c.set({});
    const arrayCell = c.key("items").asSchema(schema);

    arrayCell.push(30);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30]);

    arrayCell.push(40);
    expect(arrayCell.get()).toEqualIgnoringSymbols([10, 20, 30, 40]);
  });

  it("should transparently update ids when context changes", () => {
    const testCell = runtime.getCell<any>(
      space,
      "should transparently update ids when context changes",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            nested: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: "number" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    testCell.set(undefined);

    const initialData = [
      {
        id: "item1",
        name: "First Item",
        nested: [{ id: "nested1", value: 1 }, { id: "nested2", value: 2 }],
      },
      {
        id: "item1",
        name: "Second Item",
        nested: [{ id: "nested1", value: 3 }, { id: "nested2", value: 4 }],
      },
    ];
    const initialDataCopy = JSON.parse(JSON.stringify(initialData));

    const frame1 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 1",
      reactives: new Set(),
    });
    testCell.set(initialDataCopy);
    popFrame(frame1);

    expect(isPrimitiveCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isPrimitiveCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");
    expect(testCell.key("0").key("nested").key("0").key("id").get()).toEqual(
      "nested1",
    );
    expect(testCell.get()[0].nested[0].id).toEqual("nested1");
    expect(testCell.get()[0].nested[1].id).toEqual("nested2");
    expect(testCell.get()[1].nested[0].id).toEqual("nested1");
    expect(testCell.get()[1].nested[1].id).toEqual("nested2");

    const linkFromContext1 = parseLink(testCell.getRaw()[0], testCell)!;

    const returnedData = JSON.parse(JSON.stringify(testCell.get()));

    const frame2 = pushFrame({
      generatedIdCounter: 0,
      cause: "context 2",
      reactives: new Set(),
    });
    testCell.set(returnedData);
    popFrame(frame2);

    expect(isPrimitiveCellLink(testCell.getRaw()[0])).toBe(true);
    expect(isPrimitiveCellLink(testCell.getRaw()[1])).toBe(true);
    expect(testCell.get()[0].name).toEqual("First Item");
    expect(testCell.get()[1].name).toEqual("Second Item");

    // Let's make sure we got a different ids with the different context
    expect(
      areNormalizedLinksSame(
        parseLink(testCell.getRaw()[0], testCell)!,
        linkFromContext1,
      ),
    ).toBe(false);

    expect(testCell.get()).toEqualIgnoringSymbols(initialData);
  });

  it("should push values that are already cells reusing the reference", () => {
    const c = runtime.getCell<{ items: { value: number }[] }>(
      space,
      "should push values that are already cells reusing the reference",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");

    const d = runtime.getCell<{ value: number }>(
      space,
      "should push values that are already cells reusing the reference d",
      undefined,
      tx,
    );
    d.set({ value: 1 });
    const dCell = d;

    arrayCell.push(d);
    arrayCell.push(dCell);
    arrayCell.push(d.getAsQueryResult());

    const rawItems = c.getRaw()?.items;
    const expectedCellLink = d.getAsNormalizedFullLink();
    // parseLink of a stored sigil stamps the read-side data-derived mark
    // (OW51); the source `d` link came off a Cell and does not.
    const expectedDerived = { ...expectedCellLink, viaLinkHop: true as const };

    expect(rawItems?.map((item) => parseLink(item, c))).toEqual([
      expectedDerived,
      expectedDerived,
      expectedDerived,
    ]);
  });

  it("should handle push method on non-array values", () => {
    const c = runtime.getCell<{ value: string }>(
      space,
      "should handle push method on non-array values",
      undefined,
      tx,
    );
    c.set({ value: "not an array" });
    const cell = c.key("value");

    // @ts-ignore - types correctly disallowed pushing to non-array
    expect(() => cell.push(42)).toThrow();
  });

  it("should create new entities when pushing to array in frame", () => {
    const frame = pushFrame();
    const c = runtime.getCell<{ items: any[] }>(
      space,
      "push-with-id",
      undefined,
      tx,
    );
    c.set({ items: [] });
    const arrayCell = c.key("items");
    arrayCell.push({ value: 42 });
    expect(frame.generatedIdCounter).toEqual(1);
    arrayCell.push({ value: 43 });
    expect(frame.generatedIdCounter).toEqual(2);
    popFrame(frame);
    expect(isPrimitiveCellLink(c.getRaw()?.items[0])).toBe(true);
    expect(isPrimitiveCellLink(c.getRaw()?.items[1])).toBe(true);
    expect(arrayCell.get()).toEqualIgnoringSymbols([
      { value: 42 },
      { value: 43 },
    ]);
  });
});
