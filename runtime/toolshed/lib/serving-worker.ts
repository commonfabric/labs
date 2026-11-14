/**
 * The toolshed's serving worker entry (serving-loop-worker.md): the runner's
 * worker main with what this deployment adds. The pattern-lifecycle verbs
 * its `pattern.lifecycle` handler sends are built here from
 * `@commonfabric/piece`'s served lifecycle, requests the serving runtimes
 * address to the public origin go to this server's own listener when an
 * internal origin is set. Its serving runtimes compile in the compile workers
 * the toolshed process shares, and read and put compiled modules in the cache
 * every toolshed on the host shares, both of which the pool names in the
 * worker's init; where the init names no shared cache, they share one cache
 * in this worker's memory. Loading this module anywhere but in a Worker
 * serves nothing; `lib/server-execution.ts`
 * starts a `ServingWorkerPool` that runs it in Workers and places each
 * served space on one.
 */

import {
  runServedLifecycleVerb,
  type ServedLifecycleVerbDescriptor,
} from "@commonfabric/piece/ops";
import { serveFromPort } from "@commonfabric/runner/executor/serving-worker-main";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import env from "@/env.ts";
import { toolshedClientBuild } from "@/lib/build-info.ts";
import { selfDirectedFetch } from "@/lib/internal-api-origin.ts";

const fetch = selfDirectedFetch(env);

serveFromPort(self as unknown as Parameters<typeof serveFromPort>[0], {
  clientBuild: toolshedClientBuild(),
  runLifecycleVerb: (host, space, verb, identity) =>
    runServedLifecycleVerb(
      host,
      space,
      verb as ServedLifecycleVerbDescriptor,
      identity,
    ),
  ...(fetch === undefined ? {} : { fetch }),
  moduleByteCache: new ProcessModuleByteCache(),
});
