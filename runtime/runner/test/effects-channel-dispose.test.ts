// The effects channel's manager-hook lifecycle across OVERLAPPING
// runtime lives (server-execution v2 Phase 4; independent review
// NOTE-a): a flag-ON non-serving Runtime installs
// `storageManager.spaceOpenObserver` at construction so its
// EffectsChannel subscribes to every space the (possibly shared)
// manager opens. When a LATER runtime is constructed over the same
// manager — a hand-over, the LT8 second life started before the first
// finishes tearing down — it replaces the hook; the EARLIER runtime's
// dispose must then leave the replacement alone. The pre-fix dispose
// cleared the hook unconditionally, so R1.dispose after R2's
// construction dropped R2's subscription hook: every space opened
// afterwards silently never reached R2's channel.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const aliceSigner = await Identity.fromPassphrase(
  "effects channel dispose alice",
);

describe("EffectsChannel manager-hook lifecycle", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: aliceSigner });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      try {
        await runtime.dispose({ closeStorage: false });
      } catch {
        // already disposed by the test body
      }
    }
    await manager.close();
    await server.close();
  });

  const newRuntime = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    runtimes.push(runtime);
    return runtime;
  };

  it("an earlier runtime's dispose keeps a later runtime's spaceOpenObserver (identity-guarded clear)", async () => {
    const r1 = newRuntime();
    expect(manager.spaceOpenObserver).toBeDefined();

    // The second life replaces the hook (last-installed wins).
    const r2 = newRuntime();
    const r2Hook = manager.spaceOpenObserver;
    expect(r2Hook).toBeDefined();

    // R1's teardown must NOT drop R2's hook: the installed hook is not
    // R1's own, so the identity-guarded clear leaves it in place.
    await r1.dispose({ closeStorage: false });
    expect(manager.spaceOpenObserver).toBe(r2Hook);

    // R2's own teardown still releases the manager hook (no stale
    // closure lingers on a shared manager).
    await r2.dispose({ closeStorage: false });
    expect(manager.spaceOpenObserver).toBeUndefined();
  });
});
