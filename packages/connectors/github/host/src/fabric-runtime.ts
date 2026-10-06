import { GithubFabricTarget } from "@commonfabric/github-connector/fabric";
import {
  createSession,
  Identity,
  isDID,
  legacySpaceDid,
} from "@commonfabric/identity";
import {
  memoryHostNote,
  type MemorySpace,
  Runtime,
  runtimePresets,
  settingsForDeployedClient,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

export interface GithubFabricRuntime {
  runtime: Runtime;
  spaceDid: MemorySpace;
  target: GithubFabricTarget;
}

/** Open the authenticated remote Fabric runtime used by the GitHub host. */
export async function openGithubFabricRuntime(options: {
  apiUrl: string;
  identityPath: string;
  space: string;
  githubHost: string;
  githubAccount: string;
}): Promise<GithubFabricRuntime> {
  let apiUrl: URL;
  try {
    apiUrl = new URL(options.apiUrl);
  } catch (error) {
    throw new Error("Common Fabric API URL is not valid", { cause: error });
  }
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(options.identityPath),
  );
  const session = createSession({
    identity,
    spaceDid: isDID(options.space)
      ? options.space
      : await legacySpaceDid(options.space),
  });
  // The deployment's posture, with this host's explicit EXPERIMENTAL_* still
  // winning per flag: the GitHub host is installed separately from the
  // toolshed it talks to (docs/development/EXPERIMENTAL_OPTIONS.md), so an
  // unset flag must adopt what the server runs rather than fall to this
  // build's own default — the same resolution the agents host and the pieces
  // controller perform. The same document names the memory URL Memory opens
  // on, where the deployment has one. Resolved before anything is allocated;
  // this startup carries no cancellation signal to thread.
  const { experimental, memoryHost } = await settingsForDeployedClient({
    apiUrl,
    env: (key) => Deno.env.get(key),
  });
  const storageManager = StorageManager.open({
    as: session.as,
    memoryHost,
  });
  const runtime = new Runtime(runtimePresets.remoteClient({
    apiUrl,
    memoryHost,
    storageManager,
    experimental,
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  }));
  try {
    if (!(await runtime.healthCheck())) {
      throw new Error(
        `could not connect to ${apiUrl.origin}` +
          memoryHostNote(memoryHost, apiUrl),
      );
    }
    const target = await GithubFabricTarget.open(
      { runtime, spaceDid: session.space },
      { host: options.githubHost, account: options.githubAccount },
    );
    return { runtime, spaceDid: session.space, target };
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "GitHub Fabric runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}
