import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import { sendValueToBinding } from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

describe("scheduler-scoped-conflict-retry", () => {
  for (const previous of [null, "old value", undefined]) {
    it(`restores a user output whose previous value is ${String(previous)}`, async () => {
      const signer = await Identity.fromPassphrase(
        "scheduler-scoped-conflict-retry",
      );
      const space = signer.did();
      const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const readerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      using recoveries = spy(reader, "awaitCommitRetryReadiness");
      let action: Action | undefined;
      try {
        const seed = writer.edit();
        const output = writer.getCell(space, "output", undefined, seed);
        const alternate = writer.getCell(space, "alternate", undefined, seed);
        const outputLink = output.getAsNormalizedFullLink();
        const userLink = { ...outputLink, scope: "user" as const };
        alternate.set("alternate result");
        seed.writeValueOrThrow(outputLink, alternate.getAsLink());
        if (previous !== undefined) seed.writeValueOrThrow(userLink, previous);
        expect((await seed.commit()).error).toBeUndefined();
        await writerStorage.synced();
        await reader.getCellFromLink(outputLink).sync();

        const restore = (tx: IExtendedStorageTransaction) => {
          const cell = reader.getCellFromLink(outputLink, undefined, tx);
          sendValueToBinding(
            tx,
            cell,
            outputLink,
            cell.getAsWriteRedirectLink(),
            null,
            { narrowestReadScope: "user" },
          );
        };
        const outcomes: (string | undefined)[] = [];
        let attempts = 0;
        action = (tx) => {
          attempts++;
          // A broken recovery must finish the test with an incorrect output
          // instead of keeping its event loop alive forever. Concurrent dirty
          // notifications may run the action before repair completes, so the
          // assertion concerns the settled value rather than an exact run count.
          if (attempts > 8) return;
          tx.addCommitCallback((_tx, result) => {
            outcomes.push(result.error?.name);
          });
          restore(tx);
        };
        reader.scheduler.subscribe(
          action,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        await reader.scheduler.idleWithPendingCommits();
        if (previous !== undefined) {
          expect(outcomes[0]).toBe("ConflictError");
          expect(recoveries.calls.length).toBeGreaterThan(0);
        } else {
          expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);
          expect(recoveries.calls).toHaveLength(0);
        }
        expect(reader.getCellFromLink(outputLink).get()).toBeNull();
      } finally {
        if (action) reader.scheduler.unsubscribe(action);
        await reader.dispose();
        await writer.dispose();
        await readerStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }
});
