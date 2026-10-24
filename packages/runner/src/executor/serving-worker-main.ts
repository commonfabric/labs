/**
 * What a serving worker's entry module does once loaded: installs the port's
 * endpoint on the worker's global scope, waits for the `worker.init` request,
 * which carries the service key and the host's options, builds the
 * `ExecutorHost` over a `ServingPlane`, and answers once the host serves. The
 * runner's own entry (`serving-worker.ts`) calls this bare; an entry in a
 * higher layer calls it with the lifecycle verbs it can build and the fetch
 * and module cache its deployment uses.
 */

import { Identity, keyPairFromRealmValue } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { adoptProcessInstanceId } from "@commonfabric/memory/v2/execution-lease";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/utils/logger";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import { setPatternEnvironment } from "../builder/env.ts";
import type { ModuleByteCache, RuntimeFetch } from "../runtime.ts";
import { ExecutorHost } from "./host.ts";
import { ServingPlane, servingPlaneEndpoint } from "./serving-port-plane.ts";
import type {
  LifecycleVerbDescriptor,
  LifecycleVerbRun,
  PortLike,
} from "./serving-port-protocol.ts";
import { servingRuntimeFactory } from "./serving-runtime.ts";

/** What an entry module adds to the host the init request describes. */
export type ServingWorkerMainOptions = {
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

  /** A compiled-module cache every serving runtime of this worker shares. */
  moduleByteCache?: ModuleByteCache;
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
    // The environment a served handler's `fetch` resolves against is this
    // realm's, so it is set here to what the process that started the worker
    // serves patterns from, as that process sets its own.
    setPatternEnvironment({ apiUrl: new URL(init.apiUrl) });
    const identity = await Identity.fromKeyPair(
      keyPairFromRealmValue(init.serviceKeyPair, "the serving worker's key"),
    );
    const plane = new ServingPlane(endpoint);
    const host = new ExecutorHost({
      server: plane.server,
      serviceIdentity: identity.did(),
      createRuntime: servingRuntimeFactory({
        server: plane.loopback,
        identity,
        apiUrl: new URL(init.apiUrl),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(init.experimental === undefined
          ? {}
          : { experimental: init.experimental }),
        ...(options.moduleByteCache === undefined
          ? {}
          : { moduleByteCache: options.moduleByteCache }),
      }),
      ...(init.policy === undefined ? {} : { policy: init.policy }),
      ...(init.ensureSpaceRoots === undefined
        ? {}
        : { ensureSpaceRoots: init.ensureSpaceRoots }),
      createWaveCommitSink: (deps) => plane.createWaveCommitSink(deps),
      // The counters cross on the loop's own edges: every wave cycle, and
      // each tenure's start and end.
      onWaveCycle: () => plane.reportStats(host.stats()),
      onActivationSettled: (space, outcome) => {
        plane.reportActivationSettled(space, outcome);
        plane.reportStats(host.stats());
      },
      onSpaceParked: (space, reason) => {
        plane.reportSpaceParked(space, reason);
        plane.reportStats(host.stats());
      },
    });
    plane.serve({
      stats: () => host.stats(),
      // This realm's loggers: the serving loop's own counts and timings.
      diagnostics: () => ({
        loggerCounts: getLoggerCountsBreakdown(),
        timingStats: getTimingStatsBreakdown(),
      }),
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
        try {
          await host.close();
        } finally {
          await plane.close();
        }
      },
    });
    return { lifetimeLock: await holdWorkerLifetimeLock() };
  });
  endpoint.notify("worker.ready", null);
}
