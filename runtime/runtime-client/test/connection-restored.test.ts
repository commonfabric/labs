import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
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
  isConnectionRestoredNotification,
  isIPCRemoteNotification,
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

describe("connection-restored", () => {
  it("is posted by the processor for each connection its storage reports restored, until disposal", async () => {
    const identity = await Identity.fromPassphrase(
      "processor connection restored",
    );
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example"),
      storageManager: storage,
    });
    let restored: (() => void) | undefined;
    let cancelled = false;
    const subscribe = stub(
      storage,
      "subscribeConnectionRestored",
      (observer) => {
        restored = observer;
        return () => {
          cancelled = true;
        };
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
      expect(restored).toBeDefined();
      restored!();
      restored!();
      expect(notices.filter(isConnectionRestoredNotification)).toEqual([
        { type: NotificationType.ConnectionRestored },
        { type: NotificationType.ConnectionRestored },
      ]);
      expect(cancelled).toBe(false);
      await processor.dispose();
      expect(cancelled).toBe(true);
    } finally {
      await processor.dispose();
      subscribe.restore();
      post.restore();
      await storage.close();
    }
  });

  it("reaches the client's `connectionrestored` listeners and none of its `error` ones", async () => {
    const identity = await Identity.fromPassphrase(
      "connection restored client event",
    );
    const transport = new TestTransport();
    const client = await RuntimeClient.initialize(transport, {
      identity,
      apiUrl: new URL("https://fabric.example"),
      spaceDid: identity.did(),
    });
    let restored = 0;
    const errors: unknown[] = [];
    client.on("connectionrestored", () => restored++);
    client.on("error", (error) => errors.push(error));
    try {
      const notice = { type: NotificationType.ConnectionRestored } as const;
      expect(isConnectionRestoredNotification(notice)).toBe(true);
      expect(isIPCRemoteNotification(notice)).toBe(true);
      expect(
        isConnectionRestoredNotification({
          type: NotificationType.SpaceAccessLost,
        }),
      ).toBe(false);

      transport.emit("message", notice);

      expect(restored).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await client.dispose();
    }
  });
});
