import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  collectionKeyBucket,
  resolveCollectionKey,
} from "../../src/builtins/collection-index-key.ts";
import {
  type CollectionIndexMembership,
  maintainCollectionIndexMembership,
  type MaintainedCollectionIndex,
} from "../../src/builtins/collection-index-membership.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

describe("collection-index-reconciliation", () => {
  for (const method of ["groupBy", "keyBy"] as const) {
    for (const keepCurrent of [false, true]) {
      it(`reconciles late ${method} membership when the source is ${keepCurrent ? "partly retained" : "empty"}`, async () => {
        const signer = await Identity.fromPassphrase(
          `late-membership-${method}`,
        );
        const storage = EmulatedStorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
        let cancel: (() => void) | undefined;
        try {
          const compiled = await runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
            import { pattern, Writable } from "commonfabric";
            export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
              const index = rows.${method}(row => row.label);
              return {index, selected: index.lookup("old")};
            });
          `,
            }],
          });
          let tx = runtime.edit();
          const old = runtime.getCell<{ label: string }>(
            signer.did(),
            "old",
            undefined,
            tx,
          );
          old.set({ label: "initial" });
          const current = runtime.getCell<{ label: string }>(
            signer.did(),
            "current",
            undefined,
            tx,
          );
          current.set({ label: "current" });
          const rows = runtime.getCell<{ label: string }[]>(
            signer.did(),
            "rows",
            undefined,
            tx,
          );
          rows.set(keepCurrent ? [old, current] : [old]);
          const result = runtime.run(
            tx,
            compiled,
            { rows },
            runtime.getCell<
              { index: MaintainedCollectionIndex; selected: unknown }
            >(signer.did(), "result", compiled.resultSchema, tx),
          );
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
          cancel = result.key("selected").sink(() => {});
          await runtime.idle();
          expect(result.key("selected").get()).toEqual(
            method === "groupBy" ? [] : undefined,
          );
          /** Counts source reconciliation separately from member actions. */
          const coordinatorRuns = () =>
            runtime.scheduler.getGraphSnapshot().nodes
              .filter((node) => node.id.startsWith("raw:collectionIndex:"))
              .map((node) => node.stats?.runCount);
          const before = coordinatorRuns();
          expect(before).toHaveLength(1);
          // Moving an existing member between buckets must not wake the source
          // coordinator: only assignment membership needs reconciliation.
          tx = runtime.edit();
          old.withTx(tx).key("label").set("old");
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          expect(result.key("selected").get()).toEqual(
            method === "groupBy" ? [{ label: "old" }] : { label: "old" },
          );
          expect(coordinatorRuns()).toEqual(before);
          const index = result.key("index").resolveAsCell().asSchema<
            MaintainedCollectionIndex
          >(undefined);
          const state = runtime.getCell<CollectionIndexMembership>(
            signer.did(),
            { collectionIndexState: index },
          );
          const assignments = Object.values(state.key("assignments").get());
          expect(assignments).toHaveLength(keepCurrent ? 2 : 1);
          const occurrence = assignments.find((assignment) =>
            assignment?.bucket ===
              collectionKeyBucket({ kind: "string", value: "old" })
          )!.occurrence;
          tx = runtime.edit();
          rows.withTx(tx).set(keepCurrent ? [current] : []);
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          expect(result.key("selected").get()).toEqual(
            method === "groupBy" ? [] : undefined,
          );
          // Another session's member update can arrive after this session has
          // already reconciled the source change. No further source edit follows.
          tx = runtime.edit();
          maintainCollectionIndexMembership(
            tx,
            state,
            index,
            method === "groupBy" ? "group" : "key",
            occurrence,
            resolveCollectionKey(runtime, tx, "old"),
            old,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          expect(result.key("selected").get()).toEqual(
            method === "groupBy" ? [] : undefined,
          );
          expect(
            index.key("buckets").key(
              collectionKeyBucket({ kind: "string", value: "old" }),
            ).get(),
          ).toBeUndefined();
          expect(Object.keys(state.key("assignments").get())).toHaveLength(
            keepCurrent ? 1 : 0,
          );
          const retained = index.key("buckets").key(
            collectionKeyBucket({ kind: "string", value: "current" }),
          );
          expect(retained.get()).toEqual(
            keepCurrent
              ? (method === "groupBy"
                ? [{ label: "current" }]
                : { label: "current" })
              : undefined,
          );
        } finally {
          cancel?.();
          await storage.synced();
          await runtime.dispose({ closeStorage: false });
          await storage.close();
        }
      });
    }
  }
});
