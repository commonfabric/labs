// The event-dispatch stamp's action identity (serving-loop.md §3d /
// scheduler_basis's "durable action identity/fingerprint; restart-
// stable"; PR #5439 thread r3731191399). An event-handler run's stamp
// must carry the HANDLER's durable identity: stamping the per-event
// wrapper closure mints a fresh anonymous id per queued event, splitting
// scheduler-basis rows per event (overwrite-in-place never overwrites)
// and making recovery/identity matching unstable across restarts.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test event stamp identity");
const space = signer.did();

describe("event-dispatch stamp identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("stamps a dispatch with the HANDLER's durable identity — stable across that handler's events, DISTINCT across handlers", async () => {
    const stamped: ServerRunInfo[] = [];
    runtime.installSealDestination(
      {
        // The stub destination accepts every seal; only the stamped run
        // contexts matter here.
        seal: (_tx: IExtendedStorageTransaction) => Promise.resolve({ ok: {} }),
      },
      { runStamper: (_tx, info) => stamped.push(info) },
    );

    const streamA = runtime.getCell<{ n: number }>(
      space,
      "stamp-identity-stream-a",
      undefined,
    );
    const streamB = runtime.getCell<{ n: number }>(
      space,
      "stamp-identity-stream-b",
      undefined,
    );
    const setupTx = runtime.edit();
    streamA.withTx(setupTx).set({} as { n: number });
    streamB.withTx(setupTx).set({} as { n: number });
    await setupTx.commit().settled;

    const handlerA = (_tx: IExtendedStorageTransaction, _event: unknown) => {};
    const handlerB = (_tx: IExtendedStorageTransaction, _event: unknown) => {};
    runtime.scheduler.addEventHandler(
      handlerA,
      streamA.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      handlerB,
      streamB.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), { n: 1 });
    await runtime.idle();
    runtime.scheduler.queueEvent(streamA.getAsNormalizedFullLink(), { n: 2 });
    await runtime.idle();
    runtime.scheduler.queueEvent(streamB.getAsNormalizedFullLink(), { n: 3 });
    await runtime.idle();

    const eventStamps = stamped.filter((info) => info.kind === "event-handler");
    expect(eventStamps.length).toBe(3);
    // Stable per handler: both of handlerA's dispatches share one id.
    expect(eventStamps[1].actionId).toBe(eventStamps[0].actionId);
    // Never a per-event anonymous wrapper id.
    for (const stamp of eventStamps) {
      expect(stamp.actionId.startsWith("anon-")).toBe(false);
    }
    // DISTINCT per handler: stamping the dispatch WRAPPER instead of the
    // handler collapses every handler's basis rows onto one constant
    // action identity (the wrapper closure's inferred name), so two
    // different handlers' rows overwrite each other in scheduler_basis.
    expect(eventStamps[2].actionId).not.toBe(eventStamps[0].actionId);
    // The stamp's eventId half stays per-event.
    const eventIds = new Set(eventStamps.map((stamp) => stamp.eventId));
    expect(eventIds.size).toBe(3);
  });
});
