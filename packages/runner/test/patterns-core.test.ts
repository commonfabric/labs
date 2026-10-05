// Basic pattern mechanics: defining patterns, passing inputs, returning outputs,
// nesting patterns, default values, and map/iteration over collections.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  type FactoryInput,
  type JSONSchema,
  type PatternFactory,
} from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Core", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      lift,
      pattern,
    } = commonfabric);
  });

  async function commitTx() {
    if (tx.status().status !== "ready") {
      return { ok: undefined, error: undefined };
    }
    runtime.prepareTxForCommit(tx);
    return await tx.commit().settled;
  }

  afterEach(async () => {
    await commitTx();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run a simple pattern", async () => {
    const simplePattern = pattern<{ value: number }>(
      ({ value }) => {
        const doubled = lift((x: number) => x * 2)(value);
        return { result: doubled };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should run a simple pattern",
      undefined,
      tx,
    );
    const result = runtime.run(tx, simplePattern, {
      value: 5,
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect(value).toMatchObject({ result: 10 });
  });

  it("should handle nested patterns", async () => {
    const innerPattern = pattern<{ x: number }>(({ x }) => {
      const squared = lift((n: number) => {
        return n * n;
      })(x);
      return { squared };
    });

    const outerPattern = pattern<{ value: number }>(
      ({ value }) => {
        const { squared } = innerPattern({ x: value });
        const result = lift((n: number) => {
          return n + 1;
        })(squared);
        return { result };
      },
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "should handle nested patterns",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outerPattern, {
      value: 4,
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect(value).toEqual({ result: 17 });
  });

  it("should handle patterns with default values", async () => {
    const patternWithDefaults = pattern(
      ({ a, b }) => {
        const { sum } = lift(({ x, y }) => ({ sum: x + y }))({ x: a, y: b });
        return { sum };
      },
      {
        type: "object",
        properties: {
          a: { type: "number", default: 5 },
          b: { type: "number", default: 10 },
        },
      },
      { type: "object", properties: { sum: { type: "number" } } },
    );

    const resultCell1 = runtime.getCell<{ sum: number }>(
      space,
      "should handle patterns with defaults",
      undefined,
      tx,
    );
    const result1 = runtime.run(
      tx,
      patternWithDefaults,
      {},
      resultCell1,
    );
    await commitTx();
    tx = runtime.edit();

    const value1 = await result1.pull();
    expect(value1).toMatchObject({ sum: 15 });

    const resultCell2 = runtime.getCell<{ sum: number }>(
      space,
      "should handle patterns with defaults (2)",
      undefined,
      tx,
    );
    const result2 = runtime.run(tx, patternWithDefaults, {
      a: 20,
    }, resultCell2);
    await commitTx();

    const value2 = await result2.pull();
    expect(value2).toMatchObject({ sum: 30 });
  });

  it("should handle patterns with map nodes", async () => {
    const multiply = lift<{ x: number; index: number; array: { x: number }[] }>(
      ({ x, index, array }) => x * (index + 1) * array.length,
    );

    const multipliedArray = pattern<{ values: { x: number }[] }>(
      ({ values }) => {
        const multiplied = (values as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            ((({ x }: any, index: any, array: any) => {
              return { multiplied: multiply({ x, index, array }) };
            }) as any)(element, index, array)
          ),
          {},
        );
        return { multiplied };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle patterns with map nodes",
      {
        type: "object",
        properties: {
          multiplied: {
            type: "array",
            items: {
              type: "object",
              properties: { multiplied: { type: "number" } },
            },
          },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, multipliedArray, {
      values: [{ x: 1 }, { x: 2 }, { x: 3 }],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({
      multiplied: [{ multiplied: 3 }, { multiplied: 12 }, { multiplied: 27 }],
    });
  });

  async function verifyListElementPruning(
    name: string,
    inspectArray: PatternFactory<
      { values: number[] },
      { values: number[]; output: number[] }
    >,
    expected: (values: number[]) => unknown[],
  ): Promise<void> {
    const expandedValues = Array.from({ length: 20 }, (_, index) => index);
    const result = runtime.run(
      tx,
      inspectArray,
      { values: expandedValues },
      runtime.getCell(space, name, undefined, tx),
    );
    await commitTx();
    await runtime.settled();
    await result.pull();

    expect(result.key("output").get()).toEqual(expected(expandedValues));
    const expandedRunnerCount = runtime.runner.cancels.size;

    tx = runtime.edit();
    result.withTx(tx).key("values").set(expandedValues.slice(0, 5));
    await commitTx();
    await runtime.settled();
    await result.pull();

    expect(result.key("output").get()).toEqual(
      expected(expandedValues.slice(0, 5)),
    );
    // A released child leaves no trace on the pattern's own surface — its
    // element is gone from the list and its result document keeps its last
    // value — so the runner's registration map is where the release shows.
    // The count falls by exactly the fifteen elements that left, which one
    // release out of fifteen would not satisfy. Only this runtime registers
    // into that map, and the two readings bracket a single edit, so the
    // difference is the coordinator's alone.
    expect(runtime.runner.cancels.size).toBe(expandedRunnerCount - 15);

    tx = runtime.edit();
    result.withTx(tx).key("values").set(expandedValues);
    await commitTx();
    await runtime.settled();
    await result.pull();

    expect(result.key("output").get()).toEqual(expected(expandedValues));
    expect(runtime.runner.cancels.size).toBe(expandedRunnerCount);
  }

  it("stops map element patterns when an input array shrinks", async () => {
    const inspectArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      output: (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => value * 2)(element)
        ),
        {},
      ),
    }));
    await verifyListElementPruning(
      "map-element-pattern-pruning",
      inspectArray,
      (values) => values.map((value) => value * 2),
    );
  });

  it("stops filter element patterns when an input array shrinks", async () => {
    const inspectArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      output: (values as any).filterWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => value % 2 === 0)(element)
        ),
        {},
      ),
    }));
    await verifyListElementPruning(
      "filter-element-pattern-pruning",
      inspectArray,
      (values) => values.filter((value) => value % 2 === 0),
    );
  });

  it("stops flatMap element patterns when an input array shrinks", async () => {
    const inspectArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      output: (values as any).flatMapWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => [value, -value])(element)
        ),
        {},
      ),
    }));
    await verifyListElementPruning(
      "flatmap-element-pattern-pruning",
      inspectArray,
      (values) => values.flatMap((value) => [value, -value]),
    );
  });

  it("stops the element patterns a list still holds when it is stopped", async () => {
    const inspectArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      output: (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => value * 2)(element)
        ),
        {},
      ),
    }));
    const before = runtime.runner.cancels.size;
    const resultCell = runtime.getCell(space, "map-teardown", undefined, tx);
    const result = runtime.run(
      tx,
      inspectArray,
      { values: [1, 2, 3, 4, 5] },
      resultCell,
    );
    await commitTx();
    await runtime.settled();
    await result.pull();
    expect(runtime.runner.cancels.size).toBeGreaterThan(before + 5);

    runtime.runner.stop(resultCell);
    await runtime.settled();

    // The coordinator releases every element pattern it still holds, so
    // stopping it leaves nothing of the list behind.
    expect(runtime.runner.cancels.size).toBe(before);
  });

  it("keeps a directly started map element running after removal", async () => {
    const inspectArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      output: (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) => ({
          doubled: lift((value: number) => value * 2)(element),
        })),
        {},
      ),
    }));
    const values = [1, 2];
    const result = runtime.run(
      tx,
      inspectArray,
      { values },
      runtime.getCell(space, "independent-map-element", undefined, tx),
    );
    await commitTx();
    await runtime.settled();
    await result.pull();

    const openedElement = result.key("output").key(1).resolveAsCell();
    expect(await runtime.start(openedElement)).toBe(true);
    expect(await openedElement.pull()).toEqual({ doubled: 4 });
    const resultKey = entityKey(
      openedElement.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );

    tx = runtime.edit();
    result.withTx(tx).key("values").set([1]);
    await commitTx();
    await runtime.settled();

    expect(runtime.runner.cancels.has(resultKey)).toBe(true);
    runtime.runner.stop(openedElement);
  });

  it("should handle map nodes with undefined input", async () => {
    const double = lift((x: number) => x * 2);

    const doubleArray = pattern<{ values?: number[] }>(
      ({ values }) => {
        const doubled = (values as any)?.mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((x: any) => double(x)) as any)(element, index, array)
          ),
          {},
        ) ?? [];
        return { doubled };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "should handle map nodes with undefined input",
      {
        type: "object",
        properties: { doubled: { type: "array", items: { type: "number" } } },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: undefined,
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect(value).toMatchObjectIgnoringSymbols({ doubled: [] });
  });

  it("should preserve sparse array holes through map", async () => {
    const double = lift((x: number) => x * 2);

    const doubleArray = pattern<{ values: number[] }>(
      ({ values }) => {
        const doubled = (values as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((x: any) => double(x)) as any)(element, index, array)
          ),
          {},
        );
        return { doubled };
      },
    );

    // Create a sparse input array: [10, <hole>, 30]
    // deno-lint-ignore no-sparse-arrays
    const sparseInput = [10, , 30];

    const resultCell = runtime.getCell(
      space,
      "should preserve sparse array holes through map",
      {
        type: "object",
        properties: {
          doubled: { type: "array", items: { type: "number" } },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: sparseInput,
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    const doubled = (value as any).doubled;
    expect(Array.isArray(doubled)).toBe(true);
    expect(doubled.length).toBe(3);
    expect(doubled[0]).toBe(20);
    expect(1 in doubled).toBe(false); // hole preserved
    expect(doubled[2]).toBe(60);
  });

  it("restores a mapped value that became a hole and came back", async () => {
    const doubleArray = pattern<{ values: number[] }>(({ values }) => ({
      values,
      doubled: (values as any).mapWithPattern(
        pattern(({ element }: FactoryInput<any>) =>
          lift((value: number) => value * 2)(element)
        ),
        {},
      ),
    }));

    const result = runtime.run(
      tx,
      doubleArray,
      { values: [10, 20, 30] },
      runtime.getCell(space, "hole-round-trip", undefined, tx),
    );
    await commitTx();
    await runtime.settled();
    await result.pull();
    expect(result.key("doubled").get()).toEqual([20, 40, 60]);

    // The middle value becomes a hole, so the list no longer holds that
    // element and its pattern run is released.
    tx = runtime.edit();
    // deno-lint-ignore no-sparse-arrays
    result.withTx(tx).key("values").set([10, , 30]);
    await commitTx();
    await runtime.settled();
    await result.pull();
    const withHole = result.key("doubled").get() as number[];
    expect(1 in withHole).toBe(false);

    // The value returns to the same position, which addresses the same result
    // cell, so the element is set up again and reads its value once more.
    tx = runtime.edit();
    result.withTx(tx).key("values").set([10, 20, 30]);
    await commitTx();
    await runtime.settled();
    await result.pull();
    expect(result.key("doubled").get()).toEqual([20, 40, 60]);
  });
});
