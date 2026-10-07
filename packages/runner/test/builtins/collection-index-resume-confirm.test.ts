import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  collectionIndex,
  type CollectionIndexInput,
} from "../../src/builtins/collection-index.ts";
import type { MaintainedCollectionIndex } from "../../src/builtins/collection-index-membership.ts";
import { type AddCancel, useCancelGroup } from "../../src/cancel.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Action } from "../../src/scheduler.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

/**
 * A resumed index finds its members' result documents on the server, and
 * nothing else syncs them: the index publishes its buckets' elements, never
 * its members. Setup staged against an unsynced replica reads each at
 * sequence zero and the commit is rejected as a stale read, taking every
 * member's first commit with it. So a resuming coordinator confirms those
 * documents before it stages any member's setup, and starts no member while
 * a confirmation is still outstanding.
 */
describe("collection-index-resume-confirm", () => {
  it("starts no member of a resumed index until the members' result documents have confirmed", async () => {
    const signer = await Identity.fromPassphrase("index-resume-confirm");
    const space = signer.did();
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const [cancelFirst, addCancelFirst] = useCancelGroup();
    const [cancelSecond, addCancelSecond] = useCancelGroup();
    /** Confirmations held back from the resuming coordinator, in request order. */
    const heldCalls: Array<{ id: string; release: () => void }> = [];
    const releaseHeld = () => {
      for (const call of heldCalls.splice(0)) call.release();
    };
    const memberNodes = () =>
      runtime.scheduler.getGraphSnapshot().nodes
        .filter((node) => node.id.startsWith("raw:collectionIndexMember:"));
    try {
      const identity = { ...runtime.scopeKeyIdentity };
      const tx = runtime.edit();
      const elements = ["a", "b", "a"].map((label, position) => {
        const element = runtime.getCell<{ label: string }>(
          space,
          `element-${position}`,
          undefined,
          tx,
        );
        element.set({ label });
        return element;
      });
      const list = runtime.getCell<CollectionIndexInput["list"]>(
        space,
        "list",
        undefined,
        tx,
      );
      list.set(elements.map((element) => ({
        isCell: false,
        value: element.key("label").get(),
      })));
      const source = runtime.getCell<unknown[]>(
        space,
        "elements",
        undefined,
        tx,
      );
      source.set(elements);
      const inputs = runtime.getCell<CollectionIndexInput>(
        space,
        "inputs",
        undefined,
        tx,
      );
      inputs.set({ list, elements: source, mode: "group" });
      const output = runtime.getCell<MaintainedCollectionIndex>(
        space,
        "output",
      );
      const parent = runtime.getCell(space, "parent");
      expect((await tx.commit().settled).error).toBeUndefined();
      await storage.synced();

      /** Runs one coordinator over the stored index; `awaitSync` marks a resume. */
      const start = (awaitSync: boolean, addCancel: AddCancel) => {
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
          awaitSync,
        );
        if (typeof coordinator === "function") {
          throw new Error("Expected coordinator wrapper");
        }
        const action: Action = (actionTx) => {
          actionTx.tx.scopeKeyIdentity = identity;
          return coordinator.action(actionTx);
        };
        coordinator.onActionRegistered?.(action);
        addCancel(runtime.scheduler.subscribe(action, { isEffect: true }));
      };

      // A first session populates the index and its three members.
      start(false, addCancelFirst);
      await runtime.idle();
      expect(memberNodes()).toHaveLength(3);
      const memberIds = new Set(
        memberNodes().map((node) => node.id),
      );
      cancelFirst();
      await runtime.idle();

      // A second session resumes it. Its inputs confirm at once; the
      // confirmations issued after that are the ones the setup waits on, and
      // they are held here.
      const sync = storage.syncCell.bind(storage);
      const inputIds = new Set(
        [list, source, inputs].map((cell) => cell.getAsNormalizedFullLink().id),
      );
      let holdOthers = false;
      using _sync = stub(storage, "syncCell", (cell, options) => {
        const id = cell.getAsNormalizedFullLink().id;
        if (!holdOthers || inputIds.has(id)) return sync(cell, options);
        const gate = Promise.withResolvers<void>();
        heldCalls.push({ id, release: () => gate.resolve() });
        return gate.promise.then(() => sync(cell, options));
      });
      const runsBefore = new Map(
        memberNodes().map((node) => [node.id, node.stats?.runCount ?? 0]),
      );
      holdOthers = true;
      using starts = spy(runtime.runner, "run");
      start(true, addCancelSecond);
      // Scheduler actions finish while the storage confirmations remain held.
      await runtime.scheduler.idle();
      // The first round confirms the index and its state.
      expect(heldCalls).toHaveLength(2);
      expect(starts.calls).toHaveLength(0);
      releaseHeld();
      await storage.synced();
      await runtime.scheduler.idle();
      // The second round confirms the two enumerations and the three members'
      // result documents, and no setup has been staged while it is
      // outstanding.
      expect(heldCalls.length).toBeGreaterThanOrEqual(5);
      expect(starts.calls).toHaveLength(0);

      releaseHeld();
      await storage.synced();
      await runtime.idle();
      // The members' setup was staged once their documents confirmed, and
      // the same three members each ran once more.
      expect(starts.calls.length).toBeGreaterThanOrEqual(3);
      const resumed = memberNodes();
      expect(resumed).toHaveLength(3);
      expect(new Set(resumed.map((node) => node.id))).toEqual(memberIds);
      for (const node of resumed) {
        expect([node.id, node.stats?.runCount]).toEqual([
          node.id,
          (runsBefore.get(node.id) ?? 0) + 1,
        ]);
      }
    } finally {
      releaseHeld();
      cancelSecond();
      cancelFirst();
      await storage.synced();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });
});
