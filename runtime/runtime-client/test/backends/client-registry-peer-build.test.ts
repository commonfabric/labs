import { expect } from "@std/expect";
import { captureLogsForTestingOnly } from "@commonfabric/logger/for-testing-only";
import { describe, it } from "@commonfabric/test-support/test";
import type { FabricValue } from "@commonfabric/data-model";
import type { IPCRemotePost } from "@/protocol/types.ts";

// Each test file has its own isolate. Load the worker side only after
// installing the build define, so these tests run it as a bundle does, with a
// build of its own to state.
const localBuild = "a".repeat(40);
globalThis.$COMMIT_SHA = localBuild;
// deno-lint-ignore cf-imports/no-inline-module-import -- Capture the simulated bundle define before importing the worker side.
const { RuntimeClients } = await import("@/backends/client-registry.ts");
// deno-lint-ignore cf-imports/no-inline-module-import -- Load runtime dependencies only after installing the build define.
const { RequestType } = await import("@/protocol/mod.ts");
// deno-lint-ignore cf-imports/no-inline-module-import -- Load runtime dependencies only after installing the build define.
const { fabricFromRealmValue, realmFromFabricValue } = await import(
  "@commonfabric/data-model/codecs"
);
// deno-lint-ignore cf-imports/no-inline-module-import -- Load runtime dependencies only after installing the build define.
const { Identity } = await import("@commonfabric/identity");
// deno-lint-ignore cf-imports/no-inline-module-import -- The processor's dependencies must capture the same simulated bundle define.
const { buildProcessor } = await import("./build-processor.ts");
delete globalThis.$COMMIT_SHA;

const signer = await Identity.fromPassphrase("client-registry-peer-build");
const space = signer.did();
const apiUrl = "http://localhost/";

/**
 * A worker whose runtime stands up, with what it posts to its owner and the
 * far end of a channel serving one further client.
 */
function worker() {
  const ownerPosted: IPCRemotePost[] = [];
  const clients = new RuntimeClients({
    owner: {
      id: 0,
      post: (message) => {
        ownerPosted.push(message);
        return true;
      },
    },
    setConsoleBridge: () => {},
    initializeRuntime: () =>
      Promise.resolve(buildProcessor({ identity: signer, space })),
  });
  const channel = new MessageChannel();
  const attached = clients.attach(channel.port2);
  const deliver = (client: typeof attached, message: FabricValue) =>
    clients.handleMessage(
      client,
      new MessageEvent("message", { data: realmFromFabricValue(message) }),
    );

  /** Settles on the next reply the further client receives. */
  const attachedReply = () =>
    new Promise<FabricValue>((resolve) => {
      channel.port1.onmessage = (event) =>
        resolve(fabricFromRealmValue(event.data));
    });
  return { clients, ownerPosted, attached, deliver, attachedReply, channel };
}

const initialize = (runtimeBuild?: string) => ({
  msgId: 1,
  ...(runtimeBuild ? { runtimeBuild } : {}),
  data: {
    type: RequestType.Initialize,
    data: { apiUrl, identity: { placeholder: true }, spaceDid: space },
  },
});

const attach = (runtimeBuild?: string) => ({
  msgId: 1,
  ...(runtimeBuild ? { runtimeBuild } : {}),
  data: {
    type: RequestType.Attach,
    data: { apiUrl, identity: space, spaceDid: space },
  },
});

describe("client-registry-peer-build", () => {
  it("posts its own build in the reply to an accepted handshake, and in no other reply", async () => {
    const w = worker();
    await w.deliver(w.clients.owner, initialize("b".repeat(40)));
    await w.deliver(w.clients.owner, {
      msgId: 2,
      data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
    });
    const reply = w.attachedReply();
    await w.deliver(w.attached, attach());

    expect(w.ownerPosted).toEqual([
      { msgId: 1, runtimeBuild: localBuild },
      { msgId: 2 },
    ]);
    expect(await reply).toEqual({ msgId: 1, runtimeBuild: localBuild });
    w.channel.port1.close();
  });

  it("logs how each handshaking peer's build relates to its own", async () => {
    const w = worker();
    using captured = captureLogsForTestingOnly("runtime-worker.ipc");
    await w.deliver(w.clients.owner, initialize(localBuild));
    await w.deliver(w.attached, attach("b".repeat(40)));
    await w.deliver(w.clients.owner, {
      msgId: 2,
      data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
    });
    const late = w.clients.attach({
      postMessage: () => {},
      addEventListener: () => {},
    });
    await w.deliver(late, attach("not a build"));

    w.channel.port1.close();
    expect(captured.messagesOf("peer-build")).toEqual([
      [w.clients.owner.id, {
        local: localBuild,
        peer: localBuild,
        relation: "same",
      }],
      [w.attached.id, {
        local: localBuild,
        peer: "b".repeat(40),
        relation: "different",
      }],
      [late.id, { local: localBuild, peer: undefined, relation: "unknown" }],
    ]);
  });
});
