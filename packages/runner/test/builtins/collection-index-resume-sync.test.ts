import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import {
  collectionIndex,
  type CollectionIndexInput,
} from "../../src/builtins/collection-index.ts";
import type { MaintainedCollectionIndex } from "../../src/builtins/collection-index-membership.ts";
import { useCancelGroup } from "../../src/cancel.ts";
import { type ErrorWithContext, Runtime } from "../../src/runtime.ts";
import type { Action } from "../../src/scheduler.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

/** Resume confirmation remains recoverable and respects coordinator teardown. */
describe("collection index resume sync", () => {
  for (const outcome of ["retry", "cancel-resolve", "cancel-reject"] as const) {
    const cancelWhileHeld = outcome !== "retry";
    it(
      outcome === "cancel-resolve"
        ? "does not rearm a canceled coordinator when held confirmation completes"
        : outcome === "cancel-reject"
        ? "does not report a held confirmation failure after coordinator cancellation"
        : "reports rejected confirmation and retries only after a source change",
      async () => {
        const signer = await Identity.fromPassphrase(
          `index-resume-sync-${outcome}`,
        );
        const storage = EmulatedStorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        const errors: ErrorWithContext[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const [cancel, addCancel] = useCancelGroup();
        const held = Promise.withResolvers<void>();
        const maintenanceHeld = Promise.withResolvers<void>();
        const maintenanceIds: string[] = [];
        try {
          const identity = { ...runtime.scopeKeyIdentity };
          let tx = runtime.edit();
          const list = runtime.getCell<CollectionIndexInput["list"]>(
            signer.did(),
            "list",
            undefined,
            tx,
          );
          const elements = runtime.getCell<unknown[]>(
            signer.did(),
            "elements",
            undefined,
            tx,
          );
          list.set([]);
          elements.set([]);
          const inputs = runtime.getCell<CollectionIndexInput>(
            signer.did(),
            "inputs",
            undefined,
            tx,
          );
          inputs.set({ list, elements, mode: "group" });
          const output = runtime.getCell<MaintainedCollectionIndex>(
            signer.did(),
            "output",
          );
          const parent = runtime.getCell(signer.did(), "parent");
          expect((await tx.commit().settled).error).toBeUndefined();
          await storage.synced();
          const inputIds = new Set([
            list.getAsNormalizedFullLink().id,
            elements.getAsNormalizedFullLink().id,
          ]);
          const sync = storage.syncCell.bind(storage);
          const attempts: { id: unknown; identity: unknown }[] = [];
          let holdInputs = true;
          let confirming = false;
          using _sync = stub(storage, "syncCell", (cell, options) => {
            if (!inputIds.has(cell.getAsNormalizedFullLink().id)) {
              if (!confirming) return sync(cell, options);
              maintenanceIds.push(cell.getAsNormalizedFullLink().id);
              return maintenanceHeld.promise.then(() => sync(cell, options));
            }
            attempts.push({
              id: cell.getAsNormalizedFullLink().id,
              identity: options?.scopeKeyIdentity,
            });
            return holdInputs
              ? held.promise.then(() => cell)
              : sync(cell, options);
          });
          const coordinator = collectionIndex(
            inputs.withTx(),
            (writeTx, value) => {
              output.withTx(writeTx).set(value as MaintainedCollectionIndex);
            },
            addCancel,
            {},
            parent,
            runtime,
            output.getAsNormalizedFullLink(),
            true,
          );
          if (typeof coordinator === "function") {
            throw new Error("Expected coordinator wrapper");
          }
          let runs = 0;
          const action: Action = (actionTx) => {
            actionTx.tx.scopeKeyIdentity = identity;
            runs++;
            confirming = true;
            try {
              return coordinator.action(actionTx);
            } finally {
              confirming = false;
            }
          };
          coordinator.onActionRegistered?.(action);
          using invalidations = spy(runtime.scheduler, "invalidateAction");
          addCancel(runtime.scheduler.subscribe(action, { isEffect: true }));
          // Scheduler actions finish while their storage confirmations remain held.
          await runtime.scheduler.idle();
          const heldRuns = runs;
          expect(heldRuns).toBeGreaterThan(0);
          expect(attempts).toHaveLength(2);
          expect(attempts.map((entry) => entry.identity)).toEqual([
            identity,
            identity,
          ]);
          expect(output.getRaw()).toBeUndefined();
          expect(invalidations.calls).toHaveLength(0);
          if (cancelWhileHeld) {
            cancel();
            if (outcome === "cancel-reject") {
              held.reject(new Error("confirmation failed after cancellation"));
            } else {
              held.resolve();
            }
            await storage.synced();
            expect(errors).toHaveLength(0);
            expect(invalidations.calls).toHaveLength(0);
            expect(runs).toBe(heldRuns);
            expect(output.getRaw()).toBeUndefined();
          } else {
            const rejection = new Error("injected source confirmation failure");
            held.reject(rejection);
            await storage.synced();
            expect(errors).toHaveLength(2);
            for (const error of errors) {
              expect(error.message).toBe(
                "Confirming index maintenance state failed",
              );
              expect(error.cause).toBe(rejection);
              expect(error.action).toBe(action);
            }
            expect(attempts).toHaveLength(2);
            expect(runs).toBe(heldRuns);
            expect(invalidations.calls).toHaveLength(0);
            holdInputs = false;
            tx = runtime.edit();
            elements.withTx(tx).set([1]);
            expect((await tx.commit().settled).error).toBeUndefined();
            await runtime.settled(Infinity);
            expect(attempts).toHaveLength(4);
            expect(attempts.map((entry) => entry.identity)).toEqual([
              identity,
              identity,
              identity,
              identity,
            ]);
            expect(runs).toBeGreaterThan(heldRuns);
            // Confirmed inputs with mismatched lengths must not publish a partial index.
            expect(output.getRaw()).toBeUndefined();
            tx = runtime.edit();
            elements.withTx(tx).set([]);
            expect((await tx.commit().settled).error).toBeUndefined();
            await runtime.scheduler.idleWithPendingCommits();
            expect(maintenanceIds).toHaveLength(2);
            expect(output.getRaw()).toBeUndefined();
            maintenanceHeld.resolve();
            await storage.synced();
            await runtime.scheduler.idleWithPendingCommits();
            // Full descriptor demand includes its independently computed keys.
            expect(await output.pull()).toEqual({
              kind: "collection-index",
              mode: "group",
              keys: [],
              keyEntries: [],
              buckets: {},
            });
          }
        } finally {
          held.resolve();
          maintenanceHeld.resolve();
          cancel();
          await runtime.dispose({ closeStorage: false });
          await storage.close();
        }
      },
    );
  }
});
