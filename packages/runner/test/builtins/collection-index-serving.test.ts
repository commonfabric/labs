import { Identity } from "@commonfabric/identity";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import {
  collectionIndex,
  type CollectionIndexInput,
} from "../../src/builtins/collection-index.ts";
import { CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE } from "../../src/cfc/types.ts";
import { isCell } from "../../src/cell.ts";
import { useCancelGroup } from "../../src/cancel.ts";
import { getMetaCell } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

/** One index coordinator stages distinct physical instances at shared scoped addresses. */
describe("collection index serving", () => {
  for (const mode of ["group", "key"] as const) {
    for (const scope of ["user", "session"] as const) {
      it(`stages ${mode} index ownership and member setup for both ${scope} identities`, async () => {
        const signer = await Identity.fromPassphrase(
          `index-serving-${mode}-${scope}`,
        );
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const engine = await server.engineForSpace(signer.did());
        expect(acquireExecutionLease(engine, {
          space: signer.did(),
          holder: executionLeaseHolder(signer.did()),
          now: Date.now(),
          ttlMs: 60000,
        })).toBe(true);
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const [cancel, addCancel] = useCancelGroup();
        const actorRuntimes: Runtime[] = [];
        try {
          const actors = await Promise.all([
            Identity.fromPassphrase("index-serving-alice"),
            Identity.fromPassphrase(
              scope === "session" ? "index-serving-alice" : "index-serving-bob",
            ),
          ]);
          const identities: ScopeKeyIdentity[] = [];
          const inputs = runtime.getCell<CollectionIndexInput>(
            signer.did(),
            "inputs",
            undefined,
            undefined,
            scope,
          );
          const parent = runtime.getCell(signer.did(), "parent");
          const output = runtime.getCell(
            signer.did(),
            "output",
            undefined,
            undefined,
            scope,
          ).getAsNormalizedFullLink();
          for (const [position, actor] of actors.entries()) {
            const actorStorage = EmulatedStorageManager.connectTo(server, {
              as: actor,
            });
            let actorRuntime: Runtime;
            try {
              actorRuntime = new Runtime({
                apiUrl: new URL(import.meta.url),
                storageManager: actorStorage,
                experimental: { serverExecution: false },
              });
            } catch (error) {
              await actorStorage.close();
              throw error;
            }
            actorRuntimes.push(actorRuntime);
            const identity = { ...actorRuntime.scopeKeyIdentity };
            identities.push(identity);
            const tx = actorRuntime.edit();
            const element = actorRuntime.getCell<{ title: string }>(
              signer.did(),
              "element",
              undefined,
              tx,
              scope,
            );
            element.set({ title: `Row ${position}` });
            const selected = actorRuntime.getCell<
              CollectionIndexInput["list"][number]
            >(signer.did(), "selected", undefined, tx, scope);
            selected.set({ isCell: false, value: `key-${position}` });
            actorRuntime.getCellFromLink<CollectionIndexInput>(
              inputs.getAsNormalizedFullLink(),
              undefined,
              tx,
            ).set({ list: [selected], elements: [element], mode });
            expect((await tx.commit()).error).toBeUndefined();
            await actorStorage.synced();
            for (const cell of [inputs, element, selected]) {
              await storage.syncInstance(
                cell.getAsNormalizedFullLink(),
                identity,
              );
            }
          }
          expect(identities[0].sessionId).not.toBe(identities[1].sessionId);
          if (scope === "session") {
            expect(identities[0].principal).toBe(identities[1].principal);
          } else {
            expect(identities[0].principal).not.toBe(identities[1].principal);
          }
          const indexNames: string[] = [];
          const memberNames: string[] = [];
          const keysNames: string[] = [];
          const keyEntriesNames: string[] = [];
          const coordinator = collectionIndex(
            inputs,
            (tx, result) => {
              expect(isCell(result)).toBe(true);
              if (!isCell(result)) throw new Error("Expected an index Cell");
              const link = result.getAsNormalizedFullLink();
              indexNames.push(link.id);
              expect(link.scope).toBe(scope);
              expect(result.withTx(tx).getRaw()).toEqual({
                kind: "collection-index",
                mode,
                keys: expect.anything(),
                keyEntries: expect.anything(),
                buckets: {},
              });
              const keysLink = result.withTx(tx).key("keys").resolveAsCell()
                .getAsNormalizedFullLink();
              expect(keysLink.scope).toBe(scope);
              keysNames.push(keysLink.id);
              const entriesLink = result.withTx(tx).key("keyEntries")
                .resolveAsCell().getAsNormalizedFullLink();
              expect(entriesLink.scope).toBe(scope);
              keyEntriesNames.push(entriesLink.id);
              expect(entriesLink.id).not.toBe(keysLink.id);
              const ownership = tx.getCfcState().writePolicyInputs.find((
                input,
              ) =>
                input.kind === "structural-provenance" &&
                input.claim === CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE &&
                input.target.id === link.id && input.target.scope === scope &&
                tx.isRuntimeWritePolicyInput(input)
              );
              expect(ownership).toBeDefined();
            },
            addCancel,
            {},
            parent,
            runtime,
            output,
          );
          if (typeof coordinator === "function") {
            throw new Error("Expected coordinator wrapper");
          }
          using childRuns = spy(runtime.runner, "run");
          for (const [position, identity] of identities.entries()) {
            // The actor connection commits under the same physical scope
            // that the shared serving coordinator reads for this instance.
            const actorRuntime = actorRuntimes[position];
            const tx = actorRuntime.edit();
            tx.tx.scopeKeyIdentity = identity;
            const before = childRuns.calls.length;
            coordinator.action(tx);
            expect(
              childRuns.calls.length - before,
              `missing member setup for identity ${position}`,
            ).toBe(3);
            const keysChild = childRuns.calls[before].args[3];
            expect(isCell(keysChild)).toBe(true);
            if (!isCell(keysChild)) throw new Error("Expected keys Cell");
            expect(keysChild.getAsNormalizedFullLink().scope).toBe(scope);
            expect(
              keysChild.withTx(tx).resolveAsCell().getAsNormalizedFullLink().id,
            ).toBe(keysNames[position]);
            expect(
              getMetaCell(keysChild, "argument", tx).key("state")
                .resolveAsCell().getAsNormalizedFullLink().scope,
            ).toBe(scope);
            const entriesChild = childRuns.calls[before + 1].args[3];
            expect(isCell(entriesChild)).toBe(true);
            if (!isCell(entriesChild)) {
              throw new Error("Expected key entries Cell");
            }
            expect(entriesChild.getAsNormalizedFullLink().scope).toBe(scope);
            expect(
              entriesChild.withTx(tx).resolveAsCell().getAsNormalizedFullLink()
                .id,
            ).toBe(keyEntriesNames[position]);
            expect(
              getMetaCell(entriesChild, "argument", tx).key("state")
                .resolveAsCell().getAsNormalizedFullLink().scope,
            ).toBe(scope);
            expect(
              getMetaCell(entriesChild, "argument", tx).key("tagged").get(),
            )
              .toBe(true);
            const call = childRuns.calls[before + 2];
            const child = call.args[3];
            expect(isCell(child)).toBe(true);
            if (!isCell(child)) throw new Error("Expected member Cell");
            const link = child.getAsNormalizedFullLink();
            memberNames.push(link.id);
            expect(link.scope).toBe(scope);
            const argument = getMetaCell(child, "argument", tx);
            expect(
              argument.getRaw(),
              `missing staged argument for identity ${position}`,
            ).toBeDefined();
            expect(argument.key("element").get()).toEqual({
              title: `Row ${position}`,
            });
            expect(argument.key("extracted").get()).toEqual({
              isCell: false,
              value: `key-${position}`,
            });
            expect(
              argument.key("index").resolveAsCell().getAsNormalizedFullLink()
                .scope,
            ).toBe(scope);
            expect(
              argument.key("state").resolveAsCell().getAsNormalizedFullLink()
                .scope,
            ).toBe(scope);
            runtime.prepareTxForCommit(tx);
            expect((await tx.commit()).error).toBeUndefined();
            expect(
              actorRuntime.getCellFromLink(link).getArgumentCell()
                ?.key("extracted").get(),
            ).toEqual({ isCell: false, value: `key-${position}` });
          }
          expect(indexNames).toHaveLength(2);
          expect(indexNames[0]).toBe(indexNames[1]);
          expect(memberNames[0]).toBe(memberNames[1]);
          expect(keysNames[0]).toBe(keysNames[1]);
          expect(keyEntriesNames[0]).toBe(keyEntriesNames[1]);
        } finally {
          cancel();
          for (const actorRuntime of actorRuntimes) {
            await actorRuntime.dispose();
          }
          await runtime.dispose({ closeStorage: false });
          await storage.close();
          await server.close();
        }
      });
    }
  }
});
