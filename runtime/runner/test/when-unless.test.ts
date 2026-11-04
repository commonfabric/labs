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

describe("when and unless built-in functions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let when: ReturnType<typeof createBuilder>["commonfabric"]["when"];
  let unless: ReturnType<typeof createBuilder>["commonfabric"]["unless"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, lift, when, unless } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("when function (&& semantics)", () => {
    it("returns value when condition is truthy (true)", async () => {
      const testPattern = pattern<{ condition: boolean }>(
        ({ condition }) => {
          const result = when(condition, "success");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "when truthy true",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: true },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "success" });
    });

    it("returns falsy condition when condition is false", async () => {
      const testPattern = pattern<{ condition: boolean }>(
        ({ condition }) => {
          const result = when(condition, "success");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "when falsy false",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: false },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: false });
    });

    it("returns value when condition is truthy number (1)", async () => {
      const testPattern = pattern<{ condition: number }>(
        ({ condition }) => {
          const result = when(condition, "has value");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | number }>(
        space,
        "when truthy number",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: 42 },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "has value" });
    });

    it("returns 0 when condition is 0 (falsy)", async () => {
      const testPattern = pattern<{ condition: number }>(
        ({ condition }) => {
          const result = when(condition, "has value");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | number }>(
        space,
        "when falsy zero",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { condition: 0 }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: 0 });
    });

    it("returns empty string when condition is empty string (falsy)", async () => {
      const testPattern = pattern<{ condition: string }>(
        ({ condition }) => {
          const result = when(condition, "fallback");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "when falsy empty string",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: "" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "" });
    });

    it("returns value when condition is non-empty string (truthy)", async () => {
      const testPattern = pattern<{ condition: string }>(
        ({ condition }) => {
          const result = when(condition, "found");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "when truthy string",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: "hello" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "found" });
    });

    it("works with derived condition", async () => {
      const testPattern = pattern<{ count: number }>(
        ({ count }) => {
          const isPositive = lift((n: number) => n > 0)(count);
          const result = when(isPositive, "positive");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "when derived positive",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { count: 5 }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "positive" });
    });

    it("works with derived condition returning false", async () => {
      const testPattern = pattern<{ count: number }>(
        ({ count }) => {
          const isPositive = lift((n: number) => n > 0)(count);
          const result = when(isPositive, "positive");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "when derived negative",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { count: -3 }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: false });
    });
  });

  describe("unless function (|| semantics)", () => {
    it("returns truthy condition as-is when condition is true", async () => {
      const testPattern = pattern<{ condition: boolean }>(
        ({ condition }) => {
          const result = unless(condition, "fallback");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "unless truthy true",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: true },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: true });
    });

    it("returns fallback value when condition is false", async () => {
      const testPattern = pattern<{ condition: boolean }>(
        ({ condition }) => {
          const result = unless(condition, "fallback");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "unless falsy false",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: false },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "fallback" });
    });

    it("returns truthy number as-is", async () => {
      const testPattern = pattern<{ condition: number }>(
        ({ condition }) => {
          const result = unless(condition, 999);
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "unless truthy number",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: 42 },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: 42 });
    });

    it("returns fallback when condition is 0 (falsy)", async () => {
      const testPattern = pattern<{ condition: number }>(
        ({ condition }) => {
          const result = unless(condition, 999);
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "unless falsy zero",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { condition: 0 }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: 999 });
    });

    it("returns truthy string as-is", async () => {
      const testPattern = pattern<{ condition: string }>(
        ({ condition }) => {
          const result = unless(condition, "default");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "unless truthy string",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: "hello" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "hello" });
    });

    it("returns fallback when condition is empty string (falsy)", async () => {
      const testPattern = pattern<{ condition: string }>(
        ({ condition }) => {
          const result = unless(condition, "default");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "unless falsy empty string",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { condition: "" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "default" });
    });

    it("works with derived condition", async () => {
      const testPattern = pattern<{ name: string }>(
        ({ name }) => {
          const displayName = lift((n: string) => n || "")(name);
          const result = unless(displayName, "Anonymous");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "unless derived with value",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { name: "Alice" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "Alice" });
    });

    it("works with derived condition returning empty", async () => {
      const testPattern = pattern<{ name: string }>(
        ({ name }) => {
          const displayName = lift((n: string) => n || "")(name);
          const result = unless(displayName, "Anonymous");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "unless derived empty",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { name: "" }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "Anonymous" });
    });
  });

  describe("when and unless combined patterns", () => {
    it("chain when followed by unless (a && b || c pattern)", async () => {
      const testPattern = pattern<{ hasData: boolean; data: string }>(
        ({ hasData, data }) => {
          // Equivalent to: hasData && data || "no data"
          const dataIfAvailable = when(hasData, data);
          const result = unless(dataIfAvailable, "no data");
          return { result };
        },
      );

      // Test with truthy condition
      const resultCell1 = runtime.getCell<{ result: string | boolean }>(
        space,
        "chain with data",
        undefined,
        tx,
      );
      const result1 = runtime.run(
        tx,
        testPattern,
        { hasData: true, data: "hello" },
        resultCell1,
      );
      tx.commit();

      const value = await result1.pull();
      expect(value).toMatchObject({ result: "hello" });
    });

    it("chain when followed by unless returns fallback when first is false", async () => {
      const testPattern = pattern<{ hasData: boolean; data: string }>(
        ({ hasData, data }) => {
          const dataIfAvailable = when(hasData, data);
          const result = unless(dataIfAvailable, "no data");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "chain without data",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { hasData: false, data: "ignored" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "no data" });
    });

    it("multiple when clauses (a && b && c pattern)", async () => {
      const testPattern = pattern<{ a: boolean; b: boolean }>(
        ({ a, b }) => {
          // Equivalent to: a && b && "all true"
          const aAndB = when(a, b);
          const result = when(aAndB, "all true");
          return { result };
        },
      );

      // Both true
      const resultCell1 = runtime.getCell<{ result: string | boolean }>(
        space,
        "multiple when both true",
        undefined,
        tx,
      );
      const result1 = runtime.run(
        tx,
        testPattern,
        { a: true, b: true },
        resultCell1,
      );
      tx.commit();

      const value = await result1.pull();
      expect(value).toMatchObject({ result: "all true" });
    });

    it("multiple when returns false when first condition is false", async () => {
      const testPattern = pattern<{ a: boolean; b: boolean }>(
        ({ a, b }) => {
          const aAndB = when(a, b);
          const result = when(aAndB, "all true");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string | boolean }>(
        space,
        "multiple when a false",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { a: false, b: true },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: false });
    });

    it("multiple unless clauses (a || b || c pattern)", async () => {
      const testPattern = pattern<{ a: string; b: string }>(
        ({ a, b }) => {
          // Equivalent to: a || b || "default"
          const aOrB = unless(a, b);
          const result = unless(aOrB, "default");
          return { result };
        },
      );

      // First is truthy
      const resultCell1 = runtime.getCell<{ result: string }>(
        space,
        "multiple unless first truthy",
        undefined,
        tx,
      );
      const result1 = runtime.run(
        tx,
        testPattern,
        { a: "first", b: "second" },
        resultCell1,
      );
      tx.commit();

      const value = await result1.pull();
      expect(value).toMatchObject({ result: "first" });
    });

    it("multiple unless falls through to second when first is falsy", async () => {
      const testPattern = pattern<{ a: string; b: string }>(
        ({ a, b }) => {
          const aOrB = unless(a, b);
          const result = unless(aOrB, "default");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "multiple unless second truthy",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { a: "", b: "second" },
        resultCell,
      );
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "second" });
    });

    it("multiple unless falls through to default when all are falsy", async () => {
      const testPattern = pattern<{ a: string; b: string }>(
        ({ a, b }) => {
          const aOrB = unless(a, b);
          const result = unless(aOrB, "default");
          return { result };
        },
      );

      const resultCell = runtime.getCell<{ result: string }>(
        space,
        "multiple unless all falsy",
        undefined,
        tx,
      );
      const result = runtime.run(tx, testPattern, { a: "", b: "" }, resultCell);
      tx.commit();

      const value = await result.pull();
      expect(value).toMatchObject({ result: "default" });
    });
  });
});
