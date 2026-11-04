/**
 * Tests that verify Cell.set() and Cell.setRaw() create isolated copies of
 * values, so that subsequent mutations to the original value don't affect
 * what Cell.get() or Cell.getRaw() returns.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test value isolation");
const space = signer.did();

describe("Cell value isolation", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
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

  describe("mutations to original value after set() should not affect get()", () => {
    it("simple object: mutating original property doesn't affect cell", () => {
      const cell = runtime.getCell<{ foo: string }>(
        space,
        "simple-object-isolation",
        undefined,
        tx,
      );

      const original = { foo: "bar" };
      cell.set(original);

      // Mutate the original
      original.foo = "MUTATED";

      // Cell should still have original value
      expect(cell.get().foo).toBe("bar");
    });

    it("simple object: adding property to original doesn't affect cell", () => {
      const cell = runtime.getCell<{ foo: string; extra?: string }>(
        space,
        "simple-object-add-property",
        undefined,
        tx,
      );

      const original: { foo: string; extra?: string } = { foo: "bar" };
      cell.set(original);

      // Add property to original
      original.extra = "ADDED";

      // Cell should not have the added property
      const result = cell.get();
      expect(result.foo).toBe("bar");
      expect(result.extra).toBeUndefined();
    });

    it("nested object: mutating nested property doesn't affect cell", () => {
      const cell = runtime.getCell<{ outer: { inner: number } }>(
        space,
        "nested-object-isolation",
        undefined,
        tx,
      );

      const original = { outer: { inner: 42 } };
      cell.set(original);

      // Mutate nested property
      original.outer.inner = 999;

      // Cell should still have original value
      expect(cell.get().outer.inner).toBe(42);
    });

    it("nested object: replacing nested object doesn't affect cell", () => {
      const cell = runtime.getCell<{ outer: { inner: number } }>(
        space,
        "nested-object-replace",
        undefined,
        tx,
      );

      const original = { outer: { inner: 42 } };
      cell.set(original);

      // Replace nested object entirely
      original.outer = { inner: 999 };

      // Cell should still have original value
      expect(cell.get().outer.inner).toBe(42);
    });

    it("array: mutating array element doesn't affect cell", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "array-element-isolation",
        undefined,
        tx,
      );

      const original = [1, 2, 3];
      cell.set(original);

      // Mutate array element
      original[1] = 999;

      // Cell should still have original value
      expect(cell.get()).toEqual([1, 2, 3]);
    });

    it("array: pushing to original array doesn't affect cell", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "array-push-isolation",
        undefined,
        tx,
      );

      const original = [1, 2, 3];
      cell.set(original);

      // Push to original array
      original.push(4, 5, 6);

      // Cell should still have original 3 elements
      const result = cell.get();
      expect(result).toEqual([1, 2, 3]);
      expect(result.length).toBe(3);
    });

    it("array: popping from original array doesn't affect cell", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "array-pop-isolation",
        undefined,
        tx,
      );

      const original = [1, 2, 3];
      cell.set(original);

      // Pop from original array
      original.pop();
      original.pop();

      // Cell should still have all 3 elements
      expect(cell.get()).toEqual([1, 2, 3]);
    });

    it("array of objects: mutating object in original array doesn't affect cell", () => {
      const cell = runtime.getCell<Array<{ value: number }>>(
        space,
        "array-object-isolation",
        undefined,
        tx,
      );

      const item1 = { value: 1 };
      const item2 = { value: 2 };
      const original = [item1, item2];
      cell.set(original);

      // Mutate object in original array
      item1.value = 999;
      item2.value = 888;

      // Cell should still have original values
      const result = cell.get();
      expect(result[0].value).toBe(1);
      expect(result[1].value).toBe(2);
    });

    it("deeply nested: mutations at any depth don't affect cell", () => {
      const cell = runtime.getCell<{
        level1: {
          level2: {
            level3: {
              value: string;
            };
          };
        };
      }>(
        space,
        "deep-nesting-isolation",
        undefined,
        tx,
      );

      const original = {
        level1: {
          level2: {
            level3: {
              value: "deep",
            },
          },
        },
      };
      cell.set(original);

      // Mutate at various depths
      original.level1.level2.level3.value = "MUTATED";

      // Cell should still have original value
      expect(cell.get().level1.level2.level3.value).toBe("deep");
    });

    it("mixed structure: complex object with arrays and nesting", () => {
      const cell = runtime.getCell<{
        name: string;
        tags: string[];
        metadata: { count: number };
      }>(
        space,
        "mixed-structure-isolation",
        undefined,
        tx,
      );

      const original = {
        name: "test",
        tags: ["a", "b", "c"],
        metadata: { count: 42 },
      };
      cell.set(original);

      // Mutate everything
      original.name = "MUTATED";
      original.tags.push("d");
      original.tags[0] = "MUTATED";
      original.metadata.count = 999;

      // Cell should have all original values
      const result = cell.get();
      expect(result.name).toBe("test");
      expect(result.tags).toEqual(["a", "b", "c"]);
      expect(result.metadata.count).toBe(42);
    });
  });

  describe("get() returns read-only values", () => {
    it("returned object should be frozen or proxied (throws on mutation)", () => {
      const cell = runtime.getCell<{ foo: string }>(
        space,
        "get-returns-readonly",
        undefined,
        tx,
      );

      cell.set({ foo: "bar" });
      const result = cell.get();

      // QueryResultProxy's set trap throws when writable=false
      expect(() => {
        (result as { foo: string }).foo = "MUTATED";
      }).toThrow();
    });

    it("nested properties in returned object should also be protected", () => {
      const cell = runtime.getCell<{ outer: { inner: number } }>(
        space,
        "get-nested-readonly",
        undefined,
        tx,
      );

      cell.set({ outer: { inner: 42 } });
      const result = cell.get();

      // QueryResultProxy's set trap throws when writable=false
      expect(() => {
        (result.outer as { inner: number }).inner = 999;
      }).toThrow();
    });
  });

  describe("mutations to original value after setRaw() should not affect getRaw()", () => {
    it("simple object: mutating original property doesn't affect cell", () => {
      const cell = runtime.getCell<{ foo: string }>(
        space,
        "setRaw-simple-object-isolation",
        undefined,
        tx,
      );

      const original = { foo: "bar" };
      cell.setRaw(original);

      // Mutate the original
      original.foo = "MUTATED";

      // Cell should still have original value
      expect(cell.getRaw()?.foo).toBe("bar");
    });

    it("nested object: mutating nested property doesn't affect cell", () => {
      const cell = runtime.getCell<{ outer: { inner: number } }>(
        space,
        "setRaw-nested-object-isolation",
        undefined,
        tx,
      );

      const original = { outer: { inner: 42 } };
      cell.setRaw(original);

      // Mutate nested property
      original.outer.inner = 999;

      // Cell should still have original value
      expect(cell.getRaw()?.outer.inner).toBe(42);
    });

    it("array: mutating array element doesn't affect cell", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "setRaw-array-element-isolation",
        undefined,
        tx,
      );

      const original = [1, 2, 3];
      cell.setRaw(original);

      // Mutate array element
      original[1] = 999;

      // Cell should still have original value
      expect(cell.getRaw()).toEqual([1, 2, 3]);
    });

    it("array: pushing to original array doesn't affect cell", () => {
      const cell = runtime.getCell<number[]>(
        space,
        "setRaw-array-push-isolation",
        undefined,
        tx,
      );

      const original = [1, 2, 3];
      cell.setRaw(original);

      // Push to original array
      original.push(4, 5, 6);

      // Cell should still have original 3 elements
      const result = cell.getRaw();
      expect(result).toEqual([1, 2, 3]);
      expect(result?.length).toBe(3);
    });

    it("array of objects: mutating object in original array doesn't affect cell", () => {
      const cell = runtime.getCell<Array<{ value: number }>>(
        space,
        "setRaw-array-object-isolation",
        undefined,
        tx,
      );

      const item1 = { value: 1 };
      const item2 = { value: 2 };
      const original = [item1, item2];
      cell.setRaw(original);

      // Mutate object in original array
      item1.value = 999;
      item2.value = 888;

      // Cell should still have original values
      const result = cell.getRaw();
      expect(result?.[0].value).toBe(1);
      expect(result?.[1].value).toBe(2);
    });

    it("deeply nested: mutations at any depth don't affect cell", () => {
      const cell = runtime.getCell<{
        level1: {
          level2: {
            level3: {
              value: string;
            };
          };
        };
      }>(
        space,
        "setRaw-deep-nesting-isolation",
        undefined,
        tx,
      );

      const original = {
        level1: {
          level2: {
            level3: {
              value: "deep",
            },
          },
        },
      };
      cell.setRaw(original);

      // Mutate at various depths
      original.level1.level2.level3.value = "MUTATED";

      // Cell should still have original value
      expect(cell.getRaw()?.level1.level2.level3.value).toBe("deep");
    });

    it("mixed structure: complex object with arrays and nesting", () => {
      const cell = runtime.getCell<{
        name: string;
        tags: string[];
        metadata: { count: number };
      }>(
        space,
        "setRaw-mixed-structure-isolation",
        undefined,
        tx,
      );

      const original = {
        name: "test",
        tags: ["a", "b", "c"],
        metadata: { count: 42 },
      };
      cell.setRaw(original);

      // Mutate everything
      original.name = "MUTATED";
      original.tags.push("d");
      original.tags[0] = "MUTATED";
      original.metadata.count = 999;

      // Cell should have all original values
      const result = cell.getRaw();
      expect(result?.name).toBe("test");
      expect(result?.tags).toEqual(["a", "b", "c"]);
      expect(result?.metadata.count).toBe(42);
    });
  });
});
