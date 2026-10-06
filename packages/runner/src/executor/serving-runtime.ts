/**
 * The runtime factory an `ExecutorHost` builds its per-space serving runtimes
 * with: a runtime over a loopback storage manager on the co-hosted memory
 * server, signing its session opens as the service identity, in the serving
 * posture. It is the one construction of a serving runtime, so a test that
 * builds its host with it serves its spaces the way a deployment does.
 */

import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import { type ExperimentalOptions, Runtime } from "../runtime.ts";
import type { ExecutorHostOptions } from "./host.ts";
import { LoopbackStorageManager } from "./loopback-storage.ts";

/**
 * The flags a serving runtime runs regardless of the flags it is otherwise
 * given. A server that publishes its posture adds these on top of the base,
 * because the serving runtimes are the ones doing a serving deployment's
 * work.
 */
export const SERVING_RUNTIME_EXPERIMENTAL = {
  serverExecution: true,
} as const satisfies ExperimentalOptions;

/** What {@link servingRuntimeFactory} builds each serving runtime from. */
export type ServingRuntimeFactoryOptions = {
  /** The co-hosted memory server the loopback storage plane connects to. */
  server: MemoryServer;

  /** Signs the serving sessions' `session.open`; the host's service identity. */
  identity: Signer;

  /** The patterns and compile base, the serving runtimes' `apiUrl`. */
  apiUrl: URL;

  /**
   * Experimental flags for the serving runtimes, with
   * {@link SERVING_RUNTIME_EXPERIMENTAL} applied on top.
   */
  experimental?: ExperimentalOptions;

  /**
   * Called with each serving runtime's storage manager before the runtime
   * that uses it is constructed, so a test can replace one of its providers'
   * methods. The returned function, if any, runs once the runtime, and with
   * it the manager, is disposed.
   */
  prepareStorageManager?: (
    manager: LoopbackStorageManager,
    space: MemorySpace,
  ) => (() => void) | void;
};

/**
 * Returns an `ExecutorHost` runtime factory building each serving runtime as
 * described in this module's header. The runtime and its storage manager are
 * disposed together by the dispose function the factory hands back.
 */
export function servingRuntimeFactory(
  options: ServingRuntimeFactoryOptions,
): ExecutorHostOptions["createRuntime"] {
  return (space, context) => {
    const storageManager = LoopbackStorageManager.connect(options.server, {
      as: options.identity,
      // Naming the home space makes the manager's foreign-space providers
      // refuse scoped reads, fail-closed (protocol.md §2's grant-scoped read
      // design).
      servingHomeSpace: space,
    });
    // Installed ahead of the runtime, so no read this factory could ever
    // perform reaches the session.
    if (context.storeReadThrough !== undefined) {
      storageManager.installStoreReadThrough(space, context.storeReadThrough);
    }
    const release = options.prepareStorageManager?.(storageManager, space);
    const runtime = new Runtime({
      apiUrl: options.apiUrl,
      storageManager,
      // The SpaceServer's own runtime (serving-loop.md §3): never the
      // speculation-overlay default. Its factory-time loads commit through
      // the loopback plane, and the wave destination takes over at
      // activation.
      servingPosture: true,
      experimental: {
        ...options.experimental,
        ...SERVING_RUNTIME_EXPERIMENTAL,
      },
    });
    return Promise.resolve({
      runtime,
      // The runtime's dispose closes the storage manager it was given.
      dispose: async () => {
        try {
          await runtime.dispose();
        } finally {
          release?.();
        }
      },
    });
  };
}
