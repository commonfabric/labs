import { createSession, Identity } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  experimentalOptionsForDeployedClient,
  type MemorySpace,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { abortable } from "./abort.ts";
import { parseAgentFabricApiUrl } from "./target-state.ts";

export interface AgentFabricRuntime {
  runtime: Runtime;
  graphRuntime: Runtime;
  manager: PiecesController;
  spaceDid: MemorySpace;
  target: AgentFabricTarget;
  ownerDid: string;
}

export function assertConfiguredOwner(
  identity: Identity,
  ownerDid: string,
): void {
  if (identity.did() !== ownerDid) {
    throw new Error(
      `configured owner ${ownerDid} does not match identity ${identity.did()}`,
    );
  }
}

export async function openAgentFabricRuntime(options: {
  apiUrl: string;
  identityPath: string;
  ownerDid: string;
  space: string;
  deferStorageClaim?: boolean;
  signal?: AbortSignal;
}): Promise<AgentFabricRuntime> {
  options.signal?.throwIfAborted();
  const apiUrl = parseAgentFabricApiUrl(options.apiUrl);
  const identityBytes = await Deno.readFile(options.identityPath);
  options.signal?.throwIfAborted();
  const identity = await Identity.fromPkcs8(identityBytes);
  assertConfiguredOwner(identity, options.ownerDid);
  options.signal?.throwIfAborted();
  const session =
    await (isDID(options.space)
      ? createSession({ identity, spaceDid: options.space })
      : createSession({ identity, spaceName: options.space }));
  options.signal?.throwIfAborted();
  // The deployment's posture, with this host's explicit EXPERIMENTAL_* still
  // winning per flag: an agents host is deployed separately from the toolshed
  // it talks to (docs/development/EXPERIMENTAL_OPTIONS.md). Resolved as its
  // own stage, ahead of the storage manager, so a startup cancelled while the
  // deployment is slow to answer leaves nothing allocated behind — the
  // request carries the signal, and every later stage is already cancellable.
  const experimental = await experimentalOptionsForDeployedClient({
    apiUrl,
    env: (key) => Deno.env.get(key),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  options.signal?.throwIfAborted();
  const allocatedResources: Array<() => Promise<void>> = [];
  const createRuntime = () => {
    const storageManager = StorageManager.open({
      as: session.as,
      memoryHost: apiUrl,
      spaceIdentity: session.spaceIdentity,
    });
    const resourceIndex = allocatedResources.push(
      () => storageManager.close(),
    ) - 1;
    const runtime = new Runtime(runtimePresets.remoteClient({
      apiUrl,
      storageManager,
      experimental,
      trustSnapshotProvider: () => ({
        id: `principal:${session.as.did()}`,
        actingPrincipal: session.as.did(),
      }),
    }));
    allocatedResources[resourceIndex] = () => runtime.dispose();
    return runtime;
  };
  let disposeTask: Promise<void> | undefined;
  const dispose = () =>
    disposeTask ??= Promise.allSettled(
      allocatedResources.toReversed().map((disposeResource) =>
        disposeResource()
      ),
    ).then((outcomes) => {
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Fabric runtime cleanup failed");
      }
    });

  const stage = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await abortable(operation, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        const [, disposal] = await Promise.allSettled([operation, dispose()]);
        if (disposal.status === "rejected") {
          throw new AggregateError(
            [error, disposal.reason],
            "Fabric runtime startup cancellation and cleanup failed",
          );
        }
      }
      throw error;
    }
  };

  try {
    const runtime = createRuntime();
    const graphRuntime = createRuntime();
    if (!(await stage(runtime.healthCheck(options.signal)))) {
      throw new Error(`could not connect to ${apiUrl.origin}`);
    }
    options.signal?.throwIfAborted();
    const manager = new PiecesController(session, runtime);
    await stage(manager.synced());
    options.signal?.throwIfAborted();
    const connection = {
      runtime,
      spaceDid: session.space,
      ownerDid: options.ownerDid,
    };
    const graphConnection = {
      runtime: graphRuntime,
      spaceDid: session.space,
      ownerDid: options.ownerDid,
    };
    const graphSessionFactory = () =>
      Promise.resolve({
        connection: graphConnection,
        release: () => graphRuntime.storageManager.close(),
      });
    const target = await stage(
      options.deferStorageClaim
        ? AgentFabricTarget.connect(
          connection,
          undefined,
          graphSessionFactory,
        )
        : AgentFabricTarget.open(
          connection,
          undefined,
          graphSessionFactory,
        ),
    );
    options.signal?.throwIfAborted();
    return {
      runtime,
      graphRuntime,
      manager,
      spaceDid: session.space,
      target,
      ownerDid: options.ownerDid,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "Fabric runtime startup and cleanup failed",
      );
    }
    throw error;
  }
}
