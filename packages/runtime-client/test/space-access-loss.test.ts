import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import { EventEmitter } from "@/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import {
  type IPCClientMessage,
  type IPCClientNotification,
  isIPCRemoteNotification,
  isSpaceAccessLostNotification,
  NotificationType,
} from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";

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

describe("space access loss notification", () => {
  it("passes a valid space through the connection and client without generic error routing", async () => {
    const identity = await Identity.fromPassphrase("access-loss client event");
    const transport = new TestTransport();
    const client = await RuntimeClient.initialize(transport, {
      identity,
      apiUrl: new URL("https://fabric.example"),
      spaceDid: identity.did(),
    });
    const observed: unknown[] = [];
    const errors: unknown[] = [];
    client.on("spaceaccesslost", (notice) => observed.push(notice));
    client.on("error", (error) => errors.push(error));
    try {
      const notice = {
        type: NotificationType.SpaceAccessLost,
        space: identity.did(),
      } as const;
      expect(isSpaceAccessLostNotification(notice)).toBe(true);
      expect(isIPCRemoteNotification(notice)).toBe(true);
      transport.emit("message", notice);
      expect(observed).toEqual([{ space: identity.did() }]);
      expect(errors).toEqual([]);
      expect(isSpaceAccessLostNotification({ ...notice, space: 1 })).toBe(
        false,
      );
      expect(isSpaceAccessLostNotification({ type: notice.type })).toBe(false);
      expect(isSpaceAccessLostNotification({ ...notice, space: "not-a-space" }))
        .toBe(false);
    } finally {
      await client.dispose();
    }
  });
});
