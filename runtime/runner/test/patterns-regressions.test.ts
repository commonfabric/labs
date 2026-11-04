import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, type FactoryInput, NAME } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import type { Pattern } from "../src/builder/types.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Regressions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let ifElse: ReturnType<typeof createBuilder>["commonfabric"]["ifElse"];
  let handler: ReturnType<typeof createBuilder>["commonfabric"]["handler"];

  const bindBuilder = () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      lift,
      pattern,
      ifElse,
      handler,
    } = commonfabric);
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();
    bindBuilder();
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

  it("preserves cell references when map truncates with ifElse null values", async () => {
    // Map truncation must keep cell references when ifElse returns null:
    // slicing through `.get()` would dereference the cells and null values
    // would lose their cell refs.
    //
    // Create a map with ifElse that returns null for some items, then remove
    // an item from the source array. The remaining items must still be
    // accessible (not undefined due to broken cell references).

    const testPattern = pattern<
      { items: Array<{ name: string; visible: boolean }> }
    >(
      ({ items }) => {
        // Map over items, returning item name if visible, null otherwise
        const mapped = (items as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((item: any) =>
              ifElse(
                lift((i: { name: string; visible: boolean }) => i.visible)(
                  item,
                ),
                lift((i: { name: string; visible: boolean }) => i.name)(item),
                null,
              )) as any)(element, index, array)
          ),
          {},
        );
        return { items, mapped };
      },
    );

    const resultCell = runtime.getCell<{
      items: Array<{ name: string; visible: boolean }>;
      mapped: Array<string | null>;
    }>(
      space,
      "ct-1158-map-truncation",
      undefined,
      tx,
    );

    // Start with 3 items: A (visible), B (hidden), C (visible)
    const result = runtime.run(tx, testPattern, {
      items: [
        { name: "A", visible: true },
        { name: "B", visible: false },
        { name: "C", visible: true },
      ],
    }, resultCell);
    await commitTx();

    await result.pull();

    // Verify initial state: ["A", null, "C"]
    const initialMapped = result.key("mapped").get();
    expect(initialMapped).toHaveLength(3);
    expect(initialMapped[0]).toBe("A");
    expect(initialMapped[1]).toBe(null);
    expect(initialMapped[2]).toBe("C");

    // Now remove the LAST item - this triggers map truncation from 3 to 2 items
    // The truncation should preserve cell refs for items[0] and items[1]
    tx = runtime.edit();
    const currentItems = result.withTx(tx).key("items").get();
    result.withTx(tx).key("items").set(currentItems.slice(0, 2)); // Keep first 2
    await commitTx();

    await result.pull();

    // After truncation, mapped should be ["A", null]
    // BUG (before fix): null at index 1 became a broken reference, entire array invalid
    // FIXED: Cell references preserved, mapped correctly shows ["A", null]
    const afterMapped = result.key("mapped").get();
    expect(afterMapped).toHaveLength(2);
    expect(afterMapped[0]).toBe("A"); // A was visible
    expect(afterMapped[1]).toBe(null); // B was hidden, null preserved correctly
  });

  it("keeps Notebook NAME current after createNote once pulled in v2", async () => {
    await commitTx();
    await runtime.dispose();
    await storageManager.close();
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    bindBuilder();

    const notePattern = pattern<{ title: string }>(({ title }) => ({
      title,
      [NAME]: lift((value: string) => `📝 ${value}`)(title),
    }));

    const createNote = handler<
      void,
      { notes: Cell<Array<ReturnType<typeof notePattern>>> }
    >(
      true,
      {
        type: "object",
        properties: { notes: { type: "array", asCell: ["cell"] } },
      },
      (_, { notes }) => {
        const newNote = notePattern({ title: "Stream Created Note" });
        notes.push(newNote);
      },
    );

    const notebookLikePattern = pattern<{
      title: string;
      notes: Array<ReturnType<typeof notePattern>>;
    }>(({ title, notes }) => {
      const noteCount = lift(
        (items: Array<{ title: string }>) => items.length,
      )(notes);
      const displayName = lift(
        ({ title, noteCount }: { title: string; noteCount: number }) =>
          `📓 ${title} (${noteCount})`,
      )({ title, noteCount });
      return {
        title,
        notes,
        noteCount,
        [NAME]: displayName,
        createNote: createNote({ notes }),
      };
    });

    const resultCell = runtime.getCell<any>(
      space,
      "ct-notebook-name-regression",
      undefined,
      tx,
    );
    const result = runtime.run(tx, notebookLikePattern, {
      title: "Test Notebook",
      notes: [],
    }, resultCell);
    await commitTx();

    await runtime.idle();
    await storageManager.synced();
    await runtime.idle();

    await result.pull();

    expect(result.key("noteCount").get()).toBe(0);
    expect(result.key(NAME).get()).toBe("📓 Test Notebook (0)");

    result.key("createNote").send();

    await runtime.idle();
    await storageManager.synced();
    await runtime.idle();

    await result.pull();

    expect(result.key("noteCount").get()).toBe(1);
    expect(result.key(NAME).get()).toBe("📓 Test Notebook (1)");
  });

  it("clears locally prepared results when a run transaction fails to commit in v2", async () => {
    await commitTx();
    await runtime.dispose();
    await storageManager.close();

    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    bindBuilder();

    const echoPattern = pattern<{ title: string }>(({ title }) => ({ title }));
    const resultCell = runtime.getCell<{ title: string }>(
      space,
      "ct-locally-prepared-results-rollback",
      undefined,
      tx,
    );

    const runner = runtime.runner.accessForTestingOnly;
    runner.setupInternal(tx, echoPattern, { title: "draft" }, resultCell);
    const key = runner.getDocKey(resultCell);
    expect(runner.locallyPreparedResults.has(key)).toBe(true);

    const originalCommit = tx.tx.commit.bind(tx.tx);
    (tx.tx as any).commit = () =>
      createTransactionCommitReceipt(Promise.resolve({
        error: {
          name: "ConflictError",
          message: "synthetic conflict",
        },
      }));

    const result = await commitTx();
    expect(result.error?.name).toBe("ConflictError");
    expect(runner.locallyPreparedResults.has(key)).toBe(false);

    (tx.tx as any).commit = originalCommit;
    tx = runtime.edit();
  });

  it("normalizes nested builder artifacts before raw runner writes in v2", async () => {
    await commitTx();
    await runtime.dispose();
    await storageManager.close();

    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    bindBuilder();

    // Shaped like a builder artifact: a function carrying its own
    // `toEncodableForm`, which is the member the write path keys on.
    const initialRecipe = Object.assign(() => {}, {
      toEncodableForm() {
        return { name: "initial recipe" };
      },
    });
    const resultRecipe = Object.assign(() => {}, {
      toEncodableForm() {
        return { name: "result recipe" };
      },
    });

    const rawValuePattern = {
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "recipe",
        schema: { default: initialRecipe.toEncodableForm() },
      }],
      result: {
        internalRecipe: {
          $alias: { partialCause: "recipe", path: [] },
        },
        resultRecipe: resultRecipe as unknown,
      },
      nodes: [],
    } as unknown as Pattern;

    const resultCell = runtime.getCell<{
      internalRecipe: { name: string };
      resultRecipe: { name: string };
    }>(
      space,
      "ct-v2-raw-runner-normalization",
      undefined,
      tx,
    );

    const result = runtime.run(tx, rawValuePattern, {}, resultCell);
    await commitTx();

    const value = await result.pull();
    expect(value).toMatchObject({
      internalRecipe: { name: "initial recipe" },
      resultRecipe: { name: "result recipe" },
    });
  });
});
