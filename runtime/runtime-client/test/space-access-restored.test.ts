import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { type DID, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { ownerClient } from "@/backends/worker-client.ts";
import { EventEmitter } from "@/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import {
  type IPCClientMessage,
  type IPCClientNotification,
  type IPCRemotePost,
  isIPCRemoteNotification,
  isSpaceAccessRestoredNotification,
  NotificationType,
} from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

/** A transport that replies to every request with nothing, on the next turn. */
class TestTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  send(message: IPCClientMessage | IPCClientNotification): void {
    const owned = fabricFromRealmValue(
      structuredClone(realmFromFabricValue(message)),
    ) as IPCClientMessage | IPCClientNotification;
    if ("msgId" in owned) {
      queueMicrotask(() =>
        this.emit("message", { msgId: owned.msgId, data: undefined })
      );
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("space-access-restored", () => {
  it("is posted by the processor for a space whose access change lifted its refusal, and for no denial, until disposal", async () => {
    const identity = await Identity.fromPassphrase(
      "processor space access restored",
    );
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example"),
      storageManager: storage,
    });
    const refused = "did:key:z6Mk-access-restored-refused" as MemorySpace;
    const granted = "did:key:z6Mk-access-restored-granted" as MemorySpace;
    const observers = new Set<(space: MemorySpace) => void>();
    const read = stub(
      storage,
      "spaceAccessError",
      (space) => space === refused ? new Error("access denied") : undefined,
    );
    const subscribe = stub(
      storage,
      "subscribeSpaceAccessChange",
      (observer) => {
        observers.add(observer);
        return () => observers.delete(observer);
      },
    );
    const notices: IPCRemotePost[] = [];
    const post = stub(ownerClient, "post", (notice) => {
      notices.push(notice);
      return true;
    });
    const processor = buildProcessor({
      runtime,
      identity,
      space: identity.did(),
    });
    const change = (space: MemorySpace) => {
      for (const observer of [...observers]) observer(space);
    };
    try {
      change(refused);
      change(granted);

      expect(notices.filter(isSpaceAccessRestoredNotification)).toEqual([
        { type: NotificationType.SpaceAccessRestored, space: granted },
      ]);
      await processor.dispose();
      expect(observers.size).toBe(0);
    } finally {
      await processor.dispose();
      read.restore();
      subscribe.restore();
      post.restore();
      await storage.close();
    }
  });

  it("is not posted by the processor over a storage manager that cannot say whether a space is refused", async () => {
    const identity = await Identity.fromPassphrase(
      "processor space access restored without errors",
    );
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example"),
      storageManager: storage,
    });
    const observers = new Set<(space: MemorySpace) => void>();
    Object.defineProperty(storage, "spaceAccessError", {
      value: undefined,
      configurable: true,
    });
    const subscribe = stub(
      storage,
      "subscribeSpaceAccessChange",
      (observer) => {
        observers.add(observer);
        return () => observers.delete(observer);
      },
    );
    const notices: IPCRemotePost[] = [];
    const post = stub(ownerClient, "post", (notice) => {
      notices.push(notice);
      return true;
    });
    const processor = buildProcessor({
      runtime,
      identity,
      space: identity.did(),
    });
    try {
      // The change is a denial, which nothing here can tell from a recovery.
      for (const observer of [...observers]) {
        observer("did:key:z6Mk-access-restored-unknown" as MemorySpace);
      }

      expect(notices.filter(isSpaceAccessRestoredNotification)).toEqual([]);
    } finally {
      await processor.dispose();
      subscribe.restore();
      post.restore();
      Reflect.deleteProperty(storage, "spaceAccessError");
      await storage.close();
    }
  });

  it("reaches the client's `spaceaccessrestored` listeners with its space, and none of its `error` ones", async () => {
    const identity = await Identity.fromPassphrase(
      "space access restored client event",
    );
    const transport = new TestTransport();
    const client = await RuntimeClient.initialize(transport, {
      identity,
      apiUrl: new URL("https://fabric.example"),
      spaceDid: identity.did(),
    });
    const observed: { space: DID }[] = [];
    const errors: unknown[] = [];
    client.on("spaceaccessrestored", (notice) => observed.push(notice));
    client.on("error", (error) => errors.push(error));
    try {
      const notice = {
        type: NotificationType.SpaceAccessRestored,
        space: identity.did(),
      } as const;
      expect(isSpaceAccessRestoredNotification(notice)).toBe(true);
      expect(isIPCRemoteNotification(notice)).toBe(true);
      expect(
        isSpaceAccessRestoredNotification({ ...notice, space: "not-a-space" }),
      ).toBe(false);

      transport.emit("message", notice);

      expect(observed).toEqual([{ space: identity.did() }]);
      expect(errors).toEqual([]);
    } finally {
      await client.dispose();
    }
  });
});
