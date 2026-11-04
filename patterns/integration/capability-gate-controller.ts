import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import { moduleByteCache } from "./pieces-controller.ts";

/**
 * Returns a controller over a fresh space in emulated storage, created by and
 * owned by a fresh identity, for one capability-gate check.
 */
export async function initializeCapabilityGateController(): Promise<
  PiecesController
> {
  const identity = await Identity.generate({ implementation: "noble" });
  const runtime = new Runtime({
    apiUrl: new URL(
      Deno.env.get("API_URL") ?? "http://localhost:8000/",
    ),
    storageManager: StorageManager.emulate({ as: identity }),
    moduleByteCache,
    trustSnapshotProvider: () => ({
      id: `principal:${identity.did()}`,
      actingPrincipal: identity.did(),
    }),
  });
  const session = createSession({
    identity,
    spaceDid: await runtime.createSpace(),
  });
  const pieces = new PiecesController(session, runtime);
  await pieces.synced();
  return pieces;
}
