// The ride that only the read-repair backstop can end, shared by both guard
// fixtures so the scenario cannot drift between them.
//
// A cold replica commits a read of a document another client already wrote, so
// the server refuses the commit for its stale basis and stages the caught-up
// frame the retry is gated on. The server's fan-out is manual and never
// flushed, so that frame never arrives: the read-repair wait in
// `src/storage/v2.ts` has nothing to resolve it but the
// `CONFLICT_READ_REPAIR_TIMEOUT_MS` backstop, which the auto-advance clock
// fires as soon as the loop is idle. The commit's own assertion — it came back
// as the conflict — holds; the only trace of the skipped retry gate is the
// backstop's counted warn, which the guard turns into a failure.

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { Runtime } from "../../src/runtime.ts";
import { toMemorySpaceAddress } from "../../src/link-utils.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("conflict read-repair backstop");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

/** Runs the ride once: the committed conflict is asserted, and the backstop
 * fires along the way. */
export async function rideReadRepairBackstop(): Promise<void> {
  // Declared out here and created inside the `try`, so a throw while
  // constructing any of them still runs the `finally` for the ones that
  // exist.
  let server: ReturnType<typeof newSharedServer> | undefined;
  let smA: EmulatedStorageManager | undefined;
  let runtimeA: Runtime | undefined;
  let smB: EmulatedStorageManager | undefined;
  let runtimeB: Runtime | undefined;
  try {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    smA = EmulatedStorageManager.connectTo(server, { as: signer });
    runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    smB = EmulatedStorageManager.connectTo(server, { as: signer });
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smB,
    });

    // A writes the document and holds its verdict; `synced()` would wait on
    // a marker the manual fan-out never delivers.
    const txA = runtimeA.edit();
    const shared = runtimeA.getCell(space, "backstop-doc", valueSchema, txA);
    shared.set({ value: 1 });
    const address = toMemorySpaceAddress(shared.getAsNormalizedFullLink());
    const accepted = await txA.commit({ resolveAt: "verdict" });
    expect(accepted.error).toBeUndefined();

    // B, cold, reads the document by address — an absence claim the server
    // refuses — and commits. The rejection carries the retry gate; its
    // read-repair wait can end only through the backstop.
    const txB = runtimeB.edit();
    txB.read(address);
    runtimeB.getCell(space, "backstop-own-doc", valueSchema, txB).set({
      value: 2,
    });
    const refused = await txB.commit();
    expect(refused.error?.name).toBe("ConflictError");
  } finally {
    await runtimeB?.dispose({ closeStorage: false });
    await runtimeA?.dispose({ closeStorage: false });
    await smB?.close();
    await smA?.close();
    await server?.close();
  }
}
