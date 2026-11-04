import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { aggregate } from "../src/builtins/aggregate.ts";
import { useCancelGroup } from "../src/cancel.ts";
import { isRawBuiltinResult } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("aggregate-resume");

describe("aggregate resume", () => {
  it("confirms a cold linked collection before reconciling membership", async () => {
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const firstStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const secondStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const first = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: firstStorage,
    });
    const second = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorage,
    });
    const [cancel, addCancel] = useCancelGroup();
    try {
      const setup = first.edit();
      const list = first.getCell<number[]>(
        signer.did(),
        "cold list",
        undefined,
        setup,
      );
      list.set([1, 2, 3]);
      const inputs = first.getCell<{ list: number[]; operation: "count" }>(
        signer.did(),
        "cold wrapper",
        undefined,
        setup,
      );
      inputs.set({ list, operation: "count" });
      const parent = first.getCell(
        signer.did(),
        "cold parent",
        undefined,
        setup,
      );
      parent.set({});
      await setup.commit().settled;
      await firstStorage.synced();
      const coldInputs = second.getCellFromLink<
        { list: number[]; operation: "count" }
      >(inputs.getAsNormalizedFullLink());
      await coldInputs.key("list").sync();
      const output = second.getCell<unknown>(signer.did(), "cold output");
      const coldParent = second.getCellFromLink(
        parent.getAsNormalizedFullLink(),
      );
      await coldParent.sync();
      const builtin = aggregate(
        coldInputs,
        (tx, value) => output.withTx(tx).set(value),
        addCancel,
        undefined,
        coldParent,
        second,
        output.getAsNormalizedFullLink(),
        true,
      );
      if (!isRawBuiltinResult(builtin)) throw new Error("Expected coordinator");
      const reconcile = second.edit();
      if (!reconcile.tx) throw new Error("Expected storage transaction");
      reconcile.tx.scopeKeyIdentity = second.scopeKeyIdentity;
      await builtin.action(reconcile);
      expect(output.withTx(reconcile).get()).toBe(3);
      second.prepareTxForCommit(reconcile);
      const committed = await reconcile.commit().settled;
      expect(committed.error).toBeUndefined();
      expect(await output.pull()).toBe(3);
    } finally {
      cancel();
      await first.dispose({ closeStorage: false });
      await second.dispose({ closeStorage: false });
      await firstStorage.close();
      await secondStorage.close();
      await server.close();
    }
  });

  for (const clearBeforeResume of [false, true]) {
    it(`restores ${clearBeforeResume ? "cleared" : "populated"} aggregates and accepts membership edits`, async () => {
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const firstStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const secondStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const first = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: firstStorage,
      });
      const second = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: secondStorage,
      });
      const program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
      import {pattern, Writable} from "commonfabric";
      export default pattern<{numbers: Writable<number[]>}>(({numbers}) => ({
        sum: numbers.sum(), count: numbers.count(), min: numbers.min(), max: numbers.max(), positive: numbers.count(n => n > 0), minimum: numbers.minBy(n => n), maximum: numbers.maxBy(n => n)
      }));
    `,
        }],
      };
      let cancelFirst: (() => void) | undefined;
      let cancelSecond: (() => void) | undefined;
      try {
        const compiled = await first.patternManager.compilePattern(program);
        const tx = first.edit();
        const numbers = first.getCell<number[]>(
          signer.did(),
          "numbers",
          undefined,
          tx,
        );
        numbers.set(Array.from({ length: 65 }, (_, n) => n));
        const result = first.run(
          tx,
          compiled,
          { numbers },
          first.getCell<
            { sum: number; count: number; min: number; max: number }
          >(
            signer.did(),
            "output",
            compiled.resultSchema,
            tx,
          ),
        );
        first.prepareTxForCommit(tx);
        await tx.commit().settled;
        cancelFirst = result.sink(() => {});
        await first.idle();
        expect(await result.pull()).toEqual({
          sum: 2080,
          count: 65,
          min: 0,
          max: 64,
          positive: 64,
          minimum: 0,
          maximum: 64,
        });
        await firstStorage.synced();
        cancelFirst();
        cancelFirst = undefined;
        first.runner.stop(result);
        if (clearBeforeResume) {
          const clear = first.edit();
          numbers.asSchema(true).withTx(clear).set(undefined);
          await clear.commit().settled;
          await firstStorage.synced();
        }
        await first.dispose({ closeStorage: false });
        await firstStorage.close();
        await second.patternManager.compilePattern(program, {
          space: signer.did(),
        });
        const restored = second.getCellFromLink<
          {
            sum: number;
            count: number;
            min: number;
            max: number;
            positive: number;
            minimum: number | undefined;
            maximum: number | undefined;
          }
        >(result.getAsNormalizedFullLink());
        cancelSecond = restored.sink(() => {});
        expect(await second.start(restored)).toBe(true);
        await second.idle();
        if (clearBeforeResume) {
          expect(await restored.key("sum").pull()).toBeUndefined();
          expect(await restored.key("count").pull()).toBeUndefined();
          expect(await restored.key("min").pull()).toBeUndefined();
          expect(await restored.key("max").pull()).toBeUndefined();
          expect(await restored.key("positive").pull()).toBe(0);
          expect(await restored.key("minimum").pull()).toBeUndefined();
          expect(await restored.key("maximum").pull()).toBeUndefined();
        } else {
          expect(await restored.pull()).toEqual({
            sum: 2080,
            count: 65,
            min: 0,
            max: 64,
            positive: 64,
            minimum: 0,
            maximum: 64,
          });
        }
        const edit = second.edit();
        second.getCellFromLink<number[]>(
          numbers.getAsNormalizedFullLink(),
          undefined,
          edit,
        ).set([10, 20, 30]);
        await edit.commit().settled;
        await second.idle();
        expect(await restored.pull()).toEqual({
          sum: 60,
          count: 3,
          min: 10,
          max: 30,
          positive: 3,
          minimum: 10,
          maximum: 30,
        });
      } finally {
        cancelFirst?.();
        cancelSecond?.();
        await first.dispose({ closeStorage: false });
        await second.dispose({ closeStorage: false });
        await firstStorage.close();
        await secondStorage.close();
        await server.close();
      }
    });
  }
});
