import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import type { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Runtime } from "@commonfabric/runner";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

/** What `buildProcessor()` runs the processor under, which the client asserts. */
const apiUrl = "http://localhost/";

/**
 * Returns a real `RuntimeClient` attached over a `MessageChannel` to a real
 * processor serving `runtime` as `signer`, with `space` as its home space, as
 * a page's client is attached to its worker.
 */
export async function attachedClient(
  runtime: Runtime,
  signer: Identity,
  space: MemorySpace,
): Promise<RuntimeClient> {
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity: signer,
          space,
        }) as unknown as RuntimeProcessor,
      ),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: { apiUrl, identity: { placeholder: true }, spaceDid: space },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  return await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
  );
}
