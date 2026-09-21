/** Storage-only connections to the toolsheds holding agent-run records. */

import {
  experimentalOptionsForDeployedClient,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadIdentity } from "./identity.ts";

/** Opens a record host without changing the process's home deployment. */
export async function openAgentStorageHost(
  identityPath: string,
  origin: string,
): Promise<Runtime> {
  const options = runtimePresets.remoteClient({
    apiUrl: new URL(origin),
    storageManager: StorageManager.open({
      as: await loadIdentity(identityPath),
      memoryHost: new URL(origin),
    }),
    experimental: await experimentalOptionsForDeployedClient({
      apiUrl: new URL(origin),
      env: Deno.env.get,
    }),
  });
  return new Runtime({ ...options, patternEnvironment: undefined });
}
