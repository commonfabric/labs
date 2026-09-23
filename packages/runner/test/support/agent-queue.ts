/**
 * Test support for the home-space agent queue: seeds the structure the home
 * default pattern holds in its `agentQueue` field, without compiling
 * `home.tsx`.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

/**
 * Writes a home default pattern holding an empty agent queue into
 * `homeSpace`, under `tx`. The default pattern is a document of its own that
 * the space cell links to, which is the shape a running `home.tsx` leaves.
 */
export function seedHomeAgentQueue(
  runtime: Runtime,
  homeSpace: MemorySpace,
  tx: IExtendedStorageTransaction,
): void {
  const defaultPattern = runtime.getCell(
    homeSpace,
    "test-home-default-pattern",
    undefined,
    tx,
  );
  defaultPattern.key("agentQueue").set({ entries: [] });
  // deno-lint-ignore no-explicit-any
  (runtime.getHomeSpaceCell(tx) as any).key("defaultPattern").set(
    defaultPattern,
  );
}
