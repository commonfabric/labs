/**
 * The serving loop's worker entry (serving-loop-worker.md). Loading this
 * module in a serving worker's thread serves that thread's port, with no
 * lifecycle verbs, and with one compiled-module cache and one compile worker
 * for every space the worker serves, as a toolshed's own entry has;
 * `serving-worker-main.ts` has the rest. Nothing outside a worker imports a
 * value from here; the pool in `serving-worker-host.ts` runs it in Workers
 * and places each served space on one.
 */

import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import { ModuleCompileWorker } from "../harness/module-compile-worker.ts";
import { serveFromPort } from "./serving-worker-main.ts";
import { servingWorkerPort } from "./serving-thread.ts";

serveFromPort(servingWorkerPort(), {
  moduleByteCache: new ProcessModuleByteCache(),
  moduleCompiler: new ModuleCompileWorker(),
});
