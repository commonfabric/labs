import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import type { DID } from "@commonfabric/identity";

import {
  ClientNotificationType,
  ClientTransportNotificationType,
  type InitializationData,
  NotificationType,
  RequestType,
  type RuntimeSecurityContext,
} from "@/protocol/mod.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";

type Posted = Record<string, unknown>;

const keyPair = new FabricKeyPair(
  "Ed25519",
  new Uint8Array(32),
  new Uint8Array(32),
);

const spaceDid = "did:key:z6Mk-runtime-clients-space" as DID;
const identityDid = "did:key:z6Mk-runtime-clients-identity" as DID;

const runningContext: RuntimeSecurityContext = {
  identity: identityDid,
  apiUrl: "http://runtime-clients.test/",
  spaceDid,
  cfcEnforcementMode: "enforce-strict",
};

const initializationData = {
  apiUrl: "http://runtime-clients.test/",
  identity: { placeholder: true },
  spaceDid,
  cfcEnforcementMode: "enforce-strict",
} as unknown as InitializationData;

/** A capturing client, standing in for one end of a duplex. */
function testClient(id: number) {
  const posted: Posted[] = [];
  const client: WorkerClient = {
    id,
    post: (message) => {
      posted.push(message as unknown as Posted);
      return true;
    },
  };
  return { client, posted };
}

/**
 * A processor that records what the message loop asked of it. Standing a real
 * one up wants identities and storage, and what these tests turn on is which
 * client each call carries and what a refusal says.
 */
function fakeProcessor() {
  const requests: Array<{ type: RequestType; clientId: number }> = [];
  const notifications: Array<{ type: string; clientId: number }> = [];
  const disposedClients: number[] = [];
  let runtimeDisposals = 0;
  let disposed = false;
  const processor = {
    isDisposed: () => disposed,
    assertAttachable: (asserted: RuntimeSecurityContext) => {
      if (asserted.identity === runningContext.identity) return;
      throw new Error(
        "Attach refused: the asserted security context differs from the " +
          "runtime's at `identity`.",
      );
    },
    handleRequest: (
      request: { type: RequestType },
      client: WorkerClient,
    ) => {
      requests.push({ type: request.type, clientId: client.id });
      return Promise.resolve(undefined);
    },
    handleNotification: (
      notification: { type: string },
      client: WorkerClient,
    ) => {
      notifications.push({ type: notification.type, clientId: client.id });
    },
    disposeClient: (client: WorkerClient) => {
      disposedClients.push(client.id);
    },
    dispose: () => {
      runtimeDisposals += 1;
      return Promise.resolve();
    },
  };
  return {
    processor: processor as unknown as RuntimeProcessor,
    requests,
    notifications,
    disposedClients,
    runtimeDisposals: () => runtimeDisposals,
    setDisposed: (value: boolean) => (disposed = value),
  };
}

function harness(
  options: { initializeSlowly?: boolean; failInitialization?: boolean } = {},
) {
  const fake = fakeProcessor();
  const owner = testClient(0);
  const consoleBridge: boolean[] = [];
  let release: (() => void) | undefined;
  let initializeCount = 0;
  const held = options.initializeSlowly
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();
  const clients = new RuntimeClients({
    owner: owner.client,
    setConsoleBridge: (forward) => consoleBridge.push(forward !== undefined),
    initializeRuntime: async () => {
      initializeCount += 1;
      await held;
      if (options.failInitialization) throw new Error("init exploded");
      return fake.processor;
    },
  });
  const deliver = (client: WorkerClient, message: unknown, ports?: unknown[]) =>
    clients.handleMessage(
      client,
      new MessageEvent("message", {
        // Encoded as a client's transport sends it: the loop decodes every
        // arriving envelope, so a raw object reads as damaged.
        data: realmFromFabricValue(message as never),
        ...(ports === undefined
          ? {}
          : { ports: ports as unknown as MessagePort[] }),
      }),
    );
  const initialize = (msgId: number) =>
    deliver(owner.client, {
      msgId,
      data: { type: RequestType.Initialize, data: initializationData },
    });
  return {
    ...fake,
    clients,
    owner,
    consoleBridge,
    deliver,
    initialize,
    releaseInitialization: () => release?.(),
    initializeCount: () => initializeCount,
  };
}

/**
 * Reads one client's end of a channel, recording every message and handing out
 * a promise for the next one. A reply is a real event, so a test waits on the
 * reply itself rather than on a delay chosen to outlast it.
 */
function portReader(port: MessagePort) {
  const received: Posted[] = [];
  let arrived: (() => void) | undefined;
  port.addEventListener("message", (event) => {
    received.push(fabricFromRealmValue(event.data as never) as Posted);
    arrived?.();
    arrived = undefined;
  });
  port.start();
  return {
    received,

    /** Settles on the next message to arrive. Called before what prompts it. */
    next: () => new Promise<void>((resolve) => (arrived = resolve)),
  };
}

/**
 * Registers a client over a duplex the test drives by hand, so that a message
 * reaches the loop when the test says rather than on the port's next task.
 */
function attachDirect(h: ReturnType<typeof harness>) {
  const posted: Posted[] = [];
  const client = h.clients.attach({
    postMessage: (message) => {
      posted.push(fabricFromRealmValue(message as never) as Posted);
    },
    addEventListener: () => {},
  });
  return { client, posted };
}

/** Hands the worker a port and returns this end of it. */
async function attachPort(h: ReturnType<typeof harness>) {
  const channel = new MessageChannel();
  const reader = portReader(channel.port1);
  await h.deliver(
    h.owner.client,
    { type: ClientTransportNotificationType.AttachPort },
    [channel.port2],
  );
  return { channel, ...reader };
}

/** Attaches a client over a real channel and returns its far end. */
async function attachedClient(
  h: ReturnType<typeof harness>,
  context: RuntimeSecurityContext = runningContext,
) {
  const port = await attachPort(h);
  const replied = port.next();
  port.channel.port1.postMessage(
    realmFromFabricValue(
      { msgId: 1, data: { type: RequestType.Attach, data: context } } as never,
    ),
  );
  await replied;
  return port;
}

describe("RuntimeClients", () => {
  describe("instance members", () => {
    describe("handleMessage()", () => {
      it("acks the owner's `Initialize` and stands the runtime up", async () => {
        const h = harness();
        await h.initialize(1);
        expect(h.owner.posted).toEqual([{ msgId: 1 }]);
      });

      it("refuses a second `Initialize`", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.initialize(2);
        expect(h.owner.posted).toEqual([{
          msgId: 2,
          error: "Initialization of WorkerRuntime already attempted.",
        }]);
      });

      it("refuses a request before the runtime is initialized", async () => {
        const h = harness();
        await h.deliver(h.owner.client, {
          msgId: 1,
          data: { type: RequestType.Idle },
        });
        expect(h.owner.posted).toEqual([{
          msgId: 1,
          error: "WorkerRuntime not initialized.",
        }]);
      });

      it("answers `SetForwardWorkerConsole` before any initialization", async () => {
        const h = harness();
        await h.deliver(h.owner.client, {
          msgId: 1,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
        });
        expect(h.owner.posted).toEqual([{ msgId: 1 }]);
        expect(h.consoleBridge).toEqual([true]);
      });

      it("carries the owner's client into every handled request", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Idle },
        });
        expect(h.requests).toEqual([{
          type: RequestType.Idle,
          clientId: 0,
        }]);
      });

      it("carries the owner's client into every notification", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          type: ClientNotificationType.VDomBatchApplied,
          mountId: 1,
          batchId: 2,
        });
        expect(h.notifications).toEqual([{
          type: ClientNotificationType.VDomBatchApplied,
          clientId: 0,
        }]);
      });

      it("tears the runtime down on the owner's `Dispose`", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Dispose },
        });
        expect(h.requests).toEqual([{
          type: RequestType.Dispose,
          clientId: 0,
        }]);
        expect(h.disposedClients).toEqual([]);
      });
    });

    describe("attach()", () => {
      it("acks an attach whose security context is the runtime's", async () => {
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h);
        channel.port1.close();
        expect(received).toEqual([{ msgId: 1 }]);
      });

      it("refuses an attach whose security context differs", async () => {
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h, {
          ...runningContext,
          identity: "did:key:z6Mk-someone-else" as DID,
        });
        channel.port1.close();
        expect(received).toHaveLength(1);
        expect(received[0].msgId).toBe(1);
        expect(received[0].error).toContain("Attach refused");
        expect(received[0].error).toContain("`identity`");
      });

      it("refuses an attach before the runtime is initialized", async () => {
        const h = harness();
        const { received, channel } = await attachedClient(h);
        channel.port1.close();
        expect(received).toEqual([{
          msgId: 1,
          error: "WorkerRuntime not initialized.",
        }]);
      });

      it("refuses an `Attach` from the client that owns the worker", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Attach, data: runningContext },
        });
        expect(h.owner.posted).toHaveLength(1);
        expect(h.owner.posted[0].error).toContain(
          "initializes its runtime rather than attaching",
        );
      });

      it("refuses an attach carrying key material, naming where it sits", async () => {
        // The invariant `findKeyMaterial` states: an attaching client supplies
        // no signer, so a key in the frame is a frame built wrong. Refused
        // here rather than left to the platform, whose answer in a WKWebView
        // is a bare `DataCloneError`.
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h, {
          ...runningContext,
          trustSnapshot: {
            id: "principal",
            signer: keyPair,
          } as unknown as RuntimeSecurityContext["trustSnapshot"],
        });
        channel.port1.close();
        expect(received).toHaveLength(1);
        expect(received[0].error).toContain("no key material");
        expect(received[0].error).toContain("`trustSnapshot.signer`");
      });

      it("refuses an attach whose acting principal is not a DID", async () => {
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h, {
          ...runningContext,
          identity: { publicKey: "raw" } as unknown as DID,
        });
        channel.port1.close();
        expect(received).toHaveLength(1);
        expect(received[0].error).toContain("acting principal");
      });

      it("refuses an `Initialize` from a client that does not own the worker", async () => {
        // An attached document asking to stand the runtime up would be
        // re-deciding the identity and posture every other client is already
        // running under.
        const h = harness();
        await h.initialize(1);
        const joiner = attachDirect(h);
        await h.deliver(joiner.client, {
          msgId: 1,
          data: { type: RequestType.Attach, data: runningContext },
        });
        joiner.posted.length = 0;

        await h.deliver(joiner.client, {
          msgId: 2,
          data: {
            type: RequestType.Initialize,
            data: initializationData,
          },
        });

        expect(joiner.posted).toHaveLength(1);
        expect(joiner.posted[0].error).toContain(
          "Only the client that owns the worker may initialize",
        );
        // And the runtime it was already serving is the one still serving.
        expect(h.initializeCount()).toBe(1);
      });

      it("refuses console forwarding from a client that does not own the worker", async () => {
        // What the bridge forwards goes to the worker's own global, which is
        // the owner's end of the IPC, so an attached client turning it on
        // would be redirecting the owner's console.
        const h = harness();
        await h.initialize(1);
        const joiner = attachDirect(h);
        await h.deliver(joiner.client, {
          msgId: 1,
          data: { type: RequestType.Attach, data: runningContext },
        });
        h.consoleBridge.length = 0;
        joiner.posted.length = 0;

        await h.deliver(joiner.client, {
          msgId: 2,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
        });

        expect(joiner.posted).toHaveLength(1);
        expect(joiner.posted[0].error).toContain(
          "Only the client that owns the worker may forward its console",
        );
        // The refusal is the whole of it: the bridge was never toggled.
        expect(h.consoleBridge).toEqual([]);
      });

      it("refuses a second attach on a channel whose first was already refused", async () => {
        // A client may have two attaches in flight. The first refusal lets go
        // of the client, and the second has to find it already gone without
        // failing over it.
        const h = harness();
        await h.initialize(1);
        const joiner = attachDirect(h);
        const wrong = {
          ...runningContext,
          identity: "did:key:z6Mk-someone-else" as DID,
        };

        await h.deliver(joiner.client, {
          msgId: 1,
          data: { type: RequestType.Attach, data: wrong },
        });
        await h.deliver(joiner.client, {
          msgId: 2,
          data: { type: RequestType.Attach, data: wrong },
        });

        // Both are refused by name. Letting go of a client does not turn a
        // later attach on that channel into silence: an attach is answered on
        // its merits whether or not the worker still holds a registration,
        // and the second `#drop` finds nothing to drop without failing.
        expect(joiner.posted).toHaveLength(2);
        expect(joiner.posted[0].error).toContain("Attach refused");
        expect(joiner.posted[1].error).toContain("Attach refused");
        expect(h.clients.attachedClientCount).toBe(0);
      });

      it("refuses an attach to a runtime that has been disposed", async () => {
        // The worst failure this could have: a client joining a
        // runtime-shaped void and finding out only when nothing answers.
        const h = harness();
        await h.initialize(1);
        h.setDisposed(true);
        const { received, channel } = await attachedClient(h);
        channel.port1.close();
        expect(received).toHaveLength(1);
        expect(received[0].error).toContain("disposed");
      });

      it("waits for an initialization already under way", async () => {
        // Pipelining: the owner's page transfers a port and the joining
        // document attaches before the runtime has finished standing up.
        // Attaching waits for that rather than reading the absent runtime
        // and refusing. Delivered by hand so the attach is provably in
        // flight while the initialization is -- through a port it would
        // arrive on a later task, by which time there is nothing to race.
        const h = harness({ initializeSlowly: true });
        const initialized = h.initialize(1);
        const joiner = attachDirect(h);
        const attaching = h.deliver(joiner.client, {
          msgId: 1,
          data: { type: RequestType.Attach, data: runningContext },
        });
        h.releaseInitialization();
        await initialized;
        await attaching;
        expect(joiner.posted).toEqual([{ msgId: 1 }]);
      });

      it("refuses an attach when the initialization it waited for failed", async () => {
        const h = harness({ initializeSlowly: true, failInitialization: true });
        const initialized = h.initialize(1);
        const joiner = attachDirect(h);
        const attaching = h.deliver(joiner.client, {
          msgId: 1,
          data: { type: RequestType.Attach, data: runningContext },
        });
        h.releaseInitialization();
        await initialized;
        await attaching;
        expect(joiner.posted).toHaveLength(1);
        expect(joiner.posted[0].error).toBe("WorkerRuntime not initialized.");
      });

      it("drops a refused client's registration, so a retry loop cannot grow the worker", async () => {
        const h = harness();
        await h.initialize(1);
        const before = h.clients.attachedClientCount;
        for (let attempt = 0; attempt < 3; attempt++) {
          const { channel } = await attachedClient(h, {
            ...runningContext,
            identity: "did:key:z6Mk-someone-else" as DID,
          });
          channel.port1.close();
        }
        expect(h.clients.attachedClientCount).toBe(before);
      });

      it("acks rather than refuses traffic from a client that has departed", async () => {
        // The owner's stragglers are silently acked after disposal; an
        // attached client's teardown traffic reads the same way.
        const h = harness();
        await h.initialize(1);
        const port = await attachedClient(h);
        try {
          const departed = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 2, data: { type: RequestType.Dispose } } as never,
            ),
          );
          await departed;
          expect(h.clients.attachedClientCount).toBe(0);

          // Delivered by hand: the registry drops its side of a departed
          // client's channel, so nothing could arrive over the port itself.
          const straggler = testClient(1);
          await h.deliver(straggler.client, {
            msgId: 3,
            data: { type: RequestType.Idle },
          });
          expect(straggler.posted).toEqual([{ msgId: 3 }]);
          expect(h.requests).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("refuses a request from a client that has not attached", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachPort(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 5, data: { type: RequestType.Idle } } as never,
            ),
          );
          await replied;
          expect(port.received).toEqual([{
            msgId: 5,
            error: "Client is not attached to the WorkerRuntime.",
          }]);
          expect(h.requests).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("carries the attached client into its own requests", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachedClient(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 2, data: { type: RequestType.Idle } } as never,
            ),
          );
          await replied;
          expect(h.requests).toEqual([{ type: RequestType.Idle, clientId: 1 }]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("tears down only the departing client on an attached `Dispose`", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachedClient(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 2, data: { type: RequestType.Dispose } } as never,
            ),
          );
          await replied;
          expect(h.disposedClients).toEqual([1]);
          expect(h.runtimeDisposals()).toBe(0);
          expect(h.requests).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("refuses a port transferred by a client that is not the owner", async () => {
        const h = harness();
        await h.initialize(1);
        const attached = await attachedClient(h);
        attached.received.length = 0;
        const second = new MessageChannel();
        try {
          const reported = attached.next();
          attached.channel.port1.postMessage(
            realmFromFabricValue(
              { type: ClientTransportNotificationType.AttachPort } as never,
            ),
            [second.port2],
          );
          await reported;
          expect(attached.received).toHaveLength(1);
          expect(attached.received[0].type).toBe(NotificationType.ErrorReport);
          expect(attached.received[0].message).toContain(
            "Only the client that owns the worker",
          );
        } finally {
          attached.channel.port1.close();
          second.port1.close();
        }
      });

      it("drops a notification from a client that has not attached", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachPort(h);
        try {
          port.channel.port1.postMessage(
            realmFromFabricValue(
              {
                type: ClientNotificationType.VDomBatchApplied,
                mountId: 1,
                batchId: 2,
              } as never,
            ),
          );
          // A notification is answered by nothing, so there is no reply to
          // wait on. Round-tripping a request that IS answered puts this one
          // behind a settled point: the loop is ordered, so a notification
          // that reached the runtime would have done so by now.
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 6, data: { type: RequestType.Idle } } as never,
            ),
          );
          await replied;
          expect(h.notifications).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("reports an attach-port message that carries no port", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.deliver(h.owner.client, {
          type: ClientTransportNotificationType.AttachPort,
        });
        expect(h.owner.posted).toHaveLength(1);
        expect(h.owner.posted[0].type).toBe(NotificationType.ErrorReport);
        expect(h.owner.posted[0].message).toContain("no port");
      });
    });
  });
});
