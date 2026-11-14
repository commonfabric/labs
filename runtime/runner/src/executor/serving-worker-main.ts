/**
 * What a serving worker's entry module does once loaded: installs the port's
 * endpoint on the worker's global scope, waits for the `worker.init` request,
 * which carries the service key and the host's options, builds the
 * `ExecutorHost` over a `ServingPlane`, and answers once the host serves. The
 * runner's own entry (`serving-worker.ts`) calls this bare; an entry in a
 * higher layer calls it with the lifecycle verbs it can build and the fetch
 * and module cache its deployment uses. Where the init says so, the serving
 * runtimes compile in the compile workers the process shares, and read and
 * put compiled modules in the cache directory every process on the host
 * shares, in place of what the entry gives.
 */

import { Identity, keyPairFromRealmValue } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ClientBuild } from "@commonfabric/memory/v2/client-info";
import { adoptProcessInstanceId } from "@commonfabric/memory/v2/execution-lease";
import { holdWorkerLifetimeLock } from "@commonfabric/platform/worker-lifetime";
import { setPatternEnvironment } from "../builder/env.ts";
import { collectedMemory } from "../collected-memory.ts";
import { openSharedCompileCache } from "../compilation-cache/shared-compile-cache.deno.ts";
import type { ModuleCompileWorker } from "../harness/module-compile-worker.ts";
import type { ModuleByteCache, RuntimeFetch } from "../runtime.ts";
import { ExecutorHost } from "./host.ts";
import { webSocketRoute } from "./routed-plane.ts";
import { servingLoopDiagnostics } from "./serving-loop-diagnostics.ts";
import { ServingPlane, servingPlaneEndpoint } from "./serving-port-plane.ts";
import type {
  LifecycleVerbDescriptor,
  LifecycleVerbRun,
  PortLike,
} from "./serving-port-protocol.ts";
import { servingRuntimeFactory } from "./serving-runtime.ts";
import { watchHeapLimit } from "./serving-thread.ts";

/** What an entry module adds to the host the init request describes. */
export type ServingWorkerMainOptions = {
  /** Application and loaded labs build reported by each serving runtime. */
  clientBuild?: ClientBuild;

  /**
   * Runs the verb a lifecycle descriptor names through `host`, on the
   * space's serving runtime as the service identity, timing its steps.
   * Absent, every verb is refused.
   */
  runLifecycleVerb?: (
    host: Pick<ExecutorHost, "runLifecycleVerb">,
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
    serviceIdentity: Identity,
  ) => Promise<LifecycleVerbRun>;

  /** The serving runtimes' outbound fetch; absent, the platform fetch. */
  fetch?: RuntimeFetch;

  /**
   * A compiled-module cache every serving runtime of this worker shares,
   * where the init names no shared cache directory.
   */
  moduleByteCache?: ModuleByteCache;

  /**
   * The compile worker every serving runtime of this worker compiles in,
   * where the init does not have them compile on the server's thread. It
   * closes just before the host does, so a compile an activation still awaits
   * fails at once.
   */
  moduleCompiler?: ModuleCompileWorker;
};

/**
 * Serves the port `port` is one end of, as this module's header describes.
 * Returns once the endpoint listens; the host is built when the init request
 * arrives.
 */
export function serveFromPort(
  port: PortLike,
  options: ServingWorkerMainOptions = {},
): void {
  const endpoint = servingPlaneEndpoint(port);
  endpoint.onRequest("worker.init", async (init) => {
    adoptProcessInstanceId(init.processInstanceId);
    // A timer on this thread, so that the watchdog on the server's thread hears
    // nothing once this thread stops (serving-loop.md §2). It also runs once
    // a handler of this thread has ended at the heap limit, which is how the
    // pool learns of that.
    const heapLimitReached = watchHeapLimit();
    const heartbeat = setInterval(
      () => {
        const { heapUsed, external } = Deno.memoryUsage();
        endpoint.notify("worker.heartbeat", {
          heapUsed,
          external,
          heapLimitReached: heapLimitReached(),
        });
      },
      init.heartbeatIntervalMs,
    );
    // The environment a served handler's `fetch` resolves against is this
    // realm's, so it is set here to what the process that started the worker
    // serves patterns from, as that process sets its own.
    setPatternEnvironment({ apiUrl: new URL(init.apiUrl) });
    const identity = await Identity.fromKeyPair(
      keyPairFromRealmValue(init.serviceKeyPair, "the serving worker's key"),
    );
    const plane = new ServingPlane(endpoint);
    const shared = init.compileCacheDir === undefined
      ? undefined
      : openSharedCompileCache(init.compileCacheDir);
    const moduleByteCache = shared?.moduleByteCache ?? options.moduleByteCache;
    // The worker's own compile worker, where the init leaves it one.
    const ownCompiler = init.compileOnHost === true
      ? undefined
      : options.moduleCompiler;
    const moduleCompiler = init.compileOnHost === true
      ? plane.compiler
      : ownCompiler;
    const host = new ExecutorHost({
      server: plane.server,
      serviceIdentity: identity.did(),
      createRuntime: servingRuntimeFactory({
        server: plane.loopback,
        identity,
        apiUrl: new URL(init.apiUrl),
        clientBuild: options.clientBuild,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(init.experimental === undefined
          ? {}
          : { experimental: init.experimental }),
        ...(moduleByteCache === undefined ? {} : { moduleByteCache }),
        ...(shared === undefined
          ? {}
          : { compileClaims: shared.compileClaims }),
        ...(moduleCompiler === undefined ? {} : { moduleCompiler }),
      }),
      ...(init.policy === undefined ? {} : { policy: init.policy }),
      ...(init.ensureSpaceRoots === undefined
        ? {}
        : { ensureSpaceRoots: init.ensureSpaceRoots }),
      ...(init.route === undefined ? {} : {
        route: webSocketRoute(
          new URL(init.route),
          identity,
          options.clientBuild,
        ),
      }),
      createWaveCommitSink: (deps) => plane.createWaveCommitSink(deps),
      // The counters cross on the loop's own edges: every wave cycle, and
      // each tenure's start and end. The sink also posts the counters other
      // than the settle blocks ahead of each wave commit, so the server's
      // thread holds what a wave counted before its commit by the time it
      // applies that commit.
      onWaveCycle: () => plane.reportStats(host.stats()),
      onActivationSettled: (space, outcome) => {
        plane.reportActivationSettled(space, outcome);
        plane.reportStats(host.stats());
      },
      onSpaceParked: (space, reason) => {
        plane.reportSpaceParked(space, reason);
        plane.reportStats(host.stats());
      },
      onOccupancyChanged: (occupancy) => plane.reportOccupancy(occupancy),
    });
    plane.serve({
      stats: () => host.stats(),
      counters: () => host.counters(),
      // This realm's loggers, the serving loop's own counts and timings, and
      // the timings of a compile worker of its own, which hold the compiler's
      // phases. The compile workers the process shares report on the
      // server's thread.
      diagnostics: () => servingLoopDiagnostics(ownCompiler),
      collectedMemory,
      occupancy: () => host.occupancy,
      noteSpaceAclChanged: (space) => host.noteSpaceAclChanged(space),
      runLifecycleVerb: (space, verb) => {
        if (options.runLifecycleVerb === undefined) {
          return Promise.reject(
            new Error(
              `this serving worker runs no lifecycle verbs, so "${verb.name}" ` +
                `cannot run on ${space}`,
            ),
          );
        }
        return options.runLifecycleVerb(host, space, verb, identity);
      },
      close: async () => {
        // The compiles end first, in a compile worker of its own or in the
        // ones the process shares, so a compile an activation still awaits
        // fails at once rather than holding the host's close. An activation
        // waiting for its turn at a compile another process holds waits for
        // that turn, which ends with the holder's compile or its process.
        ownCompiler?.close();
        plane.stopCompiling();
        try {
          await host.close();
        } finally {
          clearInterval(heartbeat);
          await plane.close();
        }
      },
    });
    return { lifetimeLock: await holdWorkerLifetimeLock() };
  });
  endpoint.notify("worker.ready", null);
}
