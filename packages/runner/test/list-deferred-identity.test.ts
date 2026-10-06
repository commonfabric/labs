import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { filter, FILTER_INPUT_SCHEMA } from "../src/builtins/filter.ts";
import { flatMap, FLATMAP_INPUT_SCHEMA } from "../src/builtins/flatmap.ts";
import { map, MAP_INPUT_SCHEMA } from "../src/builtins/map.ts";
import { listCoordinatorPlan } from "../src/builtins/list-coordinator-plan.ts";
import { listElementKeys } from "../src/builtins/list-element-keys.ts";
import { createResumeRepublisher } from "../src/builtins/resume-republish.ts";
import { useCancelGroup } from "../src/cancel.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Deferred writes use captured identities after their initiating transactions settle. */
describe("list deferred identity", () => {
  for (
    const [name, builtin, schema] of [
      ["map", map, MAP_INPUT_SCHEMA],
      ["filter", filter, FILTER_INPUT_SCHEMA],
      ["flatMap", flatMap, FLATMAP_INPUT_SCHEMA],
    ] as const
  ) {
    it(`retains the ${name} input until its identity-bound sync confirms emptiness`, async () => {
      const signer = await Identity.fromPassphrase(`deferred-${name}`);
      const storage = EmulatedStorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const [cancel, addCancel] = useCancelGroup();
      const held = Promise.withResolvers<void>();
      try {
        const identity = { ...runtime.scopeKeyIdentity };
        const { pattern } = createTrustedBuilder(runtime).commonfabric;
        const op = pattern(({ element }: { element: number }) => ({
          value: element,
        }));
        let tx = runtime.edit();
        const list = runtime.getCell<number[]>(
          signer.did(),
          "list",
          undefined,
          tx,
        );
        list.set([]);
        const inputs = runtime.getCell<{ list: number[]; op: typeof op }>(
          signer.did(),
          "inputs",
          undefined,
          tx,
        );
        inputs.set({ list, op });
        const parent = runtime.getCell(signer.did(), "parent", undefined, tx);
        const output = runtime.getCell(signer.did(), "output")
          .getAsNormalizedFullLink();
        const plan = listCoordinatorPlan(
          runtime,
          tx,
          name,
          inputs,
          schema,
          parent,
          output,
        );
        const element = runtime.getCell<number>(
          signer.did(),
          "old-element",
          undefined,
          tx,
        );
        element.set(42);
        plan.container.set([element]);
        expect((await tx.commit().settled).error).toBeUndefined();
        await storage.synced();
        const sync = storage.syncCell.bind(storage);
        const syncIdentities: unknown[] = [];
        using _sync = stub(storage, "syncCell", (cell, options) => {
          if (
            cell.getAsNormalizedFullLink().id !==
              list.getAsNormalizedFullLink().id
          ) return sync(cell, options);
          syncIdentities.push(options?.scopeKeyIdentity);
          return held.promise.then(() => cell);
        });
        const stamp = runtime.stampServerRun.bind(runtime);
        const stamps: unknown[] = [];
        using _stamp = stub(runtime, "stampServerRun", (transaction, info) => {
          stamps.push({ identity: transaction.tx.scopeKeyIdentity, info });
          stamp(transaction, info);
        });
        const coordinator = builtin(
          inputs.withTx(),
          () => {},
          addCancel,
          {},
          parent.withTx(),
          runtime,
          output,
          true,
        );
        if (typeof coordinator === "function") {
          throw new Error("Expected coordinator");
        }
        tx = runtime.edit();
        tx.tx.scopeKeyIdentity = identity;
        coordinator.action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(plan.container.withTx().get()).toEqual([42]);
        expect(syncIdentities).toEqual([identity]);
        expect(stamps).toEqual([]);
        held.resolve();
        await storage.synced();
        expect(plan.container.withTx().get()).toEqual([]);
        expect(stamps).toEqual([{
          identity,
          info: {
            actionId: `${name}/resume-settle/${parent.sourceURI}`,
            kind: "derivation",
            scopeKeyIdentity: identity,
          },
        }]);
      } finally {
        held.resolve();
        cancel();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    });
  }

  it("republishes with the captured identity after a predicate sync settles", async () => {
    const signer = await Identity.fromPassphrase("deferred-republisher");
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const held = Promise.withResolvers<void>();
    try {
      const identity = { ...runtime.scopeKeyIdentity };
      const tx = runtime.edit();
      const element = runtime.getCell<number>(
        signer.did(),
        "element",
        undefined,
        tx,
      );
      element.set(42);
      const predicate = runtime.getCell<boolean>(
        signer.did(),
        "predicate",
        undefined,
        tx,
      );
      predicate.set(false);
      const inputs = runtime.getCell<{ list: number[] }>(
        signer.did(),
        "inputs",
        undefined,
        tx,
      );
      inputs.set({ list: [element] });
      const result = runtime.getCell<number[]>(
        signer.did(),
        "result",
        undefined,
        tx,
      );
      result.set([element]);
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();
      const sync = storage.syncCell.bind(storage);
      const syncIdentities: unknown[] = [];
      using _sync = stub(storage, "syncCell", (cell, options) => {
        if (
          cell.getAsNormalizedFullLink().id !==
            predicate.getAsNormalizedFullLink().id
        ) return sync(cell, options);
        syncIdentities.push(options?.scopeKeyIdentity);
        return held.promise.then(() => cell);
      });
      const stamp = runtime.stampServerRun.bind(runtime);
      const stamps: unknown[] = [];
      using _stamp = stub(runtime, "stampServerRun", (transaction, info) => {
        stamps.push({ identity: transaction.tx.scopeKeyIdentity, info });
        stamp(transaction, info);
      });
      const key = listElementKeys([element]).get(0)!;
      const republisher = createResumeRepublisher({
        runtime,
        identity,
        logger: getLogger("deferred-republisher"),
        isActive: () => true,
        getResult: () => result.withTx(),
        inputsCell: inputs.withTx(),
        inputSchema: {
          type: "object",
          properties: {
            list: {
              type: "array",
              items: { asCell: ["cell"], type: "unknown" },
            },
          },
        },
        resultSchema: {
          type: "array",
          items: { asCell: ["cell"], type: "unknown" },
        },
        elementRuns: new Map([[key, {
          resultCell: predicate.withTx(),
          lastIndex: 0,
          needsSetup: false,
        }]]),
        contribute: (value, original, out) => {
          if (value) out.push(original);
          return value === undefined ? "pending" : undefined;
        },
        aggregateNoun: "filtered list",
        elementNoun: "predicate",
        rearmReconcile: () => {},
      });
      republisher.awaitPendingThenRepublish([predicate.withTx()]);
      expect(syncIdentities).toEqual([identity]);
      expect(result.withTx().get()).toEqual([42]);
      expect(stamps).toEqual([]);
      held.resolve();
      await storage.synced();
      expect(result.withTx().get()).toEqual([]);
      expect(stamps).toEqual([{
        identity,
        info: {
          actionId: `list-republish/${result.sourceURI}`,
          kind: "bookkeeping",
          scopeKeyIdentity: identity,
        },
      }]);
    } finally {
      held.resolve();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});
