import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EventEmitter } from "@/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "@/client/transport.ts";
import type {
  IPCClientMessage,
  IPCClientNotification,
  IPCRemotePost,
} from "@/protocol/types.ts";

// Each test file has its own isolate. Load the runtime only after installing
// the build define so these tests exercise the bundled-code branches.
const localBuild = "a".repeat(40);
globalThis.$COMMIT_SHA = localBuild;
// deno-lint-ignore cf-imports/no-inline-module-import -- Capture the simulated bundle define before importing the runtime.
const { RuntimeConnection } = await import("@/client/connection.ts");
// deno-lint-ignore cf-imports/no-inline-module-import -- The worker must capture the same simulated bundle define.
const { RuntimeClients } = await import("@/backends/client-registry.ts");
// deno-lint-ignore cf-imports/no-inline-module-import -- Load runtime dependencies only after installing the build define.
const { RequestType } = await import("@/protocol/mod.ts");
// deno-lint-ignore cf-imports/no-inline-module-import -- Load runtime dependencies only after installing the build define.
const { realmFromFabricValue } = await import(
  "@commonfabric/data-model/codecs"
);
// deno-lint-ignore cf-imports/no-inline-module-import -- Load fixture primitives after the simulated bundle has captured its define.
const { FabricKeyPair } = await import(
  "@commonfabric/data-model/fabric-primitives"
);
delete globalThis.$COMMIT_SHA;

class PeerTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  sent: Array<IPCClientMessage | IPCClientNotification> = [];
  peerBuild: string | undefined = "b".repeat(40);

  send(message: IPCClientMessage | IPCClientNotification): void {
    this.sent.push(message);
    if (!("msgId" in message)) return;
    queueMicrotask(() =>
      this.emit("message", {
        msgId: message.msgId,
        ...(this.peerBuild ? { runtimeBuild: this.peerBuild } : {}),
      })
    );
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("bundled peer build markers", () => {
  it("does not use caller attribution as the initializing library's marker", async () => {
    const transport = new PeerTransport();
    const connection = new RuntimeConnection(transport);
    try {
      await connection.initialize({
        apiUrl: "https://example.test/",
        spaceDid: "did:key:z6Mk-peer-build",
        identity: new FabricKeyPair(
          "Ed25519",
          new Uint8Array(32),
          new Uint8Array(32),
        ),
        clientBuild: { application: "test", gitSha: "c".repeat(40) },
      });
      expect(transport.sent[0]).toMatchObject({ runtimeBuild: localBuild });
      expect(connection.buildDiagnostics.relation).toBe("different");
      await connection.request({ type: RequestType.Idle });
    } finally {
      await connection.dispose();
    }
  });

  it("stamps its loaded build, tolerates a different worker, and accepts a legacy acknowledgment", async () => {
    for (const peerBuild of ["b".repeat(40), undefined]) {
      const transport = new PeerTransport();
      transport.peerBuild = peerBuild;
      const connection = new RuntimeConnection(transport);
      try {
        await connection.attach({
          identity: "did:key:z6Mk-peer-build",
          apiUrl: "https://example.test/",
          spaceDid: "did:key:z6Mk-peer-build",
        });
        expect(transport.sent[0]).toMatchObject({ runtimeBuild: localBuild });
        expect(connection.buildDiagnostics).toEqual({
          local: localBuild,
          peer: peerBuild,
          relation: peerBuild ? "different" : "unknown",
        });
        await connection.request({ type: RequestType.Idle });
        expect(transport.sent[1]).not.toHaveProperty("runtimeBuild");
      } finally {
        await connection.dispose();
      }
    }
  });

  it("answers a refused handshake with its own build rather than echoing its peer", async () => {
    const posted: IPCRemotePost[] = [];
    const clients = new RuntimeClients({
      owner: {
        id: 0,
        post: (message) => {
          posted.push(message);
          return true;
        },
      },
      setConsoleBridge: () => {},
      initializeRuntime: () =>
        Promise.reject(new Error("fixture initialization refused")),
    });
    await clients.handleMessage(
      clients.owner,
      new MessageEvent("message", {
        data: realmFromFabricValue({
          msgId: 1,
          runtimeBuild: "b".repeat(40),
          data: {
            type: RequestType.Initialize,
            data: {
              apiUrl: "https://example.test/",
              identity: {},
              spaceDid: "did:key:z6Mk-peer-build",
              clientBuild: { application: "test", gitSha: "c".repeat(40) },
            },
          },
        }),
      }),
    );
    expect(posted).toEqual([{
      msgId: 1,
      error: "fixture initialization refused",
      runtimeBuild: localBuild,
    }]);
  });
});
