// Reduce tests: aggregating reactive arrays into single accumulated values.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type FactoryInput, type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Reduce", () => {
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

  it("should sum an array of numbers", async () => {
    const sumPattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const total = values.reduce(
          (acc: number, x: number) => acc + x,
          0,
        );
        return { total };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "reduce-sum",
      {
        type: "object",
        properties: { total: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumPattern, {
      values: [1, 2, 3, 4, 5],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect((value as any).total).toBe(15);
  });

  it("should reactively update when input changes", async () => {
    const sumPattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const total = values.reduce(
          (acc: number, x: number) => acc + x,
          0,
        );
        return { total };
      },
    );

    const inputCell = runtime.getCell<{ values: number[] }>(
      space,
      "reduce-reactive-input",
      undefined,
      tx,
    );
    inputCell.set({ values: [1, 2, 3] });

    const resultCell = runtime.getCell(
      space,
      "reduce-reactive-result",
      {
        type: "object",
        properties: { total: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumPattern, inputCell, resultCell);
    await commitTx();

    let value = await result.pull();
    expect((value as any).total).toBe(6);

    // Update input
    tx = runtime.edit();
    inputCell.withTx(tx).set({ values: [10, 20, 30] });
    await commitTx();

    value = await result.pull();
    expect((value as any).total).toBe(60);
  });

  it("should count elements", async () => {
    const countPattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const count = values.reduce(
          (acc: number, _x: number) => acc + 1,
          0,
        );
        return { count };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "reduce-count",
      {
        type: "object",
        properties: { count: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, countPattern, {
      values: [10, 20, 30, 40],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect((value as any).count).toBe(4);
  });

  it("should return initial value for empty array", async () => {
    const sumPattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const total = values.reduce(
          (acc: number, x: number) => acc + x,
          0,
        );
        return { total };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "reduce-empty",
      {
        type: "object",
        properties: { total: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumPattern, {
      values: [],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect((value as any).total).toBe(0);
  });

  it("should handle reduce with filtering", async () => {
    const sumPositivePattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const total = values.reduce(
          (acc: number, x: number) => x > 0 ? acc + x : acc,
          0,
        );
        return { total };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "reduce-filter",
      {
        type: "object",
        properties: { total: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumPositivePattern, {
      values: [1, -2, 3, -4, 5],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect((value as any).total).toBe(9); // 1 + 3 + 5
  });

  it("should chain map then reduce", async () => {
    const double = lift((x: number) => x * 2);

    const sumDoubledPattern = pattern<{ values: number[] }>(
      ({ values }) => {
        const total = (values as any)
          .mapWithPattern(
            pattern(({ element, index, array }: FactoryInput<any>) =>
              (((x: any) => double(x)) as any)(element, index, array)
            ),
            {},
          )
          .reduce((acc: number, x: number) => acc + x, 0);
        return { total };
      },
    );

    const resultCell = runtime.getCell(
      space,
      "reduce-chained",
      {
        type: "object",
        properties: { total: { type: "number" } },
      } as const satisfies JSONSchema,
      tx,
    );

    const result = runtime.run(tx, sumDoubledPattern, {
      values: [1, 2, 3],
    }, resultCell);
    await commitTx();

    const value = await result.pull();
    expect((value as any).total).toBe(12); // 1*2 + 2*2 + 3*2
  });
});
