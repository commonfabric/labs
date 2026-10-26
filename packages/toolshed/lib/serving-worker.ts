/**
 * The toolshed's serving worker entry (serving-loop-worker.md): the runner's
 * worker main with what this deployment adds. The pattern-lifecycle verbs
 * its route sends are built here from `@commonfabric/piece`'s served
 * lifecycle, requests the serving runtimes address to the public origin go
 * to this server's own listener when an internal origin is set, and one
 * compiled-module cache serves every space the worker serves. Loading this
 * module anywhere but in a Worker serves nothing; `lib/server-execution.ts`
 * starts it.
 */

import {
  runServedLifecycleVerb,
  type ServedLifecycleVerbDescriptor,
} from "@commonfabric/piece/ops";
import { serveFromPort } from "@commonfabric/runner/executor/serving-worker-main";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import env from "@/env.ts";
import { selfDirectedFetch } from "@/lib/internal-api-origin.ts";

const fetch = selfDirectedFetch(env);

serveFromPort(self as unknown as Parameters<typeof serveFromPort>[0], {
  runLifecycleVerb: (host, space, verb, identity) =>
    runServedLifecycleVerb(
      host,
      space,
      verb as ServedLifecycleVerbDescriptor,
      identity,
    ),
  ...(fetch === undefined ? {} : { fetch }),
  // One cache for every space this worker serves. A space's root pattern
  // compiles into that space's own storage closure, which a fresh space
  // never holds; the shared cache is what lets a later space's activation
  // skip the transform-and-emit step for modules this worker compiled.
  moduleByteCache: new ProcessModuleByteCache(),
});
