import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { preloadProfiles } from "../../src/backends/preload-profiles.ts";
import { RuntimeProcessor } from "../../src/backends/runtime-processor.ts";
import { stubWorkerBoot } from "./stub-worker-boot.ts";

const user = await Identity.fromPassphrase("profile preload active user");
const otherUser = await Identity.fromPassphrase("profile preload other user");
const persona = await Identity.fromPassphrase("profile preload persona");
const elementsSpace = await Identity.fromPassphrase("profile preload elements");
const displaySpace = await Identity.fromPassphrase("profile preload display");

function stored(manager: EmulatedStorageManager, cell: Cell<unknown>) {
  const link = cell.getAsNormalizedFullLink();
  return manager.open(link.space).replica.getDocument(link.id, link.scope);
}

function onStored(manager: EmulatedStorageManager, cell: Cell<unknown>) {
  const ready = defer<void>();
  const subscription = {
    next() {
      if (stored(manager, cell) !== undefined) ready.resolve();
      return undefined;
    },
  };
  manager.subscribe(subscription);
  subscription.next();
  return {
    promise: ready.promise,
    cancel: () => manager.unsubscribe(subscription),
  };
}

function makeRuntime(storageManager: EmulatedStorageManager): Runtime {
  return new Runtime({
    apiUrl: new URL("https://example.invalid"),
    storageManager,
  });
}

describe("preload-profiles", () => {
  it("warms the active user's roster without traversing unrelated profile content", async () => {
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const seed = makeRuntime(
      EmulatedStorageManager.connectTo(server, { as: user }),
    );
    const manager = EmulatedStorageManager.connectTo(server, { as: user });
    const runtime = makeRuntime(manager);
    const home = seed.getCell(user.did(), "home");
    const profile = seed.getCell(persona.did(), "profile");
    const otherHome = seed.getCell(otherUser.did(), otherUser.did());
    const elements = seed.getCell(elementsSpace.did(), "elements");
    const displayName = seed.getCell(displaySpace.did(), "name");
    const arrived = onStored(manager, profile);
    const displayArrived = onStored(manager, displayName);
    let cancel = () => {};
    try {
      let tx = seed.edit();
      elements.withTx(tx).set({ body: "Content outside the profile display" });
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      tx = seed.edit();
      displayName.withTx(tx).set("Active profile");
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      tx = seed.edit();
      profile.withTx(tx).set({ name: displayName, avatar: "", elements });
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      tx = seed.edit();
      home.withTx(tx).set({ profiles: [profile] });
      seed.getHomeSpaceCell(tx).asSchema(undefined).set({
        defaultPattern: home,
      });
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await seed.storageManager.synced();

      cancel = preloadProfiles(runtime);
      await arrived.promise;
      await displayArrived.promise;
      await manager.synced();
      await runtime.idle();
      expect(
        runtime.getCellFromLink(profile).asSchema(undefined).key("name").get(),
      ).toBe("Active profile");
      expect(stored(manager, home)).toBeDefined();
      expect(stored(manager, otherHome)).toBeUndefined();
      expect(stored(manager, elements)).toBeUndefined();
      expect([...runtime.runner.cancels.keys()]).toHaveLength(0);

      // A roster change warms a new profile during the same session.
      const added = seed.getCell(persona.did(), "added-profile");
      const addedArrived = onStored(manager, added);
      try {
        tx = seed.edit();
        added.withTx(tx).set({ name: "Added profile" });
        seed.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        tx = seed.edit();
        home.withTx(tx).set({ profiles: [profile, added] });
        seed.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await seed.storageManager.synced();
        await addedArrived.promise;
      } finally {
        addedArrived.cancel();
      }

      cancel();
      const afterCancel = seed.getCell(persona.did(), "after-cancel");
      tx = seed.edit();
      afterCancel.withTx(tx).set({ name: "After cancel" });
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      tx = seed.edit();
      home.withTx(tx).set({ profiles: [afterCancel] });
      seed.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await seed.storageManager.synced();
      await server.idle();
      await manager.synced();
      await runtime.idle();
      expect(stored(manager, afterCancel)).toBeUndefined();
    } finally {
      cancel();
      arrived.cancel();
      displayArrived.cancel();
      await runtime.dispose();
      await seed.dispose();
      await server.close();
    }
  });

  it("leaves an absent Home empty", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = makeRuntime(manager);
    const cancel = preloadProfiles(runtime);
    try {
      await manager.synced();
      await runtime.idle();
      expect(stored(manager, runtime.getHomeSpaceCell())).toBeUndefined();
      expect([...runtime.runner.cancels.keys()]).toHaveLength(0);
    } finally {
      cancel();
      await runtime.dispose();
    }
  });

  it("starts during worker initialization and releases its subscription on disposal", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const restore = stubWorkerBoot(() => manager);
    const workerGlobal = globalThis as { postMessage?: unknown };
    const originalPostMessage = Object.getOwnPropertyDescriptor(
      globalThis,
      "postMessage",
    );
    workerGlobal.postMessage = () => {};
    const originalGetHome = Runtime.prototype.getHomeSpaceCell;
    const release = defer<void>();
    let selectedUser: string | undefined;
    let cancelled = 0;
    // Hold the initial load: worker initialization must still return, and
    // disposal must cancel the warming subscription before draining storage.
    const originalSync = manager.syncCell.bind(manager);
    manager.syncCell = async (...args) => {
      await release.promise;
      return originalSync(...args);
    };
    Runtime.prototype.getHomeSpaceCell = function (...args) {
      selectedUser = this.userIdentityDID;
      const home = originalGetHome.apply(this, args);
      // The real sink uses resubscribe; cancellation is observable through the
      // scheduler's actual unsubscribe boundary.
      const originalUnsubscribe = this.scheduler.unsubscribe.bind(
        this.scheduler,
      );
      this.scheduler.unsubscribe = (action) => {
        cancelled++;
        originalUnsubscribe(action);
      };
      return home;
    };
    let processor: RuntimeProcessor | undefined;
    try {
      processor = await RuntimeProcessor.initialize({
        apiUrl: "https://worker.test/",
        identity: user.keyPair,
        spaceDid: otherUser.did(),
      });
      expect(selectedUser).toBe(user.did());
      const disposing = processor.dispose();
      expect(cancelled).toBeGreaterThan(0);
      release.resolve();
      await disposing;
    } finally {
      release.resolve();
      await processor?.dispose();
      Runtime.prototype.getHomeSpaceCell = originalGetHome;
      restore();
      await manager.close();
      if (originalPostMessage) {
        Object.defineProperty(globalThis, "postMessage", originalPostMessage);
      } else delete workerGlobal.postMessage;
    }
  });
});
