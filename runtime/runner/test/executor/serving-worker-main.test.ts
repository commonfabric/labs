/**
 * Drives `serveFromPort()` in this realm, over a `MessageChannel` whose other
 * end a `ServingPortBridge` holds, as a serving worker's entry module runs
 * it over the worker's own port.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { processInstanceId } from "@commonfabric/memory/v2/execution-lease";
import type { Server } from "@commonfabric/memory/v2/server";
import { ServingPortBridge } from "../../src/executor/serving-port-bridge.ts";
import type { ServingWorkerInit } from "../../src/executor/serving-port-protocol.ts";
import {
  serveFromPort,
  type ServingWorkerMainOptions,
} from "../../src/executor/serving-worker-main.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const identity = await Identity.fromPassphrase("serving worker main");
const space = "did:key:z6MkServingWorkerMainSpace" as MemorySpace;

describe("serveFromPort()", () => {
  let channel: MessageChannel;
  let server: Server;
  let bridge: ServingPortBridge;

  /**
   * Serves the channel's first port with `options`, and settles once the
   * host the bridge's init request describes serves.
   */
  const serve = async (options?: ServingWorkerMainOptions): Promise<void> => {
    serveFromPort(channel.port1, options);
    const init: ServingWorkerInit = {
      serviceKeyPair: realmValueFromKeyPair(identity.keyPair),
      // The realm's own component, so adopting it changes nothing here.
      processInstanceId,
      heartbeatIntervalMs: 60_000,
      apiUrl: new URL(import.meta.url).href,
      policy: undefined,
      ensureSpaceRoots: false,
      experimental: undefined,
      route: undefined,
      compileOnHost: undefined,
      compileCacheDir: undefined,
    };
    await bridge.init(init);
  };

  beforeEach(() => {
    channel = new MessageChannel();
    server = newSharedServer();
    bridge = new ServingPortBridge({ server, port: channel.port2 });
  });

  afterEach(async () => {
    await bridge.closeHost();
    bridge.close();
    channel.port1.close();
    channel.port2.close();
    await server.close();
  });

  it("runs a lifecycle verb through the entry's runner, as the service identity", async () => {
    const asked: unknown[] = [];
    await serve({
      runLifecycleVerb: (_host, verbSpace, verb, serviceIdentity) => {
        asked.push([verbSpace, verb, serviceIdentity.did()]);
        return Promise.resolve({ receipt: "ran", timings: [] });
      },
    });
    const verb = { name: "upload", request: { files: 1 } };
    expect(await bridge.runLifecycleVerb(space, verb)).toEqual({
      receipt: "ran",
      timings: [],
    });
    expect(asked).toEqual([[space, verb, identity.did()]]);
  });

  it("refuses every lifecycle verb when the entry runs none", async () => {
    await serve();
    await expect(
      bridge.runLifecycleVerb(space, { name: "upload", request: {} }),
    ).rejects.toThrow(
      `this serving worker runs no lifecycle verbs, so "upload" cannot run ` +
        `on ${space}`,
    );
  });
});
