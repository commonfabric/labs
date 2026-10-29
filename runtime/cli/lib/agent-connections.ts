/** Storage-only connections to the toolsheds holding agent-run records. */

import {
  Runtime,
  runtimePresets,
  settingsForDeployedClient,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveCliGitSha } from "./build-info.ts";
import { loadIdentity } from "./identity.ts";

/**
 * Opens a record host without changing the process's home deployment. Memory
 * opens on the memory URL the record host's own deployment publishes, where
 * it publishes one.
 */
export async function openAgentStorageHost(
  identityPath: string,
  origin: string,
): Promise<Runtime> {
  const apiUrl = new URL(origin);
  const [{ experimental, memoryHost }, identity, clientGitSha] = await Promise
    .all([
      settingsForDeployedClient({ apiUrl, env: Deno.env.get }),
      loadIdentity(identityPath),
      resolveCliGitSha(),
    ]);
  const options = runtimePresets.remoteClient({
    apiUrl,
    memoryHost,
    storageManager: StorageManager.open({
      as: identity,
      clientBuild: { application: "cf", gitSha: clientGitSha },
      memoryHost,
    }),
    experimental,
  });
  return new Runtime({ ...options, patternEnvironment: undefined });
}
