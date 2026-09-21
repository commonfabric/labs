import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { assertType, type IsExact } from "@std/testing/types";

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { type DID, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeClients } from "@/backends/client-registry.ts";
import { renderSpaceAccessProviderFor } from "@/backends/runtime-processor.ts";
import { ownerClient, type WorkerClient } from "@/backends/worker-client.ts";
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
  isSpaceAccessLostNotification,
  NotificationType,
  RequestType,
  type SpaceAccessLostNotification,
} from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";
import { stubWorkerBoot } from "./backends/stub-worker-boot.ts";

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
  it("declares the same space type that the protocol guard accepts", () => {
    assertType<IsExact<SpaceAccessLostNotification["space"], DID>>(true);
  });
  it("relays scoped access changes and recovery to render boundaries", async () => {
    const identity = await Identity.fromPassphrase("renderer access changes");
    const storage = StorageManager.emulate({ as: identity });
    let current: Error | undefined = new Error("access denied");
    let changed: ((space: MemorySpace) => void) | undefined;
    let cancelled = false;
    const read = stub(storage, "spaceAccessError", () => current);
    const changes = stub(storage, "subscribeSpaceAccessChange", (observer) => {
      changed = observer;
      return () => {
        cancelled = true;
      };
    });
    const losses = stub(storage, "subscribeSpaceAccessLoss", () => () => {});
    try {
      const provider = renderSpaceAccessProviderFor({
        storageManager: storage,
      });
      const observed: (Error | undefined)[] = [];
      const cancel = provider.subscribe(identity.did(), () => {
        observed.push(provider.error(identity.did()));
      });
      expect(changes.calls).toHaveLength(1);
      expect(losses.calls).toHaveLength(0);
      changed!("did:key:z6Mk-unrelated");
      expect(observed).toEqual([]);
      changed!(identity.did());
      expect(observed).toEqual([current]);
      current = undefined;
      changed!(identity.did());
      expect(observed).toHaveLength(2);
      expect(observed[1]).toBeUndefined();
      cancel();
      expect(cancelled).toBe(true);
    } finally {
      read.restore();
      changes.restore();
      losses.restore();
      await storage.close();
    }
  });

  it("supports render providers with only loss notifications or no lifecycle hooks", async () => {
    const identity = await Identity.fromPassphrase(
      "legacy render access provider",
    );
    const storage = StorageManager.emulate({ as: identity });
    Object.defineProperty(storage, "subscribeSpaceAccessChange", {
      value: undefined,
      configurable: true,
    });
    let lost: ((space: MemorySpace, error: Error) => void) | undefined;
    let cancelled = false;
    const losses = stub(storage, "subscribeSpaceAccessLoss", (observer) => {
      lost = observer;
      return () => {
        cancelled = true;
      };
    });
    try {
      const provider = renderSpaceAccessProviderFor({
        storageManager: storage,
      });
      let changes = 0;
      const cancel = provider.subscribe(identity.did(), () => changes++);
      lost!("did:key:z6Mk-unrelated", new Error("unrelated"));
      expect(changes).toBe(0);
      lost!(identity.did(), new Error("access denied"));
      expect(changes).toBe(1);
      cancel();
      expect(cancelled).toBe(true);
      losses.restore();
      Object.defineProperty(storage, "subscribeSpaceAccessLoss", {
        value: undefined,
        configurable: true,
      });
      expect(() => provider.subscribe(identity.did(), () => changes++)()).not
        .toThrow();
      expect(changes).toBe(1);
    } finally {
      if (!losses.restored) losses.restore();
      Reflect.deleteProperty(storage, "subscribeSpaceAccessChange");
      Reflect.deleteProperty(storage, "subscribeSpaceAccessLoss");
      await storage.close();
    }
  });

  it("notifies the default owner from the processor factory and cancels on disposal", async () => {
    const identity = await Identity.fromPassphrase(
      "processor owner access loss",
    );
    const storage = StorageManager.emulate({ as: identity });
    const runtime = new Runtime({
      apiUrl: new URL("https://fabric.example"),
      storageManager: storage,
    });
    let loss: ((space: MemorySpace, error: Error) => void) | undefined;
    let cancelled = false;
    const subscribe = stub(storage, "subscribeSpaceAccessLoss", (observer) => {
      loss = observer;
      return () => {
        cancelled = true;
      };
    });
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
      expect(loss).toBeDefined();
      loss!(identity.did(), new Error("private diagnostic"));
      expect(notices).toEqual([{
        type: NotificationType.SpaceAccessLost,
        space: identity.did(),
      }]);
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

  it("notifies attached clients without mounts and stops delivering after departure", async () => {
    const identity = await Identity.fromPassphrase(
      "unmounted access-loss client",
    );
    const storage = StorageManager.emulate({ as: identity });
    let loss: ((space: MemorySpace, error: Error) => void) | undefined;
    let cancelled = false;
    const subscribe = stub(storage, "subscribeSpaceAccessLoss", (observer) => {
      loss = observer;
      return () => {
        cancelled = true;
      };
    });
    const restoreBoot = stubWorkerBoot(() => storage);
    const ownerMessages: IPCRemotePost[] = [];
    const post = stub(ownerClient, "post", (message) => {
      ownerMessages.push(message);
      return true;
    });
    const clients = new RuntimeClients({ setConsoleBridge: () => {} });
    let msgId = 0;
    const deliver = (client: WorkerClient, data: IPCClientMessage["data"]) =>
      clients.handleMessage(
        client,
        new MessageEvent("message", {
          data: structuredClone(realmFromFabricValue({ msgId: ++msgId, data })),
        }),
      );
    const attach = () => {
      const messages: IPCRemotePost[] = [];
      const client = clients.attach({
        postMessage: (message) =>
          messages.push(
            fabricFromRealmValue(message as never) as IPCRemotePost,
          ),
        addEventListener: () => {},
        removeEventListener: () => {},
        close: () => {},
      });
      return { client, messages };
    };
    const notices = (messages: IPCRemotePost[]) =>
      messages.filter(isSpaceAccessLostNotification);
    try {
      await deliver(ownerClient, {
        type: RequestType.Initialize,
        data: {
          identity: identity.keyPair,
          apiUrl: "http://localhost/",
          spaceDid: identity.did(),
        },
      });
      expect(loss).toBeDefined();
      const pending = attach();
      const first = attach();
      const second = attach();
      for (const attached of [first, second]) {
        await deliver(attached.client, {
          type: RequestType.Attach,
          data: {
            identity: identity.did(),
            apiUrl: "http://localhost/",
            spaceDid: identity.did(),
          },
        });
        expect(attached.messages).toEqual([{ msgId }]);
      }
      const error = Object.assign(new Error("revoked"), {
        name: "AuthorizationError",
      });
      const notice = {
        type: NotificationType.SpaceAccessLost,
        space: identity.did(),
      };
      loss!(identity.did(), error);
      expect(notices(ownerMessages)).toEqual([notice]);
      expect(notices(first.messages)).toEqual([notice]);
      expect(notices(second.messages)).toEqual([notice]);
      expect(notices(pending.messages)).toEqual([]);
      await deliver(first.client, { type: RequestType.Dispose });
      loss!(identity.did(), error);
      expect(notices(first.messages)).toEqual([notice]);
      expect(notices(second.messages)).toEqual([notice, notice]);
      expect(notices(pending.messages)).toEqual([]);
    } finally {
      await deliver(ownerClient, { type: RequestType.Dispose });
      expect(cancelled).toBe(true);
      restoreBoot();
      subscribe.restore();
      post.restore();
      await storage.close();
    }
  });

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
