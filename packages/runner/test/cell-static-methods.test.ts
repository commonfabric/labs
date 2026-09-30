import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import "@commonfabric/utils/equal-ignoring-symbols";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * Helper to run code within a lift/pattern context (inHandler: false)
 * In this context, cells need explicit causes to create links
 */
function withinLiftContext<T>(
  runtime: Runtime,
  space: string,
  tx: IExtendedStorageTransaction,
  fn: () => T,
): T {
  const frame = {
    runtime,
    space,
    tx,
    cause: { test: "lift context" },
    generatedIdCounter: 0,
    inHandler: false, // Lift/pattern context
    unsafe_binding: { space, tx },
  };

  const pushed = pushFrame(frame as any);
  try {
    return fn();
  } finally {
    popFrame(pushed);
  }
}

/**
 * Helper to run code within a handler context (inHandler: true)
 * In this context, cells can create links without explicit causes
 */
function withinHandlerContext<T>(
  runtime: Runtime,
  space: string,
  tx: IExtendedStorageTransaction,
  fn: () => T,
): T {
  const frame = {
    runtime,
    space,
    tx,
    cause: { test: "handler context" },
    generatedIdCounter: 0,
    inHandler: true, // Handler context - allows cells to create links
    unsafe_binding: { space, tx },
  };

  const pushed = pushFrame(frame as any);
  try {
    return fn();
  } finally {
    popFrame(pushed);
  }
}

describe("Cell Static Methods", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ Cell } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("cell constructors", () => {
    it("should create a cell with a primitive value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = new Cell(42);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(42);
      });
    });

    it("should create cells for every cell constructor", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const { commonfabric } = createTrustedBuilder(runtime);
        const constructors = [
          commonfabric.Cell,
          commonfabric.Writable,
          commonfabric.OpaqueCell,
          commonfabric.Stream,
          commonfabric.ComparableCell,
          commonfabric.ReadonlyCell,
          commonfabric.WriteonlyCell,
        ] as Array<new (value?: string, schema?: JSONSchema) => any>;

        for (const constructor of constructors) {
          const cell = new constructor("Ada", { type: "string" }) as any;
          expect(cell.schema).toEqual({
            type: "string",
            default: "Ada",
          });
        }
      });
    });

    it("should create scoped cells with defaults", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const { commonfabric } = createTrustedBuilder(runtime);
        const cell = new commonfabric.Writable.perUser("Ada", {
          type: "string",
        }) as any;

        expect(cell.schema).toEqual({
          type: "string",
          scope: "user",
          default: "Ada",
        });
      });
    });

    it("should support constructor results chained with .for()", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = new Cell("Ada", { type: "string" }).for("name") as any;

        expect(cell.get()).toBe("Ada");
        expect(cell.getAsNormalizedFullLink()).toBeDefined();
        expect(cell.schema).toEqual({
          type: "string",
          default: "Ada",
        });
      });
    });
  });

  describe("Cell.of()", () => {
    it("should create a cell with a primitive value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(42);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(42);
      });
    });

    it("should create a cell with a string value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of("hello");
        expect(cell).toBeDefined();
        expect(cell.get()).toBe("hello");
      });
    });

    it("should create a cell with an object value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const obj = { x: 1, y: 2 };
        const cell = Cell.of(obj);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(obj);
      });
    });

    it("should create a cell with an array value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const arr = [1, 2, 3];
        const cell = Cell.of(arr);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(arr);
      });
    });

    it("should create a cell with null value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(null);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(null);
      });
    });

    //
    // The static-data walk over special objects
    //
    // The static-data validation walk descends anything `typeof === "object"`,
    // which admits a `FabricSpecialObject`. A `FabricPrimitive` survives it
    // because it has zero enumerable own properties: `Object.keys()` is empty,
    // the descent ends there, and the walk only ever reads -- it never
    // rebuilds. A `FabricInstance` is refused instead, its codec contents being
    // able to hold a `Cell` the walk would never reach by property name.
    // Nothing guards either, so these pin both.
    //

    it("should accept a `FabricBytes` in static data", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

        expect(Cell.of({ payload: bytes }).get().payload).toBeInstanceOf(
          FabricBytes,
        );
      });
    });

    it("should reject a `FabricError` in static data", () => {
      // An instance's codec contents can hold a `Cell`, which is exactly what
      // this validation rejects, and those contents are not reachable by
      // property name. Passing one through _smuggles_ a cell past the check --
      // the validation failing open -- so it refuses instead.
      withinHandlerContext(runtime, space, tx, () => {
        const failure = FabricError.fromNativeError(new Error("boom"));

        expect(() => Cell.of({ failure })).toThrow(
          "Cannot yet handle `FabricError` (a `FabricInstance`) in " +
            "`Cell.of()` static data.",
        );
      });
    });

    it("should reject a wrapped `Cell` on the wrapper, not by finding it", () => {
      // Wrapping a `Cell` is not a way around the rejection -- but note WHERE
      // the refusal comes from. `validateStaticData()` stops at the
      // `FabricInstance` and never reads its codec contents, so the cell
      // inside is never inspected: this passes with an empty extras bag just
      // as well. What it pins is that the escape route is closed, and the
      // asserted message names the wrapper so the reason cannot drift to
      // something this test would not actually detect.
      withinHandlerContext(runtime, space, tx, () => {
        const held = Cell.of("hi");
        expect(() => Cell.of({ c: held })).toThrow();

        const wrapped = new FabricError({
          type: "Error",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { held: held as unknown as FabricValue },
        });
        expect(() => Cell.of({ w: wrapped })).toThrow(
          "(a `FabricInstance`) in `Cell.of()` static data.",
        );
      });
    });

    it("should accept the same `FabricBytes` at two paths", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Every branch that ends a descent must still clear the ancestor it
        // recorded. One that did not would leave the value an ancestor for the
        // rest of the walk, and the second position holding it would be
        // reported as a circular reference.
        const shared = new FabricBytes(new Uint8Array([7]));

        expect(() => Cell.of({ a: shared, b: shared })).not.toThrow();
      });
    });

    //
    // More `Cell.of()` cases
    //
    // The values it takes, and the cell it hands back.
    //

    it("should create a cell with undefined value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(undefined);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(undefined);
      });
    });

    it("should create a cell with boolean value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(true);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(true);
      });
    });

    it("should create cells with different types", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const numCell = Cell.of(123);
        const strCell = Cell.of("test");
        const objCell = Cell.of({ a: 1 });

        expect(numCell.get()).toBe(123);
        expect(strCell.get()).toBe("test");
        expect(objCell.get()).toEqual({ a: 1 });
      });
    });

    it("rejects direct array callback helpers", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of([1, 2, 3]) as any;

        expect(() => cell.map(() => 1)).toThrow("Reactive.map(fn)");
        expect(() => cell.filter(() => true)).toThrow(
          "Reactive.filter(fn)",
        );
        expect(() => cell.flatMap(() => [1])).toThrow(
          "Reactive.flatMap(fn)",
        );
      });
    });

    it("should allow updating the cell after creation", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(10);
        expect(cell.get()).toBe(10);

        cell.set(20);
        expect(cell.get()).toBe(20);
      });
    });

    it("should preserve complex nested objects", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const complex = {
          name: "test",
          nested: {
            array: [1, 2, 3],
            bool: true,
          },
        };
        const cell = Cell.of(complex);
        expect(cell.get()).toEqual(complex);
      });
    });

    //
    // The schema parameter
    //

    it("should accept a schema as second parameter", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = { type: "string" as const, minLength: 3 };
        const cell = Cell.of("hello", schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe("hello");
      });
    });

    it("should merge value into provided schema", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = { type: "number" as const, minimum: 0, maximum: 100 };
        const cell = Cell.of(42, schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(42);
      });
    });

    it("should handle complex schema with value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            age: { type: "number" as const },
          },
          required: ["name"],
        };
        const value = { name: "Alice", age: 30 };
        const cell = Cell.of(value, schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(value);
      });
    });
  });

  describe("Cell.for()", () => {
    it("should create a cell with a cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cause = { id: "test-cause" };
        const cell = Cell.for(cause);
        expect(cell).toBeDefined();
      });
    });

    it("should create a cell with string cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for("my-cause");
        expect(cell).toBeDefined();
      });
    });

    it("should create a cell with object cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cause = { type: "user-action", id: 123 };
        const cell = Cell.for(cause);
        expect(cell).toBeDefined();
      });
    });

    it("should create cells with different causes", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell1 = Cell.for("cause1");
        const cell2 = Cell.for("cause2");

        expect(cell1).toBeDefined();
        expect(cell2).toBeDefined();
        // They should be different cells
        expect(cell1).not.toBe(cell2);
      });
    });

    it("should allow setting values on cell created with .for()", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<number>("test");
        cell.set(42);
        expect(cell.get()).toBe(42);
      });
    });

    it("should support chaining .for() with value assignment", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<string>("cause");
        cell.set("value");
        expect(cell.get()).toBe("value");
      });
    });

    it("should support chaining .for() with .asSchema()", () => {
      withinLiftContext(runtime, space, tx, () => {
        const schema = { type: "string" as const, minLength: 3 };
        const cell = Cell.for("my-cause").asSchema(schema);
        expect(cell).toBeDefined();
      });
    });
  });

  describe("scoped cell constructors", () => {
    it("should create scoped cells with defaults for every cell constructor", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const { commonfabric } = createTrustedBuilder(runtime);
        const constructors = [
          commonfabric.Cell,
          commonfabric.Writable,
          commonfabric.OpaqueCell,
          commonfabric.Stream,
          commonfabric.ComparableCell,
          commonfabric.ReadonlyCell,
          commonfabric.WriteonlyCell,
        ];

        for (const constructor of constructors) {
          const cell = constructor.perUser.of("Ada", {
            type: "string",
          }) as any;
          expect(cell.schema).toEqual({
            type: "string",
            scope: "user",
            default: "Ada",
          });
        }
      });
    });

    it("should create scoped cells with causes", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.perSession.for<string>("draft") as any;
        expect(cell).toBeDefined();
        expect(cell.schema).toEqual({ scope: "session" });
      });
    });

    it("should apply schema scopes to plain constructor links", () => {
      withinLiftContext(runtime, space, tx, () => {
        const { commonfabric } = createTrustedBuilder(runtime);
        const cell = commonfabric.Writable.of("Ada", {
          type: "string",
          scope: "user",
        } as JSONSchema).for("contextual", true) as any;

        expect(cell.getAsNormalizedFullLink().scope).toBe("user");
      });
    });

    it("should reject conflicting schema scopes", () => {
      withinHandlerContext(runtime, space, tx, () => {
        expect(() =>
          Cell.perUser.of("Ada", {
            type: "string",
            scope: "space",
          } as JSONSchema)
        ).toThrow('Cannot use perUser with schema scope "space".');
      });
    });
  });

  describe("Cell.equals()", () => {
    it("should return true for the same cell", () => {
      const cell = runtime.getCell<number>(
        space,
        "test-cell",
        undefined,
        tx,
      );
      expect(Cell.equals(cell, cell)).toBe(true);
    });

    it("should return false for different cells", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "cell1",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "cell2",
        undefined,
        tx,
      );
      expect(Cell.equals(cell1, cell2)).toBe(false);
    });

    it("should return true for cells with same link", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      expect(Cell.equals(cell1, cell2)).toBe(true);
    });

    it("should handle comparison with non-cell objects", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      const obj = { some: "object" };
      // Should not throw, returns false
      expect(Cell.equals(cell, obj)).toBe(false);
    });

    it("should handle comparison of two plain objects", () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 1 };
      // Plain objects are not cells, so equals should return false
      expect(Cell.equals(obj1, obj2)).toBe(false);
    });

    it("should handle null and undefined", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      expect(Cell.equals(cell, null as any)).toBe(false);
      expect(Cell.equals(null as any, cell)).toBe(false);
      expect(Cell.equals(undefined, undefined)).toBe(false);
    });

    it("should resolve links before comparing", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create a target cell with a value
        const targetCell = runtime.getCell<number>(
          space,
          "target",
          undefined,
          tx,
        );
        targetCell.set(42);

        // Create a cell that links to the target
        const linkingCell = runtime.getCell<number>(
          space,
          "linking",
          undefined,
          tx,
        );
        linkingCell.set(targetCell);

        // After resolving, linkingCell should point to same location as targetCell
        expect(Cell.equals(linkingCell, targetCell)).toBe(true);
      });
    });

    it("should handle chains of links", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create chain: cell1 -> cell2 -> cell3 (with value)
        const cell3 = runtime.getCell<number>(space, "cell3", undefined, tx);
        cell3.set(100);

        const cell2 = runtime.getCell<number>(space, "cell2", undefined, tx);
        cell2.set(cell3);

        const cell1 = runtime.getCell<number>(space, "cell1", undefined, tx);
        cell1.set(cell2);

        // All should resolve to the same final location
        expect(Cell.equals(cell1, cell3)).toBe(true);
        expect(Cell.equals(cell2, cell3)).toBe(true);
        expect(Cell.equals(cell1, cell2)).toBe(true);
      });
    });
  });

  describe("Cell.equalLinks()", () => {
    it("should return true for the same cell", () => {
      const cell = runtime.getCell<number>(
        space,
        "test-cell",
        undefined,
        tx,
      );
      expect(Cell.equalLinks(cell, cell)).toBe(true);
    });

    it("should return false for different cells", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "cell1",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "cell2",
        undefined,
        tx,
      );
      expect(Cell.equalLinks(cell1, cell2)).toBe(false);
    });

    it("should return true for cells with same link", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      expect(Cell.equalLinks(cell1, cell2)).toBe(true);
    });

    it("should NOT resolve links before comparing", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create a target cell with a value
        const targetCell = runtime.getCell<number>(
          space,
          "target",
          undefined,
          tx,
        );
        targetCell.set(42);

        // Create a cell that links to the target
        const linkingCell = runtime.getCell<number>(
          space,
          "linking",
          undefined,
          tx,
        );
        linkingCell.set(targetCell);

        // Without resolving, these should be different
        expect(Cell.equalLinks(linkingCell, targetCell)).toBe(false);
      });
    });

    it("should return false when both cells link to the same target but are different cells", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const targetCell = runtime.getCell<number>(
          space,
          "target",
          undefined,
          tx,
        );
        targetCell.set(42);

        const linkCell1 = runtime.getCell<number>(
          space,
          "link1",
          undefined,
          tx,
        );
        linkCell1.set(targetCell);

        const linkCell2 = runtime.getCell<number>(
          space,
          "link2",
          undefined,
          tx,
        );
        linkCell2.set(targetCell);

        // linkCell1 and linkCell2 are different cells, so equalLinks returns false
        expect(Cell.equalLinks(linkCell1, linkCell2)).toBe(false);
      });
    });

    it("should handle chains of links without resolving", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create chain: cell1 -> cell2 -> cell3
        const cell3 = runtime.getCell<number>(space, "cell3", undefined, tx);
        cell3.set(100);

        const cell2 = runtime.getCell<number>(space, "cell2", undefined, tx);
        cell2.set(cell3);

        const cell1 = runtime.getCell<number>(space, "cell1", undefined, tx);
        cell1.set(cell2);

        // Without resolving, these should all be different
        expect(Cell.equalLinks(cell1, cell3)).toBe(false);
        expect(Cell.equalLinks(cell2, cell3)).toBe(false);
        // cell1 links to cell2, so they're different
        expect(Cell.equalLinks(cell1, cell2)).toBe(false);
      });
    });

    it("should handle null and undefined", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      expect(Cell.equalLinks(cell, null as any)).toBe(false);
      expect(Cell.equalLinks(null as any, cell)).toBe(false);
      expect(Cell.equalLinks(undefined, undefined)).toBe(false);
    });

    it("should handle comparison with non-cell objects", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      const obj = { some: "object" };
      expect(Cell.equalLinks(cell, obj)).toBe(false);
    });
  });

  describe("Integration tests", () => {
    it("should work with Cell.of() and Cell.equals()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell1 = Cell.of(100);
        const cell2 = Cell.of(100);

        // Different cells even with same value
        expect(Cell.equals(cell1, cell2)).toBe(false);

        // Same cell reference
        expect(Cell.equals(cell1, cell1)).toBe(true);
      });
    });

    it("should combine .of() and then update value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(
          { count: 0 },
          {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          } as const satisfies JSONSchema,
        );
        expect(cell.get()).toEqual({ count: 0 });

        cell.update({ count: 1 });
        expect(cell.get()).toEqual({ count: 1 });
      });
    });

    it("should work with arrays using .of()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of([1, 2, 3]);
        expect(cell.get()).toEqual([1, 2, 3]);

        cell.push(4);
        expect(cell.get()).toEqual([1, 2, 3, 4]);
      });
    });

    it("should allow .for() followed by value operations", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<{ name: string }>("user-cell");
        cell.set({ name: "Alice" });

        expect(cell.get()).toEqual({ name: "Alice" });

        cell.update({ name: "Bob" });
        expect(cell.get()).toEqual({ name: "Bob" });
      });
    });

    it("should handle type inference with .of()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // TypeScript should infer the type
        const numCell = Cell.of(42);
        const strCell = Cell.of("hello");
        const objCell = Cell.of({ x: 1, y: 2 });

        // These should all work without type errors
        numCell.set(100);
        strCell.set("world");
        objCell.set({ x: 10, y: 20 });
      });
    });

    it("should support explicit type parameters with .for()", () => {
      withinLiftContext(runtime, space, tx, () => {
        interface User {
          id: number;
          name: string;
        }

        const userCell = Cell.for<User>("user");
        userCell.set({ id: 1, name: "Test" });

        expect(userCell.get()).toEqual({ id: 1, name: "Test" });
      });
    });
  });

  describe("Cell.of() validation", () => {
    it("should throw when given a Cell", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const existingCell = Cell.of(42);
        expect(() => Cell.of(existingCell)).toThrow(
          /Cell\.of\(\) only accepts static data.*found a reactive value/,
        );
      });
    });

    it("should throw when given a Cell nested in an object", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const existingCell = Cell.of(42);
        expect(() => Cell.of({ nested: existingCell })).toThrow(
          /Cell\.of\(\) only accepts static data.*found a reactive value.*path 'nested'/,
        );
      });
    });

    it("should throw when given a Cell nested in an array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const existingCell = Cell.of(42);
        expect(() => Cell.of([1, 2, existingCell, 4])).toThrow(
          /Cell\.of\(\) only accepts static data.*found a reactive value.*path '2'/,
        );
      });
    });

    it("should throw when given a Cell deeply nested", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const existingCell = Cell.of(42);
        expect(() =>
          Cell.of({
            level1: {
              level2: {
                cells: [existingCell],
              },
            },
          })
        ).toThrow(
          /Cell\.of\(\) only accepts static data.*found a reactive value.*path 'level1.level2.cells.0'/,
        );
      });
    });

    it("should throw when given a circular reference", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const circular: any = { a: 1 };
        circular.self = circular;
        expect(() => Cell.of(circular)).toThrow(
          /Cell\.of\(\) does not accept circular references.*Cycle detected.*path 'self'/,
        );
      });
    });

    it("should throw when given a deeply nested circular reference", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const obj: any = { level1: { level2: { value: 1 } } };
        obj.level1.level2.backRef = obj.level1;
        expect(() => Cell.of(obj)).toThrow(
          /Cell\.of\(\) does not accept circular references.*Cycle detected/,
        );
      });
    });

    it("should throw when given circular reference in arrays", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const arr: any[] = [1, 2, 3];
        arr.push(arr);
        expect(() => Cell.of(arr)).toThrow(
          /Cell\.of\(\) does not accept circular references.*Cycle detected.*path '3'/,
        );
      });
    });

    it("should allow shared references (same object at multiple paths)", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const shared = { x: 1 };
        // Same object referenced twice - this is NOT a cycle
        const cell1 = Cell.of([shared, shared]);
        expect(cell1.get()).toEqual([{ x: 1 }, { x: 1 }]);

        const cell2 = Cell.of({ a: shared, b: shared });
        expect(cell2.get()).toEqual({ a: { x: 1 }, b: { x: 1 } });
      });
    });

    it("should allow deeply shared references", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const shared = { value: 42 };
        const obj = {
          level1: { ref: shared },
          level2: { ref: shared },
          arr: [shared, shared],
        };
        const cell = Cell.of(obj);
        expect(cell.get()).toEqual({
          level1: { ref: { value: 42 } },
          level2: { ref: { value: 42 } },
          arr: [{ value: 42 }, { value: 42 }],
        });
      });
    });
  });

  describe("Edge cases", () => {
    it("should handle creating cell with very large numbers", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const largeNum = Number.MAX_SAFE_INTEGER;
        const cell = Cell.of(largeNum);
        expect(cell.get()).toBe(largeNum);
      });
    });

    it("should handle creating cell with special number values", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const zeroCell = Cell.of(0);
        const negCell = Cell.of(-42);
        const minCell = Cell.of(Number.MIN_SAFE_INTEGER);
        const epsCell = Cell.of(Number.EPSILON);

        expect(zeroCell.get()).toBe(0);
        expect(negCell.get()).toBe(-42);
        expect(minCell.get()).toBe(Number.MIN_SAFE_INTEGER);
        expect(epsCell.get()).toBe(Number.EPSILON);
      });
    });

    it("should handle creating cell with empty string", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of("");
        expect(cell.get()).toBe("");
      });
    });

    it("should handle creating cell with empty array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of([]);
        expect(cell.get()).toEqual([]);
      });
    });

    it("should handle creating cell with empty object", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of({});
        expect(cell.get()).toEqual({});
      });
    });

    it("should handle deeply nested structures", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const deep = {
          level1: {
            level2: {
              level3: {
                level4: {
                  value: "deep",
                },
              },
            },
          },
        };
        const cell = Cell.of(deep);
        expect(cell.get()).toEqual(deep);
      });
    });

    it("should round-trip a FabricEpochNsec timestamp value", () => {
      // `FabricEpochNsec` is the fabric representation of a timestamp; it
      // round-trips faithfully as an atomic leaf.
      withinHandlerContext(runtime, space, tx, () => {
        const epoch = new FabricEpochNsec(
          BigInt(Date.parse("2024-01-01T00:00:00Z")) * 1_000_000n,
        );
        const cell = Cell.of(epoch);
        const got = cell.get() as FabricEpochNsec;
        expect(got.value).toBe(epoch.value);
      });
    });

    // A JS `Date` written via `set()` is normalized to a `FabricEpochNsec`
    // (top-level and nested alike). These use a self-contained runtime that
    // drains the storage sync before dispose: the shared `afterEach` disposes
    // without awaiting the sync a commit triggers, which races for writes that
    // persist (a latent harness fragility unrelated to this behavior).
    const DATE_ISO = "2024-01-01T00:00:00Z";
    const DATE_NS = BigInt(Date.parse(DATE_ISO)) * 1_000_000n;
    const assertEpochNsec = (got: unknown) => {
      const v = got as { value?: bigint };
      expect(v?.value).toBe(DATE_NS);
    };
    const inFreshRuntime = async (
      fn: (
        cellApi: typeof Cell,
        rt: Runtime,
        localTx: IExtendedStorageTransaction,
      ) => void,
    ) => {
      const sm = StorageManager.emulate({ as: signer });
      const rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      const localTx = rt.edit();
      const cellApi = createTrustedBuilder(rt).commonfabric.Cell;
      try {
        withinHandlerContext(
          rt,
          space,
          localTx,
          () => fn(cellApi, rt, localTx),
        );
        await localTx.commit();
        await sm.synced();
      } finally {
        await rt.dispose().catch(() => {});
        await sm.close().catch(() => {});
      }
    };

    //
    // Date normalization on `set()`
    //
    // A JS `Date` written through `set()` normalizes to a
    // `FabricEpochNsec`, at the top level and nested inside an array.
    //

    it("normalizes a top-level Date to FabricEpochNsec (set)", async () => {
      await inFreshRuntime((Cell) => {
        const cell = Cell.of<unknown>(0);
        cell.set(new Date(DATE_ISO));
        assertEpochNsec(cell.get());
      });
    });

    it("normalizes a nested Date to FabricEpochNsec (set)", async () => {
      await inFreshRuntime((Cell) => {
        const cell = Cell.of<unknown>(0);
        cell.set([new Date(DATE_ISO)]);
        assertEpochNsec((cell.get() as unknown[])[0]);
      });
    });

    //
    // Mixed type arrays
    //

    it("should handle creating cell with mixed type array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const mixed = [1, "two", { three: 3 }, [4], true, null];
        const cell = Cell.of(mixed);
        expect(cell.get()).toEqual(mixed);
      });
    });

    it("should handle creating cell with mixed type array from set", () => {
      // Using Cell.of, like the other tests, means that we can't use a proxy
      // since the value isn't set. Using cell.set, we can use a query result
      // proxy. I don't have a good way of verifying that in a unit test, but
      // I can at least verify that it returns the correct value.
      withinHandlerContext(runtime, space, tx, () => {
        const mixed = [1, "two", { three: 3 }, [4], true, null];
        const cell = Cell.of(mixed);
        cell.set(mixed);
        expect(cell.get()).toEqual(mixed);
      });
    });
  });
});
