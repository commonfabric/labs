// `Runtime.trackEventIntent()`: an event fired before any speculative edit
// installs the flag-ON client overlay and is counted by it, so a wait for
// intent quiescence covers a runtime whose first act is a stream send.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const aliceSigner = await Identity.fromPassphrase("track event intent alice");
const space = (await Identity.fromPassphrase("track event intent space"))
  .did() as MemorySpace;

describe("Runtime.trackEventIntent()", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: aliceSigner });
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.dispose({ closeStorage: false });
    await manager.close();
    await server.close();
  });

  const newRuntime = (serverExecution: boolean): Runtime => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution },
    });
    return runtime;
  };

  it("installs the overlay and counts the intent on a runtime that has made no speculative edit", () => {
    const client = newRuntime(true);
    expect(client.speculationOverlay).toBeUndefined();
    client.trackEventIntent(space, "of:stream-events:first", "first");
    expect(client.speculationOverlay?.pendingIntentCount).toBe(1);
  });

  it("installs no overlay in the OFF arm", () => {
    const client = newRuntime(false);
    client.trackEventIntent(space, "of:stream-events:first", "first");
    expect(client.speculationOverlay).toBeUndefined();
  });
});
