/**
 * A reactive lift() callback may return a pattern instantiation — a fixed
 * one, a conditionally chosen one, or one that recursively instantiates the
 * same pattern (tail-call pagination). These cases pin that such a run
 * completes with the expected result, that the callback runs a bounded number
 * of times, and that a returned structure identical to the last one does not
 * re-run the sub-pattern.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Derive returning pattern", () => {
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

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle derive returning a non-recursive pattern instantiation", async () => {
    // Baseline: derive returns a different pattern (not self-referential).
    const innerPattern = pattern<{ value: number }>(({ value }) => {
      const doubled = lift((x: number) => x * 2)(value);
      return { result: doubled };
    });

    const outerPattern = pattern<{ value: number }>(({ value }) => {
      return lift(({ value: v }: { value: number }) => {
        return innerPattern({ value: v });
      })({ value });
    });

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "derive-return-pattern-basic",
      undefined,
      tx,
    );

    const result = runtime.run(tx, outerPattern, { value: 5 }, resultCell);
    await tx.commit();
    await runtime.storageManager.synced();

    const value = await result.pull();
    expect(value.result).toBe(10);
  });

  it("should handle derive returning a recursive pattern instantiation (tail-call)", async () => {
    // A pattern that conditionally calls itself via derive, simulating
    // tail-call pagination (like FetchContactsPage in
    // google-contacts-importer.tsx). Pinned: the recursion completes with
    // every page's items in order, and the callback runs a bounded number of
    // times (the recursive levels, the base case, and a few reactive
    // re-evaluations).

    let deriveCallCount = 0;

    const accumulator = pattern<{
      remaining: number;
      accumulated: number[];
      pageSize: number;
    }>(({ remaining, accumulated, pageSize }) => {
      return lift(
        ({ remaining: rem, accumulated: acc, pageSize: ps }: {
          remaining: number;
          accumulated: number[];
          pageSize: number;
        }) => {
          deriveCallCount++;

          // Guard against initial reactive pass with undefined values
          const items = Array.isArray(acc) ? acc : [];
          if (typeof rem !== "number" || rem <= 0) {
            return { items, done: true };
          }

          // Generate items for this "page"
          const newItems = Array.from(
            { length: ps },
            (_, i) => items.length + i + 1,
          );
          const combined = [...items, ...newItems];

          // Tail call: recursively instantiate self with updated state
          return accumulator({
            remaining: rem - 1,
            accumulated: combined,
            pageSize: ps,
          });
        },
      )({ remaining, accumulated, pageSize });
    });

    const resultCell = runtime.getCell<{ items: number[]; done: boolean }>(
      space,
      "derive-return-recursive-pattern",
      undefined,
      tx,
    );

    // 3 pages of 2 items each = 6 items total
    const result = runtime.run(
      tx,
      accumulator,
      { remaining: 3, accumulated: [], pageSize: 2 },
      resultCell,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    const value = await result.pull();
    expect(value.done).toBe(true);
    expect(value.items).toEqual([1, 2, 3, 4, 5, 6]);

    // The callback runs a bounded number of times: 3 recursive levels + the
    // base case + a few reactive re-evaluations = ~7. The bound is on the
    // callback alone, not on how often the scheduler re-runs the action
    // around it.
    expect(deriveCallCount).toBeLessThan(20);
  });

  it("should not re-run sub-pattern when derive returns the same pattern structure", async () => {
    // Verifies that resultPatternCache deduplicates sub-pattern runs.
    // When the derive callback is re-triggered (by changing its watched
    // input) but returns the same pattern (identical JSON), the runner
    // should skip calling this.run() again.
    let deriveCallCount = 0;
    let innerLiftRunCount = 0;

    const innerPattern = pattern<{ value: number }>(({ value }) => {
      const doubled = lift((x: number) => {
        innerLiftRunCount++;
        return x * 2;
      })(value);
      return { result: doubled };
    });

    // The outer pattern watches `trigger` in derive and reads it (so
    // reactivity tracks it), but always returns the same
    // innerPattern({ value: 42 }) regardless of trigger value.
    // Changing trigger re-fires the derive callback, but the returned
    // pattern structure is identical — the cache should prevent duplicate
    // sub-pattern runs.
    const outerPattern = pattern<{ trigger: number }>(({ trigger }) => {
      return lift(({ trigger: t }: { trigger: number }) => {
        deriveCallCount++;
        // Read `t` so the reactive system tracks it as a dependency,
        // but don't use it in the returned pattern args.
        if (t < 0) throw new Error("unreachable");
        return innerPattern({ value: 42 });
      })({ trigger });
    });

    // Create a mutable input cell so we can change trigger later
    const inputCell = runtime.getCell<number>(
      space,
      "derive-pattern-cache-dedup-input",
    );
    inputCell.withTx(tx).set(1);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "derive-pattern-cache-dedup",
      undefined,
      tx,
    );

    const result = runtime.run(
      tx,
      outerPattern,
      { trigger: inputCell },
      resultCell,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    const value1 = await result.pull();
    expect(value1.result).toBe(84);

    const deriveCallsAfterFirstRun = deriveCallCount;
    const innerLiftsAfterFirstRun = innerLiftRunCount;
    expect(deriveCallsAfterFirstRun).toBeGreaterThanOrEqual(1);
    expect(innerLiftsAfterFirstRun).toBe(1);

    // Now change trigger to re-fire the derive callback.
    // The callback returns the same pattern structure, so the cache
    // should prevent a second this.run() call.
    tx = runtime.edit();
    inputCell.withTx(tx).send(2);
    await tx.commit();
    await runtime.storageManager.synced();

    const value2 = await result.pull();
    expect(value2.result).toBe(84);

    // Derive should have been called again (triggered by input change)
    expect(deriveCallCount).toBeGreaterThan(deriveCallsAfterFirstRun);
    // But inner pattern's lift should NOT have re-run (cache hit on pattern)
    expect(innerLiftRunCount).toBe(innerLiftsAfterFirstRun);
  });

  it("should not spuriously rerun parent derive when returned child pattern changes", async () => {
    let deriveCallCount = 0;
    let doubleRunCount = 0;
    let tripleRunCount = 0;

    const doublePattern = pattern<{ value: number }>(({ value }) => {
      const doubled = lift((x: number) => {
        doubleRunCount++;
        return x * 2;
      })(value);
      return { result: doubled };
    });

    const triplePattern = pattern<{ value: number }>(({ value }) => {
      const tripled = lift((x: number) => {
        tripleRunCount++;
        return x * 3;
      })(value);
      return { result: tripled };
    });

    const outerPattern = pattern<{ mode: string; value: number }>(
      ({ mode, value }) => {
        return lift(
          ({ mode: currentMode, value: currentValue }: {
            mode: string;
            value: number;
          }) => {
            deriveCallCount++;
            return currentMode === "double"
              ? doublePattern({ value: currentValue })
              : triplePattern({ value: currentValue });
          },
        )({ mode, value });
      },
    );

    const modeCell = runtime.getCell<string>(
      space,
      "derive-pattern-replacement-mode",
    );
    const valueCell = runtime.getCell<number>(
      space,
      "derive-pattern-replacement-value",
    );
    modeCell.withTx(tx).set("double");
    valueCell.withTx(tx).set(5);
    await tx.commit();
    await runtime.storageManager.synced();
    tx = runtime.edit();

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "derive-pattern-replacement-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern,
      { mode: modeCell, value: valueCell },
      resultCell,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    expect(await result.pull()).toEqual({ result: 10 });
    expect(deriveCallCount).toBe(1);
    expect(doubleRunCount).toBe(1);
    expect(tripleRunCount).toBe(0);

    tx = runtime.edit();
    modeCell.withTx(tx).send("triple");
    await tx.commit();
    await runtime.storageManager.synced();

    expect(await result.pull()).toEqual({ result: 15 });
    expect(deriveCallCount).toBe(2);
    expect(doubleRunCount).toBe(1);
    expect(tripleRunCount).toBe(1);

    tx = runtime.edit();
    modeCell.withTx(tx).send("double");
    await tx.commit();
    await runtime.storageManager.synced();

    expect(await result.pull()).toEqual({ result: 10 });
    expect(deriveCallCount).toBe(3);
    expect(doubleRunCount).toBe(2);
    expect(tripleRunCount).toBe(1);
  });

  it("should handle derive conditionally returning plain value or pattern", async () => {
    // Tests the branch where derive sometimes returns a plain value
    // and sometimes returns a pattern instantiation.

    const innerPattern = pattern<{ value: number }>(({ value }) => {
      const tripled = lift((x: number) => x * 3)(value);
      return { result: tripled };
    });

    const conditionalPattern = pattern<{ value: number; usePattern: boolean }>(
      ({ value, usePattern }) => {
        return lift(
          ({ value: v, usePattern: up }: {
            value: number;
            usePattern: boolean;
          }) => {
            if (up) {
              return innerPattern({ value: v });
            }
            return { result: v * 2 };
          },
        )({ value, usePattern });
      },
    );

    // Case 1: usePattern = false → plain value path
    const resultCell1 = runtime.getCell<{ result: number }>(
      space,
      "derive-conditional-plain",
      undefined,
      tx,
    );
    const result1 = runtime.run(
      tx,
      conditionalPattern,
      { value: 5, usePattern: false },
      resultCell1,
    );
    await tx.commit();
    await runtime.storageManager.synced();
    tx = runtime.edit();

    const value1 = await result1.pull();
    expect(value1.result).toBe(10);

    // Case 2: usePattern = true → pattern instantiation path
    const resultCell2 = runtime.getCell<{ result: number }>(
      space,
      "derive-conditional-pattern",
      undefined,
      tx,
    );
    const result2 = runtime.run(
      tx,
      conditionalPattern,
      { value: 5, usePattern: true },
      resultCell2,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    const value2 = await result2.pull();
    expect(value2.result).toBe(15);
  });
});
