import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { type EventIntentOutcome, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeClients } from "@/backends/client-registry.ts";
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
  isEventIntentOutcomeNotification,
  isIPCRemoteNotification,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
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

describe("event intent outcome notification", () => {
  it("delivers refusals to accepted clients and stops delivering after departure", async () => {
    const identity = await Identity.fromPassphrase(
      "event outcome client",
    );
    const storage = StorageManager.emulate({ as: identity });
    let outcome: ((value: EventIntentOutcome) => void) | undefined;
    let cancelled = false;
    const subscribe = stub(
      Runtime.prototype,
      "subscribeEventIntentOutcomes",
      (observer) => {
        outcome = observer;
        return () => {
          cancelled = true;
        };
      },
    );
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
      messages.filter(isEventIntentOutcomeNotification);
    try {
      await deliver(ownerClient, {
        type: RequestType.Initialize,
        data: {
          identity: identity.keyPair,
          apiUrl: "http://localhost/",
          spaceDid: identity.did(),
        },
      });
      expect(outcome).toBeDefined();
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
      const notice = {
        type: NotificationType.EventIntentOutcome,
        space: identity.did(),
        eventId: "read-only-click",
        kind: "refused",
        reason: "admission-refused",
      };
      const refused = {
        space: identity.did(),
        eventId: "read-only-click",
        kind: "refused" as const,
        reason: "private diagnostic",
      };
      outcome!(refused);
      expect(notices(ownerMessages)).toEqual([notice]);
      expect(notices(first.messages)).toEqual([notice]);
      expect(notices(second.messages)).toEqual([notice]);
      expect(notices(pending.messages)).toEqual([]);
      await deliver(first.client, { type: RequestType.Dispose });
      outcome!(refused);
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

  it("validates and projects refusals without access-loss or generic-error routing", async () => {
    const identity = await Identity.fromPassphrase("event outcome projection");
    const transport = new TestTransport();
    const client = await RuntimeClient.initialize(transport, {
      identity,
      apiUrl: new URL("https://fabric.example"),
      spaceDid: identity.did(),
    });
    const observed: unknown[] = [];
    const errors: unknown[] = [];
    const losses: unknown[] = [];
    client.on("eventintentoutcome", (notice) => observed.push(notice));
    client.on("error", (notice) => errors.push(notice));
    client.on("spaceaccesslost", (notice) => losses.push(notice));
    const payload = {
      space: identity.did(),
      eventId: "read-click",
      kind: "refused",
      reason: "admission-refused",
    } as const;
    const notice = {
      type: NotificationType.EventIntentOutcome,
      ...payload,
    } as const;
    try {
      expect(isEventIntentOutcomeNotification(notice)).toBe(true);
      expect(isIPCRemoteNotification(notice)).toBe(true);
      for (
        const invalid of [
          null,
          [],
          {},
          { ...notice, space: "invalid" },
          { ...notice, eventId: "" },
          { ...notice, eventId: 1 },
          { ...notice, kind: "errored" },
          { ...notice, reason: "private diagnostic" },
        ]
      ) {
        expect(isEventIntentOutcomeNotification(invalid)).toBe(false);
      }
      const untrusted = {
        ...notice,
        payload: "private event payload",
        diagnostic: "private server diagnostic",
      };
      transport.emit("message", untrusted);
      expect(observed).toEqual([payload]);
      expect(errors).toEqual([]);
      expect(losses).toEqual([]);
    } finally {
      await client.dispose();
    }
  });
});
