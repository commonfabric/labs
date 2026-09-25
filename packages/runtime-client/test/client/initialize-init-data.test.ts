import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";

import { RuntimeClient, type RuntimeClientOptions } from "@/runtime-client.ts";
import { EventEmitter } from "@/client/emitter.ts";
import { NotificationType, RequestType } from "@/protocol/mod.ts";
import type {
  InitializationData,
  IPCClientMessage,
  IPCClientNotification,
  IPCRemoteMessage,
} from "@/protocol/mod.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";

/**
 * Guards the shell→worker `InitializationData` wiring: the fields carried by
 * `RuntimeClientOptions` must survive `RuntimeClient.initialize`'s hand-built
 * `InitializationData` literal.
 */
class CapturingTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly sent: Array<IPCClientMessage | IPCClientNotification> = [];
  send(original: IPCClientMessage | IPCClientNotification): void {
    // Encoded, cloned and decoded, as a real transport delivers it. The
    // encoding is what carries the `FabricKeyPair` this payload holds, where a
    // bare clone would strip it to `{}`; the clone is what makes the copy,
    // since an encode-decode pair alone returns the sender's own object where
    // nothing needed encoding, and deep-freezes it in place.
    const message = fabricFromRealmValue(
      structuredClone(realmFromFabricValue(original)),
    ) as IPCClientMessage | IPCClientNotification;
    this.sent.push(message);
    if (!("msgId" in message)) return;
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
  simulateMessage(message: IPCRemoteMessage): void {
    this.emit("message", message);
  }
}

describe("initialize-init-data", () => {
  describe("RuntimeClient.initialize InitializationData wiring", () => {
    it("reports the trust snapshot actor used by the worker", async () => {
      const identity = await Identity.fromPassphrase("init-acting-signer");
      const actor = await Identity.fromPassphrase("init-acting-actor");
      const client = await RuntimeClient.initialize(
        new CapturingTransport(),
        {
          apiUrl: new URL("http://toolshed.test"),
          identity,
          spaceDid: identity.did(),
          trustSnapshot: { id: "delegated", actingPrincipal: actor.did() },
        },
      );
      try {
        expect(client.actingPrincipalDid()).toBe(actor.did());
      } finally {
        await client.dispose();
      }
    });

    it("captures a copy, leaving the sender's own message untouched", () => {
      // The clone in the middle of the round trip is load-bearing and easy to
      // drop: an encode and a decode alone hand back the sender's own object
      // where nothing needed encoding, and deep-freeze it on the way. A double
      // that did that would freeze `RuntimeClient`'s message under it, which
      // no real transport does.
      const transport = new CapturingTransport();
      const original = {
        msgId: 1,
        data: { type: RequestType.Idle },
      } as unknown as IPCClientMessage;

      transport.send(original);

      expect(transport.sent[0]).not.toBe(original);
      expect(Object.isFrozen(original)).toBe(false);
    });

    it("carries every option through to the worker `InitializationData`", async () => {
      // The literal in `RuntimeClient.initialize` is held to naming every
      // `InitializationData` key by a `satisfies` clause, which a field
      // assigned `undefined` satisfies as readily as a forwarded one. This
      // case is what pins each key to the host's own value. `Required` holds
      // the fixture to setting every option, so a field added to the options
      // type lands in the test and in the literal together.

      const identity = await Identity.fromPassphrase("init-data forwarding");
      const spaceIdentity = await Identity.fromPassphrase(
        "init-data forwarding space",
      );
      const transport = new CapturingTransport();
      const options = {
        apiUrl: new URL("http://toolshed.test"),
        spaceHostMap: { "did:key:zSpace": "https://shard.test" },
        identity,
        spaceIdentity,
        spaceDid: identity.did(),
        spaceName: "forwarding-space",
        experimental: { modernCellRep: true, agentBuiltin: false },
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcReadMaxConfidentiality: ["did:key:zOwner"],
        cfcReadOnExceed: "skip",
        cfcTrustConfig: {
          delegations: [{
            delegator: "*",
            verifier: "did:web:forwarding.example",
            concepts: ["https://commonfabric.org/cfc/concepts/forwarding"],
          }],
        },
        renderDeclassificationPolicy: "deny",
        renderConfidentialityCeiling: { caveatKinds: ["forwarding"] },
        trustSnapshot: { id: "forwarding-snapshot" },
        forwardWorkerConsole: true,
        patternCoverage: true,
        concurrentWatchRefresh: true,
      } satisfies Required<RuntimeClientOptions>;

      await RuntimeClient.initialize(transport, options);

      const init = transport.sent.find(
        (m): m is IPCClientMessage =>
          "msgId" in m && m.data?.type === RequestType.Initialize,
      );
      expect(init).toBeDefined();
      const data = (init as { data: { data: InitializationData } }).data.data;
      // The three fields initialization transforms are compared against what
      // it makes of them; the rest against the option they came from.
      const { identity: sent, spaceIdentity: sentSpace, ...carried } = data;
      const {
        identity: _identity,
        spaceIdentity: _spaceIdentity,
        apiUrl: _apiUrl,
        ...expected
      } = options;
      expect(carried).toEqual({
        ...expected,
        apiUrl: options.apiUrl.toString(),
      });
      expect(sent).toEqual(identity.keyPair);
      expect(sentSpace).toEqual(spaceIdentity.keyPair);
    });
  });

  describe("RuntimeClient notification wiring", () => {
    it("re-emits PendingWritesChanged from the transport", async () => {
      const identity = await Identity.fromPassphrase(
        "pending writes notification test",
      );
      const transport = new CapturingTransport();
      const client = await RuntimeClient.initialize(transport, {
        apiUrl: new URL("http://toolshed.test"),
        identity,
        spaceDid: identity.did(),
        experimental: {},
      });
      let pending: boolean | undefined;
      client.on("pendingwriteschange", (event) => (pending = event.pending));

      try {
        transport.simulateMessage({
          type: NotificationType.PendingWritesChanged,
          pending: true,
        });
        expect(pending).toBe(true);
      } finally {
        await client.dispose();
      }
    });
  });
});
