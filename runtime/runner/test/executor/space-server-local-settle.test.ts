import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("local settle space");
const serviceSigner = await Identity.fromPassphrase("local settle service");
const space = spaceSigner.did() as MemorySpace;

/**
 * Serves `space` under the posture `storeReadThrough` names, over a server
 * whose `idle()` calls are counted, and commits one derivation through the
 * loop's wave so that one settle runs to its end.
 */
async function serveOneWave(
  storeReadThrough: boolean,
): Promise<{ idleCalls: number; committed: unknown }> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  const manager = EmulatedStorageManager.connectTo(server, {
    as: serviceSigner,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
    servingPosture: true,
    experimental: { serverExecution: true },
  });
  let idleCalls = 0;
  const facade = new Proxy(server, {
    get(target, property, receiver) {
      if (property === "idle") {
        return () => {
          idleCalls++;
          return target.idle();
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const serving = new SpaceServer({
    space,
    engine,
    server: facade,
    serviceIdentity: serviceSigner.did(),
    createRuntime: () =>
      Promise.resolve({ runtime, dispose: () => runtime.dispose() }),
    localSeqRef: { value: 0 },
    stats: emptyServingLoopStats(),
    policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000, storeReadThrough },
  });
  try {
    expect(await serving.activate()).toBe(true);
    const probe = runtime.getCell<number>(space, "first-work", undefined);
    await probe.sync();
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "first-work", kind: "derivation" });
    probe.withTx(tx).set(42);
    expect((await tx.commit().settled).error).toBeUndefined();
    const accepted = await waveSettlementOf(tx);
    expect(accepted?.error).toBeUndefined();
    return {
      idleCalls,
      committed: Engine.read(engine, {
        id: probe.getAsNormalizedFullLink().id,
      })?.value,
    };
  } finally {
    try {
      await serving.park("test-teardown");
    } finally {
      await server.close();
    }
  }
}

describe("SpaceServer", () => {
  describe("instance members", () => {
    describe("activate()", () => {
      it("waits on the server's idle before declaring a wave quiescent when the home space reads over its session", async () => {
        const served = await serveOneWave(false);
        expect(served.committed).toBe(42);
        expect(served.idleCalls).toBeGreaterThan(0);
      });

      it("declares a wave quiescent without the server's idle under the store read-through posture", async () => {
        const served = await serveOneWave(true);
        expect(served.committed).toBe(42);
        expect(served.idleCalls).toBe(0);
      });
    });
  });
});
