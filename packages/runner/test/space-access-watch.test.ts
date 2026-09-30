import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { SpaceAccessWatch } from "../src/space-access-watch.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("space-access-watch");
const spaceA = "did:key:z6Mk-space-access-watch-a" as MemorySpace;
const spaceB = "did:key:z6Mk-space-access-watch-b" as MemorySpace;

/**
 * A storage manager's access-change subscription, reduced to what the watch
 * uses, which records how many subscriptions are live and delivers a change.
 */
class FakeStorage {
  observers = new Set<(space: MemorySpace) => void>();

  subscribeSpaceAccessChange(
    observer: (space: MemorySpace) => void,
  ): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  change(space: MemorySpace): void {
    for (const observer of [...this.observers]) observer(space);
  }
}

/** Returns a stand-in action, which a test only compares by identity. */
const fakeAction = (): Action => (() => {}) as unknown as Action;

describe("SpaceAccessWatch", () => {
  let disposables: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const dispose of disposables.reverse()) await dispose();
    disposables = [];
  });

  /** Returns a watch over a fake storage manager, and what it invalidated. */
  function watchOverFake() {
    const storage = new FakeStorage();
    const invalidated: Action[] = [];
    const watch = new SpaceAccessWatch(storage, {
      invalidateAction: (action: Action) => invalidated.push(action),
    });
    return { storage, invalidated, watch };
  }

  describe("instance members", () => {
    describe("rerunOnChange()", () => {
      it("runs an action again at the next change for its space, and only once", () => {
        const { storage, invalidated, watch } = watchOverFake();
        const action = fakeAction();
        watch.rerunOnChange(spaceA, action);

        storage.change(spaceB);
        expect(invalidated).toEqual([]);
        storage.change(spaceA);
        expect(invalidated).toEqual([action]);
        storage.change(spaceA);
        expect(invalidated).toEqual([action]);
      });

      it("subscribes to the storage manager once, however many actions register", () => {
        const { storage, watch } = watchOverFake();
        expect(storage.observers.size).toBe(0);
        watch.rerunOnChange(spaceA, fakeAction());
        watch.rerunOnChange(spaceB, fakeAction());
        expect(storage.observers.size).toBe(1);
      });
    });

    describe("dispose()", () => {
      it("cancels the subscription, and runs nothing again afterward", () => {
        const { storage, invalidated, watch } = watchOverFake();
        watch.rerunOnChange(spaceA, fakeAction());
        expect(storage.observers.size).toBe(1);

        watch.dispose();
        expect(storage.observers.size).toBe(0);
        watch.rerunOnChange(spaceA, fakeAction());
        expect(storage.observers.size).toBe(0);
        storage.change(spaceA);
        expect(invalidated).toEqual([]);
      });

      it("is what disposing its runtime does, when the storage manager outlives the runtime", async () => {
        const storageManager = EmulatedStorageManager.emulate({ as: signer });
        disposables.push(() => storageManager.close());
        // Counts the subscriptions the runtime holds on the manager.
        const subscribe = storageManager.subscribeSpaceAccessChange.bind(
          storageManager,
        );
        let live = 0;
        storageManager.subscribeSpaceAccessChange = (observer) => {
          const cancel = subscribe(observer);
          live += 1;
          return () => {
            live -= 1;
            cancel();
          };
        };
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        runtime.spaceAccessWatch.rerunOnChange(spaceA, fakeAction());
        expect(live).toBe(1);

        await runtime.dispose({ closeStorage: false });
        expect(live).toBe(0);
      });
    });
  });
});
