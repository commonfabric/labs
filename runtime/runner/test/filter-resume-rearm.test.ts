import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { Pattern } from "../src/builder/types.ts";
import { filter } from "../src/builtins/filter.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
} from "../src/builtins/list-coordinator-plan.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Holds predicate arrival while an index change makes its setup stale. */
describe("filter-resume-rearm", () => {
  it("invalidates the registered coordinator after deferred setup becomes writable", async () => {
    const signer = await Identity.fromPassphrase("filter-resume-rearm");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const held = Promise.withResolvers<void>();
    const cancellations: (() => void)[] = [];
    try {
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      const op = pattern((
        { element, index }: { element: number; index: number },
      ) => ({ element, index }));
      let tx = runtime.edit();
      const first = runtime.getCell<number>(
        signer.did(),
        "first",
        undefined,
        tx,
      );
      const second = runtime.getCell<number>(
        signer.did(),
        "second",
        undefined,
        tx,
      );
      first.set(1);
      second.set(2);
      const inputs = runtime.getCell<{ list: unknown[]; op: Pattern }>(
        signer.did(),
        "inputs",
        undefined,
        tx,
      );
      inputs.set({ list: [first, second], op });
      const parent = runtime.getCell(signer.did(), "parent", undefined, tx);
      const output = runtime.getCell(signer.did(), "output", undefined, tx)
        .getAsNormalizedFullLink();
      const inputSchema = {
        type: "object",
        properties: { op: { asCell: ["cell"] } },
      } as const;
      const plan = listCoordinatorPlan(
        runtime,
        tx,
        "filter",
        inputs,
        inputSchema,
        parent,
        output,
      );
      plan.container.set([]);
      const children = new Set(
        [...plan.elementKeys.values()].map((key) =>
          listElementResultCell(runtime, tx, "filter", plan.container, key)
            .getAsNormalizedFullLink().id
        ),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      // A cell syncs through the storage manager, which holds the children's.
      const storageManager = runtime.storageManager;
      const originalSyncCell = storageManager.syncCell;
      using _sync = stub(
        storageManager,
        "syncCell",
        function <T>(
          cell: Cell<T>,
          ...rest: unknown[]
        ): Promise<Cell<T>> {
          return children.has(cell.getAsNormalizedFullLink().id)
            ? held.promise.then(() => cell)
            : Reflect.apply(originalSyncCell, storageManager, [cell, ...rest]);
        },
      );
      // Predicate execution is held absent; the real coordinator still writes
      // its setup metadata and tracks whether a reordered child owes setup.
      let setups = 0;
      using _run = stub(
        runtime.runner,
        "run",
        ((...args: unknown[]) => {
          setups++;
          return args[3];
        }) as typeof runtime.runner.run,
      );
      const invalidated: Action[] = [];
      using _invalidate = stub(
        runtime.scheduler,
        "invalidateAction",
        (action) => {
          invalidated.push(action);
        },
      );
      const coordinator = filter(
        inputs.withTx(),
        () => {},
        (cancel) => {
          if (cancel) cancellations.push(cancel);
        },
        {},
        parent.withTx(),
        runtime,
        output,
        true,
      );
      if (typeof coordinator === "function") {
        throw new Error("Expected registered filter coordinator");
      }
      const registered: Action = () => {};
      coordinator.onActionRegistered?.(registered);
      tx = runtime.edit();
      coordinator.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(setups).toBe(2);
      tx = runtime.edit();
      inputs.withTx(tx).key("list").set([second, first]);
      expect((await tx.commit().settled).error).toBeUndefined();
      tx = runtime.edit();
      coordinator.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(setups).toBe(2);
      expect(invalidated).toEqual([]);
      held.resolve();
      await storage.synced();
      expect(invalidated).toEqual([registered]);
      tx = runtime.edit();
      coordinator.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(setups).toBe(4);
    } finally {
      held.resolve();
      for (const cancel of cancellations) cancel();
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    }
  });
});
