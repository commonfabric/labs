// Dynamic pattern instantiation: patterns created at runtime inside lifts
// or handlers, and ensuring they execute in the correct dependency order.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const booleanSchema = {
  type: "boolean",
} as const satisfies JSONSchema;

const numberArraySchema = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;

const numberElementArgumentSchema = {
  type: "object",
  properties: {
    element: numberSchema,
  },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberOrNumberArraySchema = {
  anyOf: [
    numberSchema,
    numberArraySchema,
  ],
} as const satisfies JSONSchema;

describe("Pattern Runner - Dynamic Patterns", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  function unaryNumberListOpPattern(
    // deno-lint-ignore no-explicit-any
    fn: (element: any) => any,
    resultSchema: JSONSchema,
  ) {
    return pattern<{ element: number }, unknown>(
      ({ element }) => fn(element),
      numberElementArgumentSchema,
      resultSchema,
    );
  }

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

  it("should run dynamically instantiated patterns before reading their outputs", async () => {
    // This test reproduces a bug where:
    // 1. A lift dynamically instantiates patterns and pushes them to an array
    // 2. Another lift reads computed values from those array entries
    // 3. The dynamically instantiated patterns haven't executed yet, so their
    //    computed outputs are undefined
    //
    // The bug manifests with push-based scheduling (sink + idle) but not with
    // pull-based scheduling (pull()) because pull correctly traverses the
    // dependency chain.

    // Inner pattern that computes itemCount from a values array
    const itemCountPattern = pattern(
      ({ values }) => {
        // Compute item count from values
        const itemCount = lift(
          (arr: number[]) => (Array.isArray(arr) ? arr.length : 0),
          {
            type: "array",
            items: { type: "number" },
          } as const satisfies JSONSchema,
          { type: "number" } as const satisfies JSONSchema,
        )(values);

        return { values, itemCount };
      },
      // Input schema
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            items: { type: "number" },
            default: [],
          },
        },
        required: ["values"],
      } as const satisfies JSONSchema,
      // Output schema
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          itemCount: { type: "number" },
        },
      } as const satisfies JSONSchema,
    );

    // Lift that dynamically instantiates itemCountPattern for each group
    const instantiateGroups = lift(
      ({ groups }: any) => {
        const raw = groups.get();
        const list = Array.isArray(raw) ? raw : [];
        const children = [];
        for (let index = 0; index < list.length; index++) {
          const groupCell = groups.key(index)!;
          const valuesCell = groupCell.key("values");
          const child = itemCountPattern({
            values: valuesCell,
          });
          children.push(child);
        }
        return children;
      },
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
              required: ["values"],
            },
            asCell: ["cell"],
          },
        },
        required: ["groups"],
      } as const satisfies JSONSchema,
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" } },
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
    );

    // Lift that sums itemCount from all groups
    const computeTotalItems = lift(
      (entries: Array<{ itemCount?: number }>) => {
        if (!Array.isArray(entries)) {
          return 0;
        }
        return entries.reduce((sum, entry) => {
          const count = entry?.itemCount;
          return typeof count === "number" ? sum + count : sum;
        }, 0);
      },
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            itemCount: { type: "number" },
          },
        },
      } as const satisfies JSONSchema,
      { type: "number" } as const satisfies JSONSchema,
    );

    // Outer pattern that uses instantiateGroups and computeTotalItems
    const outerPattern = pattern(
      ({ groups: groupSeeds }) => {
        const groups = instantiateGroups({ groups: groupSeeds });
        const totalItems = computeTotalItems(groups);
        return { groups, totalItems };
      },
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
              },
              required: ["values"],
            },
            default: [],
          },
        },
        required: ["groups"],
      } as const satisfies JSONSchema,
      {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                values: { type: "array", items: { type: "number" } },
                itemCount: { type: "number" },
              },
            },
          },
          totalItems: { type: "number" },
        },
      } as const satisfies JSONSchema,
    );

    const resultCell = runtime.getCell<{
      groups: Array<{ values: number[]; itemCount: number }>;
      totalItems: number;
    }>(
      space,
      "should run dynamically instantiated patterns before reading their outputs",
      undefined,
      tx,
    );

    const result = runtime.run(tx, outerPattern, {
      groups: [
        { values: [1, 2, 3] },
        { values: [4, 5] },
      ],
    }, resultCell);
    await commitTx();

    const value = await result.pull();

    // The bug: totalItems would be 0 because the dynamically instantiated
    // patterns haven't run yet when computeTotalItems executes
    expect(value.groups).toHaveLength(2);
    expect(value.groups![0].itemCount).toBe(3);
    expect(value.groups![1].itemCount).toBe(2);
    expect(value.totalItems).toBe(5); // This fails if nested patterns aren't run first
  });

  it("should use positional identity for inline values in map", async () => {
    // Inline values use positional identity (their cell's normalized link
    // includes the array index). When [1, 2, 3] becomes [1, 99, 2, 3]:
    //   - position 0 (value 1) → same key → reuse
    //   - position 1 (value 99) → was value 2's key → new run
    //   - position 2 (value 2) → was value 3's key → new run
    //   - position 3 (value 3) → new key → new run
    // This is the expected trade-off: inline values don't get cross-position
    // reuse. Cell links (the important case) do — see next test.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });
    const doublePattern = unaryNumberListOpPattern(
      (element) => double(element),
      numberSchema,
    );

    // Pass `values` through in the return so we can mutate the input list
    // via the result cell (same technique as the CT-1158 test).
    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        doubled: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
          doublePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-mid-insert-recompute",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 4, 6]);

    // 3 elements → 3 runs of the op
    const runsAfterInit = runCount;
    expect(runsAfterInit).toBe(3);

    // Insert 99 at index 1: [1, 2, 3] → [1, 99, 2, 3]
    result.withTx(tx).key("values").set([1, 99, 2, 3]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 198, 4, 6]);

    const recomputesAfterInsert = runCount - runsAfterInit;

    // 3 recomputes: positions 1, 2, 3 all get new runs because inline values
    // use positional identity. Only position 0 is reused (value 1, unchanged).
    expect(recomputesAfterInsert).toBe(3);
  });

  it("should reconcile cell-link elements by identity on mid-list insert", async () => {
    // When map elements are cell links (references to other cells), the map
    // builtin uses identity-based reconciliation: it tracks elements by their
    // entity ID and reuses existing pattern runs when elements shift positions.
    // This means inserting in the middle only triggers 1 new computation (the
    // inserted element), not N recomputes for shifted elements.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });
    const doublePattern = unaryNumberListOpPattern(
      (element) => double(element),
      numberSchema,
    );

    // Create individual cells for each value so they have stable entity IDs
    const cellA = runtime.getCell<number>(space, "cell-a", undefined, tx);
    cellA.withTx(tx).set(1);
    const cellB = runtime.getCell<number>(space, "cell-b", undefined, tx);
    cellB.withTx(tx).set(2);
    const cellC = runtime.getCell<number>(space, "cell-c", undefined, tx);
    cellC.withTx(tx).set(3);

    // Pattern that takes a list of values and doubles each one
    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        doubled: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
          doublePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-cell-link-reconcile",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 4, 6]);

    // 3 elements → 3 runs of the op
    const runsAfterInit = runCount;
    expect(runsAfterInit).toBe(3);

    // Create a new cell and insert it at index 1: [A, B, C] → [A, X, B, C]
    const cellX = runtime.getCell<number>(space, "cell-x", undefined, tx);
    cellX.withTx(tx).set(99);

    result.withTx(tx).key("values").set([cellA, cellX, cellB, cellC]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 198, 4, 6]);

    const recomputesAfterInsert = runCount - runsAfterInit;

    // With identity-based reconciliation: only 1 recompute (the new element X).
    // Elements A, B, C are recognized by their entity IDs and their existing
    // pattern runs are reused — no unnecessary recomputation.
    expect(recomputesAfterInsert).toBe(1);
  });

  it("should handle duplicate cell-link references in map", async () => {
    // When the same cell appears multiple times in a list (e.g. [A, B, A]),
    // each occurrence must get its own pattern run and result cell. Without
    // occurrence counting, both A references would collide to the same key
    // and share a single result cell.

    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });
    const doublePattern = unaryNumberListOpPattern(
      (element) => double(element),
      numberSchema,
    );

    const cellA = runtime.getCell<number>(space, "dup-cell-a", undefined, tx);
    cellA.withTx(tx).set(5);
    const cellB = runtime.getCell<number>(space, "dup-cell-b", undefined, tx);
    cellB.withTx(tx).set(10);

    const doubleArray = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        doubled: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
          doublePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; doubled: number[] }>(
      space,
      "map-duplicate-cell-links",
      undefined,
      tx,
    );
    const result = runtime.run(tx, doubleArray, {
      values: [cellA, cellB, cellA],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();

    // Each position gets its own run, even though A appears twice
    expect(runCount).toBe(3);
    expect(result.key("doubled").get()).toEqual([10, 20, 10]);
  });

  it("should clean up pattern runs when map list becomes undefined", async () => {
    let runCount = 0;
    const double = lift((x: number) => {
      runCount++;
      return x * 2;
    });
    const doublePattern = unaryNumberListOpPattern(
      (element) => double(element),
      numberSchema,
    );

    const mapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        doubled: (values as unknown as OpaqueCell<number[]>).mapWithPattern(
          doublePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<
      { values: number[]; doubled: number[] }
    >(
      space,
      "map-undef-cleanup",
      undefined,
      tx,
    );
    const result = runtime.run(tx, mapPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([2, 4, 6]);
    expect(runCount).toBe(3);

    // Set list to undefined — should clean up and produce empty output
    result.withTx(tx).key("values").set(undefined as any);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([]);

    // Restore list — runs must re-execute (old runs were stopped)
    const runsBeforeRestore = runCount;
    result.withTx(tx).key("values").set([4, 5]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("doubled").get()).toEqual([8, 10]);
    expect(runCount - runsBeforeRestore).toBe(2);
  });

  //
  // `filter` builtin tests
  //

  it("should filter an array by predicate", async () => {
    const isEven = lift((x: number) => x % 2 === 0);
    const isEvenPattern = unaryNumberListOpPattern(
      (element) => isEven(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        evens: (values as unknown as OpaqueCell<number[]>).filterWithPattern(
          isEvenPattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; evens: number[] }>(
      space,
      "filter-basic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: [1, 2, 3, 4, 5],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("evens").get()).toEqual([2, 4]);
  });

  it("should reactively update filter when element value changes", async () => {
    const isPositive = lift((x: number) => x > 0);
    const isPositivePattern = unaryNumberListOpPattern(
      (element) => isPositive(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        positives: (values as unknown as OpaqueCell<number[]>)
          .filterWithPattern(
            isPositivePattern as any,
            {},
          ),
      };
    });

    const cellA = runtime.getCell<number>(
      space,
      "filter-react-a",
      undefined,
      tx,
    );
    cellA.withTx(tx).set(5);
    const cellB = runtime.getCell<number>(
      space,
      "filter-react-b",
      undefined,
      tx,
    );
    cellB.withTx(tx).set(-3);
    const cellC = runtime.getCell<number>(
      space,
      "filter-react-c",
      undefined,
      tx,
    );
    cellC.withTx(tx).set(10);

    const resultCell = runtime.getCell<
      { values: number[]; positives: number[] }
    >(
      space,
      "filter-reactive",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // B is negative, so only A and C pass
    expect(result.key("positives").get()).toEqual([5, 10]);

    // Flip B from negative to positive
    cellB.withTx(tx).set(7);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // Now all three are positive
    expect(result.key("positives").get()).toEqual([5, 7, 10]);
  });

  it("should reconcile filter predicates by identity on mid-list insert", async () => {
    let predRunCount = 0;
    const isPositive = lift((x: number) => {
      predRunCount++;
      return x > 0;
    });
    const isPositivePattern = unaryNumberListOpPattern(
      (element) => isPositive(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        positives: (values as unknown as OpaqueCell<number[]>)
          .filterWithPattern(
            isPositivePattern as any,
            {},
          ),
      };
    });

    const cellA = runtime.getCell<number>(
      space,
      "filter-recon-a",
      undefined,
      tx,
    );
    cellA.withTx(tx).set(1);
    const cellB = runtime.getCell<number>(
      space,
      "filter-recon-b",
      undefined,
      tx,
    );
    cellB.withTx(tx).set(2);
    const cellC = runtime.getCell<number>(
      space,
      "filter-recon-c",
      undefined,
      tx,
    );
    cellC.withTx(tx).set(3);

    const resultCell = runtime.getCell<
      { values: number[]; positives: number[] }
    >(
      space,
      "filter-identity-reconcile",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([1, 2, 3]);
    const runsAfterInit = predRunCount;
    expect(runsAfterInit).toBe(3);

    // Insert a new cell at index 1: [A, B, C] → [A, X, B, C]
    const cellX = runtime.getCell<number>(
      space,
      "filter-recon-x",
      undefined,
      tx,
    );
    cellX.withTx(tx).set(99);

    result.withTx(tx).key("values").set([cellA, cellX, cellB, cellC]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([1, 99, 2, 3]);

    // Only 1 new predicate evaluation (for X). A, B, C reuse their runs.
    const recomputesAfterInsert = predRunCount - runsAfterInit;
    expect(recomputesAfterInsert).toBe(1);

    // Remove B: [A, X, B, C] → [A, X, C]
    const runsBeforeRemoval = predRunCount;
    result.withTx(tx).key("values").set([cellA, cellX, cellC]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([1, 99, 3]);

    // No new predicate evaluations — existing runs reused, B's just excluded.
    const recomputesAfterRemoval = predRunCount - runsBeforeRemoval;
    expect(recomputesAfterRemoval).toBe(0);
  });

  it("should handle duplicate cell references in filter", async () => {
    const isPositive = lift((x: number) => x > 0);
    const isPositivePattern = unaryNumberListOpPattern(
      (element) => isPositive(element),
      booleanSchema,
    );

    const cellA = runtime.getCell<number>(space, "filter-dup-a", undefined, tx);
    cellA.withTx(tx).set(5);
    const cellB = runtime.getCell<number>(space, "filter-dup-b", undefined, tx);
    cellB.withTx(tx).set(-1);

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        positives: (values as unknown as OpaqueCell<number[]>)
          .filterWithPattern(
            isPositivePattern as any,
            {},
          ),
      };
    });

    const resultCell = runtime.getCell<
      { values: number[]; positives: number[] }
    >(
      space,
      "filter-duplicate-refs",
      undefined,
      tx,
    );
    // [A, B, A] — A appears twice, B is negative
    const result = runtime.run(tx, filterPattern, {
      values: [cellA, cellB, cellA],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // Both A occurrences pass, B doesn't
    expect(result.key("positives").get()).toEqual([5, 5]);
  });

  it("should handle empty and undefined filter inputs", async () => {
    const isEven = lift((x: number) => x % 2 === 0);
    const isEvenPattern = unaryNumberListOpPattern(
      (element) => isEven(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        evens: (values as unknown as OpaqueCell<number[]>).filterWithPattern(
          isEvenPattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; evens: number[] }>(
      space,
      "filter-empty",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: [],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("evens").get()).toEqual([]);
  });

  it("should clean up predicate runs when filter list becomes undefined", async () => {
    let predRunCount = 0;
    const isPositive = lift((x: number) => {
      predRunCount++;
      return x > 0;
    });
    const isPositivePattern = unaryNumberListOpPattern(
      (element) => isPositive(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        positives: (values as unknown as OpaqueCell<number[]>)
          .filterWithPattern(
            isPositivePattern as any,
            {},
          ),
      };
    });

    const resultCell = runtime.getCell<
      { values: number[]; positives: number[] }
    >(
      space,
      "filter-undef-cleanup",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([1, 2, 3]);
    expect(predRunCount).toBe(3);

    // Set list to undefined — should clean up and produce empty output
    result.withTx(tx).key("values").set(undefined as any);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([]);

    // Restore list — predicates must re-run (old runs were stopped)
    const runsBeforeRestore = predRunCount;
    result.withTx(tx).key("values").set([4, 5]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("positives").get()).toEqual([4, 5]);
    expect(predRunCount - runsBeforeRestore).toBe(2);
  });

  it("should skip sparse holes in filter input", async () => {
    let predRunCount = 0;
    const isPositive = lift((x: number) => {
      predRunCount++;
      return x > 0;
    });
    const isPositivePattern = unaryNumberListOpPattern(
      (element) => isPositive(element),
      booleanSchema,
    );

    const filterPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        positives: (values as unknown as OpaqueCell<number[]>)
          .filterWithPattern(
            isPositivePattern as any,
            {},
          ),
      };
    });

    // deno-lint-ignore no-sparse-arrays
    const sparseInput = [1, , 3];

    const resultCell = runtime.getCell<
      { values: number[]; positives: number[] }
    >(
      space,
      "filter-sparse",
      undefined,
      tx,
    );
    const result = runtime.run(tx, filterPattern, {
      values: sparseInput,
    }, resultCell);
    await commitTx();

    await result.pull();
    // Only 2 predicate runs (hole skipped), both positive
    expect(predRunCount).toBe(2);
    expect(result.key("positives").get()).toEqual([1, 3]);
  });

  //
  // `flatMap` builtin tests
  //

  it("should flatMap an array", async () => {
    const duplicate = lift((x: number) => [x, x * 10]);
    const duplicatePattern = unaryNumberListOpPattern(
      (element) => duplicate(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          duplicatePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-basic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("should reactively update flatMap when element value changes", async () => {
    const expand = lift((x: number) => {
      if (x > 0) return [x, x * 2];
      return [];
    });
    const expandPattern = unaryNumberListOpPattern(
      (element) => expand(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          expandPattern as any,
          {},
        ),
      };
    });

    const cellA = runtime.getCell<number>(
      space,
      "flatmap-react-a",
      undefined,
      tx,
    );
    cellA.withTx(tx).set(5);
    const cellB = runtime.getCell<number>(
      space,
      "flatmap-react-b",
      undefined,
      tx,
    );
    cellB.withTx(tx).set(-1);

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-reactive",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [cellA, cellB],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    // A expands to [5, 10], B returns [] (negative)
    expect(result.key("flat").get()).toEqual([5, 10]);

    // Flip B to positive
    cellB.withTx(tx).set(3);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([5, 10, 3, 6]);
  });

  it("should reconcile flatMap by identity on mid-list insert", async () => {
    let runCount = 0;
    const duplicate = lift((x: number) => {
      runCount++;
      return [x, x * 10];
    });
    const duplicatePattern = unaryNumberListOpPattern(
      (element) => duplicate(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          duplicatePattern as any,
          {},
        ),
      };
    });

    const cellA = runtime.getCell<number>(
      space,
      "flatmap-recon-a",
      undefined,
      tx,
    );
    cellA.withTx(tx).set(1);
    const cellB = runtime.getCell<number>(
      space,
      "flatmap-recon-b",
      undefined,
      tx,
    );
    cellB.withTx(tx).set(2);
    const cellC = runtime.getCell<number>(
      space,
      "flatmap-recon-c",
      undefined,
      tx,
    );
    cellC.withTx(tx).set(3);

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-identity-reconcile",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [cellA, cellB, cellC],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 2, 20, 3, 30]);
    const runsAfterInit = runCount;
    expect(runsAfterInit).toBe(3);

    // Insert X at index 1: [A, B, C] → [A, X, B, C]
    const cellX = runtime.getCell<number>(
      space,
      "flatmap-recon-x",
      undefined,
      tx,
    );
    cellX.withTx(tx).set(99);

    result.withTx(tx).key("values").set([cellA, cellX, cellB, cellC]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 99, 990, 2, 20, 3, 30]);

    // Only 1 new run (for X). A, B, C reuse their runs.
    const recomputesAfterInsert = runCount - runsAfterInit;
    expect(recomputesAfterInsert).toBe(1);

    // Remove B: [A, X, B, C] → [A, X, C]
    const runsBeforeRemoval = runCount;
    result.withTx(tx).key("values").set([cellA, cellX, cellC]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 99, 990, 3, 30]);

    // No new pattern runs — existing runs reused, B's output just excluded.
    const recomputesAfterRemoval = runCount - runsBeforeRemoval;
    expect(recomputesAfterRemoval).toBe(0);
  });

  it("should handle empty sub-arrays in flatMap", async () => {
    const maybeExpand = lift((x: number) => {
      if (x % 2 === 0) return [x];
      return []; // Odd numbers produce empty arrays
    });
    const maybeExpandPattern = unaryNumberListOpPattern(
      (element) => maybeExpand(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          maybeExpandPattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-empty-sub",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [1, 2, 3, 4],
    }, resultCell);
    await commitTx();

    await result.pull();
    // Odd numbers contribute nothing
    expect(result.key("flat").get()).toEqual([2, 4]);
  });

  it("should include scalar results directly in flatMap (JS semantics)", async () => {
    // JS: [1,2,3].flatMap(x => x === 2 ? [20, 21] : x) → [1, 20, 21, 3]
    const expandOrPassthrough = lift((x: number) => {
      if (x === 2) return [20, 21];
      return x; // scalar, not wrapped in array
    });
    const expandOrPassthroughPattern = unaryNumberListOpPattern(
      (element) => expandOrPassthrough(element),
      numberOrNumberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          expandOrPassthroughPattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-scalar",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 20, 21, 3]);
  });

  it("should skip sparse holes in flatMap input", async () => {
    let runCount = 0;
    const duplicate = lift((x: number) => {
      runCount++;
      return [x, x * 10];
    });
    const duplicatePattern = unaryNumberListOpPattern(
      (element) => duplicate(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          duplicatePattern as any,
          {},
        ),
      };
    });

    // deno-lint-ignore no-sparse-arrays
    const sparseInput = [1, , 3];

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-sparse",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: sparseInput,
    }, resultCell);
    await commitTx();

    await result.pull();
    // Only 2 pattern runs (hole skipped)
    expect(runCount).toBe(2);
    expect(result.key("flat").get()).toEqual([1, 10, 3, 30]);
  });

  it("should clean up pattern runs when flatMap list becomes undefined", async () => {
    let runCount = 0;
    const duplicate = lift((x: number) => {
      runCount++;
      return [x, x * 10];
    });
    const duplicatePattern = unaryNumberListOpPattern(
      (element) => duplicate(element),
      numberArraySchema,
    );

    const flatMapPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as unknown as OpaqueCell<number[]>).flatMapWithPattern(
          duplicatePattern as any,
          {},
        ),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatmap-undef-cleanup",
      undefined,
      tx,
    );
    const result = runtime.run(tx, flatMapPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 2, 20, 3, 30]);
    expect(runCount).toBe(3);

    // Set list to undefined — should clean up and produce empty output
    result.withTx(tx).key("values").set(undefined as any);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([]);

    // Restore list — patterns must re-run (old runs were stopped)
    const runsBeforeRestore = runCount;
    result.withTx(tx).key("values").set([4, 5]);
    await commitTx();
    tx = runtime.edit();

    await result.pull();
    expect(result.key("flat").get()).toEqual([4, 40, 5, 50]);
    expect(runCount - runsBeforeRestore).toBe(2);
  });

  //
  // `filterWithPattern` and `flatMapWithPattern` variants
  //

  it("should filter with a pre-defined pattern (filterWithPattern)", async () => {
    // The WithPattern variants receive { element, index, array, params } at
    // runtime (same as map). The PatternFactory type doesn't fully capture
    // this shape — see IDerivable note in api/index.ts.
    const isEvenPattern = pattern<{ element: number }>(
      ({ element }) => {
        return lift((x: number) => x % 2 === 0, numberSchema, booleanSchema)(
          element,
        );
      },
      numberElementArgumentSchema,
      booleanSchema,
    );

    const outerPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        evens: (values as any).filterWithPattern(isEvenPattern as any, {}),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; evens: number[] }>(
      space,
      "filterWithPattern-basic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outerPattern, {
      values: [1, 2, 3, 4, 5],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("evens").get()).toEqual([2, 4]);
  });

  it("should flatMap with a pre-defined pattern (flatMapWithPattern)", async () => {
    // Same type gap as filterWithPattern — see comment above.
    const duplicatePattern = pattern<{ element: number }>(
      ({ element }) => {
        return lift(
          (x: number) => [x, x * 10],
          numberSchema,
          numberArraySchema,
        )(
          element,
        );
      },
      numberElementArgumentSchema,
      numberArraySchema,
    );

    const outerPattern = pattern<{ values: number[] }>(({ values }) => {
      return {
        values,
        // deno-lint-ignore no-explicit-any
        flat: (values as any).flatMapWithPattern(duplicatePattern as any, {}),
      };
    });

    const resultCell = runtime.getCell<{ values: number[]; flat: number[] }>(
      space,
      "flatMapWithPattern-basic",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outerPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();

    await result.pull();
    expect(result.key("flat").get()).toEqual([1, 10, 2, 20, 3, 30]);
  });
});
