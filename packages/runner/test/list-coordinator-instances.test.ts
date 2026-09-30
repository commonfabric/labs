import { Identity } from "@commonfabric/identity";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Pattern } from "../src/builder/types.ts";
import { filter } from "../src/builtins/filter.ts";
import { flatMap } from "../src/builtins/flatmap.ts";
import { map } from "../src/builtins/map.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
} from "../src/builtins/list-coordinator-plan.ts";
import { listInstanceCoordinator } from "../src/builtins/list-instance-coordinator.ts";
import type { Action } from "../src/scheduler.ts";
import { useCancelGroup } from "../src/cancel.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getMetaCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** One serving coordinator must stage each principal's physical child instance. */
describe("list-coordinator-instances", () => {
  it("does not instantiate a coordinator for an action invoked after cancellation", () => {
    const [cancel, addCancel] = useCancelGroup();
    let created = 0;
    let ran = 0;
    const coordinator = listInstanceCoordinator(() => {
      created++;
      return {
        action: () => {
          ran++;
        },
      };
    }, addCancel);
    if (typeof coordinator === "function") {
      throw new Error("Expected a coordinator wrapper");
    }
    cancel();
    // A canceled owner must be rejected before inspecting or retaining a queued transaction.
    coordinator.action({} as IExtendedStorageTransaction);
    expect(created).toBe(0);
    expect(ran).toBe(0);
  });

  it("forwards registration to existing instances and instances created afterward", () => {
    const [cancel, addCancel] = useCancelGroup();
    const registrations: Action[][] = [];
    const coordinator = listInstanceCoordinator(() => {
      const registered: Action[] = [];
      registrations.push(registered);
      return {
        action: () => {},
        onActionRegistered: (action) => {
          registered.push(action);
        },
      };
    }, addCancel);
    if (typeof coordinator === "function") {
      throw new Error("Expected coordinator wrapper");
    }
    try {
      const transaction = { tx: {} } as IExtendedStorageTransaction;
      coordinator.action(transaction);
      expect(registrations).toEqual([[]]);
      const first: Action = () => {};
      coordinator.onActionRegistered?.(first);
      expect(registrations).toEqual([[first]]);
      coordinator.action(
        {
          tx: { scopeKeyIdentity: { principal: "did:key:second" } },
        } as IExtendedStorageTransaction,
      );
      expect(registrations).toEqual([[first], [first]]);
      const replacement: Action = () => {};
      coordinator.onActionRegistered?.(replacement);
      expect(registrations).toEqual([[first, replacement], [
        first,
        replacement,
      ]]);
      coordinator.action(transaction);
      expect(registrations).toHaveLength(2);
    } finally {
      cancel();
    }
  });

  for (
    const [name, builtin] of [["map", map], ["filter", filter], [
      "flatMap",
      flatMap,
    ]] as const
  ) {
    for (const scope of ["user", "session"] as const) {
      it(`sets up the same named ${scope}-scoped ${name} child for both serving identities`, async () => {
        const signer = await Identity.fromPassphrase(
          "list-coordinator-instances",
        );
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const engine = await server.engineForSpace(signer.did());
        expect(
          acquireExecutionLease(engine, {
            space: signer.did(),
            holder: executionLeaseHolder(signer.did()),
            now: Date.now(),
            ttlMs: 60000,
          }),
        ).toBe(true);
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const actors = await Promise.all([
          Identity.fromPassphrase("map-alice"),
          Identity.fromPassphrase(
            scope === "session" ? "map-alice" : "map-bob",
          ),
        ]);
        const identities = actors.map((actor, index) => ({
          principal: actor.did(),
          sessionId: `session-${index}` as never,
        }));
        const cancellations: (() => void)[] = [];
        const actorRuntimes: Runtime[] = [];
        try {
          const { pattern } = createTrustedBuilder(runtime).commonfabric;
          const op = pattern(({ element }: { element: number }) => ({
            value: element,
          }));
          const inputs = runtime.getCell<{ list: unknown[]; op: Pattern }>(
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
          for (const position of identities.keys()) {
            const actorStorage = EmulatedStorageManager.connectTo(server, {
              as: actors[position],
            });
            const actorRuntime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager: actorStorage,
              experimental: { serverExecution: false },
            });
            actorRuntimes.push(actorRuntime);
            identities[position] = actorRuntime
              .scopeKeyIdentity as typeof identities[number];
            const identity = identities[position];
            const tx = actorRuntime.edit();
            const element = actorRuntime.getCell<number>(
              signer.did(),
              "element",
              undefined,
              tx,
              scope,
            );
            element.set(position + 1);
            actorRuntime.getCellFromLink(
              inputs.getAsNormalizedFullLink(),
              undefined,
              tx,
            ).set({ list: [element], op });
            expect((await tx.commit()).error).toBeUndefined();
            await actorStorage.synced();
            await storage.syncInstance(
              inputs.getAsNormalizedFullLink(),
              identity,
            );
            await storage.syncInstance(
              element.getAsNormalizedFullLink(),
              identity,
            );
          }
          expect(identities[0].sessionId).not.toBe(identities[1].sessionId);
          if (scope === "session") {
            expect(identities[0].principal).toBe(identities[1].principal);
          } else {
            expect(identities[0].principal).not.toBe(identities[1].principal);
          }
          const coordinator = builtin(
            inputs,
            () => {},
            (cancel) => {
              if (cancel) cancellations.push(cancel);
            },
            {},
            parent,
            runtime,
            output,
          );
          if (typeof coordinator === "function") {
            throw new Error("Expected a map coordinator");
          }
          const childNames: string[] = [];
          for (const [position, identity] of identities.entries()) {
            // The same coordinator stages each actor's transaction, whose
            // connection also commits under that actor's physical scope.
            const actorRuntime = actorRuntimes[position];
            const tx = actorRuntime.edit();
            tx.tx.scopeKeyIdentity = identity;
            const plan = listCoordinatorPlan(
              runtime,
              tx,
              name,
              inputs,
              {
                type: "object",
                properties: { op: { asCell: ["cell"] } },
              },
              parent,
              output,
            );
            const child = listElementResultCell(
              runtime,
              tx,
              name,
              plan.container,
              [...plan.elementKeys.values()][0],
            );
            childNames.push(child.getAsNormalizedFullLink().id);
            coordinator.action(tx);
            const argument = getMetaCell(child, "argument", tx).getRaw();
            expect(
              argument,
              `missing staged child setup for ${
                identity === identities[0] ? "Alice" : "Bob"
              }`,
            ).toBeDefined();
            runtime.prepareTxForCommit(tx);
            expect((await tx.commit()).error).toBeUndefined();
            const durableChild = actorRuntime.getCellFromLink(
              child.getAsNormalizedFullLink(),
            );
            expect(durableChild.getArgumentCell()).toBeDefined();
          }
          expect(childNames[0]).toBe(childNames[1]);
        } finally {
          for (const cancel of cancellations) cancel();
          for (const actorRuntime of actorRuntimes) {
            await actorRuntime.dispose();
          }
          await storage.synced();
          await runtime.dispose({ closeStorage: false });
          await storage.close();
          await server.close();
        }
      });
    }
  }
});
