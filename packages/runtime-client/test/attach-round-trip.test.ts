import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import {
  type ErrorNotification,
  NotificationType,
  RequestType,
  type RuntimeSecurityContext,
} from "@/protocol/mod.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import type { MessagePortLike } from "@/shared/message-port-like.ts";
import { type RuntimeAttachOptions, RuntimeClient } from "@/runtime-client.ts";

// The two halves of an attachment, joined over a real channel: a worker's
// client registry at one end and the `RuntimeClient` a joining document holds
// at the other. Each half is pinned on its own elsewhere; what is only true of
// the pair is that they speak the same protocol -- that what one encodes the
// other reads, and that a refusal reaches the caller as a rejection rather
// than as a promise nobody settles.

const identity = await Identity.fromPassphrase("attach-round-trip", {
  implementation: "noble",
});
const otherIdentity = await Identity.fromPassphrase("someone-else", {
  implementation: "noble",
});

const spaceDid = identity.did();

const keyPair = new FabricKeyPair(
  "Ed25519",
  new Uint8Array(32),
  new Uint8Array(32),
);

function clientOptions(as: Identity): RuntimeAttachOptions {
  return {
    apiUrl: new URL("http://attach-round-trip.test/"),
    identity: as.did(),
    spaceDid,
    cfcEnforcementMode: "enforce-strict",
  };
}

/**
 * A worker-side registry serving a runtime whose security context is the one
 * `clientOptions` asserts. The processor records which client each request
 * carried, and hands back the client so a test can post to it.
 */
function workerSide() {
  const requests: Array<{ type: RequestType; client: WorkerClient }> = [];
  const running: RuntimeSecurityContext = {
    identity: identity.did(),
    apiUrl: "http://attach-round-trip.test/",
    spaceDid,
    cfcEnforcementMode: "enforce-strict",
  };
  const processor = {
    isDisposed: () => false,
    assertAttachable: (asserted: RuntimeSecurityContext) => {
      if (asserted.identity === running.identity) return;
      throw new Error(
        "Attach refused: the asserted security context differs from the " +
          "runtime's at `identity`.",
      );
    },
    handleRequest: (request: { type: RequestType }, client: WorkerClient) => {
      requests.push({ type: request.type, client });
      return Promise.resolve(undefined);
    },
    handleNotification: () => {},
    disposeClient: () => {},
    dispose: () => Promise.resolve(),
  };
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(processor as unknown as RuntimeProcessor),
  });
  return { clients, requests };
}

/** A registry with its runtime already standing. */
async function runningWorker() {
  const worker = workerSide();
  await worker.clients.handleMessage(
    worker.clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: {
            apiUrl: "http://attach-round-trip.test/",
            identity: { placeholder: true },
            spaceDid,
          },
        },
      } as never),
    }),
  );
  return worker;
}

/** Joins `clients` from the far end of a fresh channel. */
function joiningSide(clients: RuntimeClients) {
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  return new MessagePortRuntimeTransport({ port: channel.port1 });
}

describe("attach-round-trip", () => {
  it("reports the trust snapshot actor on an attached client", async () => {
    const worker = await runningWorker();
    const client = await RuntimeClient.attach(
      joiningSide(worker.clients),
      {
        ...clientOptions(identity),
        trustSnapshot: {
          id: "delegated",
          actingPrincipal: otherIdentity.did(),
        },
      },
    );
    try {
      expect(client.actingPrincipalDid()).toBe(otherIdentity.did());
    } finally {
      await client.dispose();
    }
  });

  it("joins a running runtime over a port and carries the joining client", async () => {
    const worker = await runningWorker();
    const client = await RuntimeClient.attach(
      joiningSide(worker.clients),
      clientOptions(identity),
    );
    try {
      await client.idle();
      expect(worker.requests.map(({ type }) => type)).toEqual([
        RequestType.Idle,
      ]);
      // Every request from this document is filed under the client its port
      // became, not under the one that stood the runtime up.
      expect(worker.requests[0].client.id).toBe(1);
    } finally {
      await client.dispose();
    }
  });

  it("rejects an attach asserting an identity the runtime does not act as", async () => {
    const worker = await runningWorker();
    await expect(
      RuntimeClient.attach(
        joiningSide(worker.clients),
        clientOptions(otherIdentity),
      ),
    ).rejects.toThrow("Attach refused");
    expect(worker.requests).toEqual([]);
  });

  it("refuses to send an attach holding key material, before it reaches a port", async () => {
    // The far side refuses one too, and this is the one that matters for a
    // shell: a `MessagePort` between two WKWebViews throws `DataCloneError`
    // on a non-extractable `CryptoKey`, so a frame carrying one would fail as
    // a transport error saying nothing about why. Refused here by name, and
    // never posted.
    const worker = await runningWorker();
    const channel = new MessageChannel();
    worker.clients.attach(channel.port2);
    const posted: unknown[] = [];
    const watchedPort: MessagePortLike = {
      postMessage: (message) => {
        posted.push(message);
        channel.port1.postMessage(message);
      },
      addEventListener: (type, listener) =>
        channel.port1.addEventListener(type, listener),
      start: () => channel.port1.start(),
      close: () => channel.port1.close(),
    };
    try {
      await expect(
        RuntimeClient.attach(
          new MessagePortRuntimeTransport({ port: watchedPort }),
          {
            ...clientOptions(identity),
            trustSnapshot: {
              id: "principal",
              signer: keyPair,
            } as unknown as RuntimeAttachOptions["trustSnapshot"],
          },
        ),
      ).rejects.toThrow("no key material");
      expect(posted).toEqual([]);
      expect(worker.requests).toEqual([]);
    } finally {
      channel.port1.close();
    }
  });

  it("delivers a notification addressed to one client to that client alone", async () => {
    const worker = await runningWorker();
    const first = await RuntimeClient.attach(
      joiningSide(worker.clients),
      clientOptions(identity),
    );
    const second = await RuntimeClient.attach(
      joiningSide(worker.clients),
      clientOptions(identity),
    );
    try {
      const firstErrors: ErrorNotification[] = [];
      const secondErrors: ErrorNotification[] = [];
      first.on("error", (error) => firstErrors.push(error));
      let arrived: (() => void) | undefined;
      second.on("error", (error) => {
        secondErrors.push(error);
        arrived?.();
      });

      await first.idle();
      await second.idle();
      const secondClient = worker.requests[1].client;
      expect(secondClient.id).toBe(2);

      const reported = new Promise<void>((resolve) => (arrived = resolve));
      secondClient.post({
        type: NotificationType.ErrorReport,
        message: "for the second document only",
      });
      await reported;

      expect(secondErrors.map(({ message }) => message)).toEqual([
        "for the second document only",
      ]);
      expect(firstErrors).toEqual([]);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});
