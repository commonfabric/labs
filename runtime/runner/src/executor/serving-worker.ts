/**
 * The serving loop's worker entry (serving-loop-worker.md). Loading this
 * module in a Worker serves the worker's global scope as a port, with no
 * lifecycle verbs, and with one compiled-module cache for every space the
 * worker serves, as a toolshed's own entry has; `serving-worker-main.ts` has
 * the rest. Nothing outside a worker imports a value from here;
 * `serving-worker-host.ts` starts one.
 */

import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import type { PortLike } from "./serving-port-protocol.ts";
import { serveFromPort } from "./serving-worker-main.ts";

serveFromPort(self as unknown as PortLike, {
  moduleByteCache: new ProcessModuleByteCache(),
});
