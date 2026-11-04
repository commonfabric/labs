import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { aggregate, aggregateNode } from "../src/builtins/aggregate.ts";
import { useCancelGroup } from "../src/cancel.ts";
import { isRawBuiltinResult } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";

describe("aggregate lifecycle", () => {
  it("rejects nonnumeric leaves and combines a populated subtree with an empty one", async () => {
    const signer = await Identity.fromPassphrase("aggregate node validation");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      const inputs = runtime.getCell<Record<string, unknown>>(
        signer.did(),
        "node inputs",
        undefined,
        tx,
      );
      const parent = runtime.getCell(
        signer.did(),
        "node parent",
        undefined,
        tx,
      );
      let published: unknown;
      const node = aggregateNode(
        inputs,
        (_tx, value) => {
          published = value;
        },
        () => {},
        undefined,
        parent,
        runtime,
      );
      if (typeof node !== "function") throw new Error("Expected node action");
      for (const operation of ["sum", "min", "max", "minBy", "maxBy"]) {
        inputs.set({
          operation,
          mode: "leaf",
          values: ["invalid"],
          keys: ["a"],
          elements: [parent.getAsNormalizedFullLink()],
          final: true,
        });
        expect(() => node(tx)).toThrow("requires numeric values");
        expect(published).toBeUndefined();
      }
      inputs.set({
        operation: "min",
        mode: "combine",
        left: {
          candidate: {
            score: 7,
            key: "a",
            element: parent.getAsNormalizedFullLink(),
          },
        },
        right: {},
        final: true,
      });
      node(tx);
      expect(published).toBe(7);
    } finally {
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("waits for matching score membership and requires a stable output binding", async () => {
    const signer = await Identity.fromPassphrase("aggregate score membership");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const [cancel, addCancel] = useCancelGroup();
    try {
      const inputs = runtime.getCell<
        { list: number[]; elements: number[]; operation: "minBy" }
      >(signer.did(), "inputs", undefined, tx);
      inputs.set({ list: [1], elements: [], operation: "minBy" });
      const parent = runtime.getCell(signer.did(), "parent", undefined, tx);
      let published = false;
      const builtin = aggregate(
        inputs,
        () => {
          published = true;
        },
        addCancel,
        undefined,
        parent,
        runtime,
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      await builtin.action(tx);
      expect(published).toBe(false);
      inputs.key("elements").set([1]);
      await expect(builtin.action(tx)).rejects.toThrow(
        "requires an output binding",
      );
      expect(published).toBe(false);
    } finally {
      cancel();
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("repairs an aborted initial reconcile and publishes later membership changes", async () => {
    const signer = await Identity.fromPassphrase("aggregate setup repair");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const [cancel, addCancel] = useCancelGroup();
    try {
      const setup = runtime.edit();
      const inputs = runtime.getCell<{
        list: number[];
        operation: "sum";
      }>(signer.did(), "inputs", undefined, setup);
      inputs.set({ list: [1, 2, 3], operation: "sum" });
      const parent = runtime.getCell(signer.did(), "parent", undefined, setup);
      parent.set({});
      const output = runtime.getCell<unknown>(signer.did(), "output");
      await setup.commit().settled;
      const builtin = aggregate(
        inputs.withTx(),
        (tx, result) => output.withTx(tx).set(result),
        addCancel,
        undefined,
        parent.withTx(),
        runtime,
        output.getAsNormalizedFullLink(),
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      const aborted = runtime.edit();
      await builtin.action(aborted);
      aborted.abort();

      const retry = runtime.edit();
      await builtin.action(retry);
      runtime.prepareTxForCommit(retry);
      await retry.commit().settled;
      addCancel(output.sink(() => {}));
      await runtime.idle();
      expect(await output.pull()).toBe(6);

      const replace = runtime.edit();
      inputs.withTx(replace).key("list").set([10, 20]);
      await replace.commit().settled;
      const reconcile = runtime.edit();
      await builtin.action(reconcile);
      runtime.prepareTxForCommit(reconcile);
      await reconcile.commit().settled;
      await runtime.idle();
      expect(await output.pull()).toBe(30);

      const invalid = runtime.edit();
      inputs.withTx(invalid).key("list").asSchema(true).set("not an array");
      await expect(builtin.action(invalid)).rejects.toThrow(
        "requires an array",
      );
      invalid.abort();
      expect(await output.pull()).toBe(30);
    } finally {
      cancel();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not publish a resumed coordinator cancelled during input synchronization", async () => {
    const signer = await Identity.fromPassphrase("aggregate cancelled resume");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const [cancel, addCancel] = useCancelGroup();
    const tx = runtime.edit();
    try {
      const inputs = runtime.getCell<{
        list: number[];
        operation: "sum";
      }>(signer.did(), "inputs", undefined, tx);
      inputs.set({ list: [1, 2, 3], operation: "sum" });
      const parent = runtime.getCell(signer.did(), "parent", undefined, tx);
      parent.set({});
      let published = false;
      const builtin = aggregate(
        inputs,
        () => {
          published = true;
        },
        addCancel,
        undefined,
        parent,
        runtime,
        parent.getAsNormalizedFullLink(),
        true,
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      const pending = builtin.action(tx);
      cancel();
      await pending;
      expect(published).toBe(false);
    } finally {
      cancel();
      tx.abort();
      await storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
