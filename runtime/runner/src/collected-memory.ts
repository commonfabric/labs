/**
 * A full garbage collection on request, and the memory an isolate still holds
 * once it has run. V8 gives `gc()` only to contexts created after
 * `--expose-gc` is set, so `exposeGarbageCollector()` sets that flag for the
 * whole process, workers included, and `collectedMemory()` takes `gc()` from
 * a context it creates, once per isolate. Whatever starts the process
 * decides whether to expose it, once, before any worker starts.
 */

import { setFlagsFromString } from "@node/v8";
import { runInNewContext } from "@node/vm";

/** The memory an isolate holds live, in bytes. */
export type CollectedMemory = {
  /** The isolate's heap. */
  heapUsed: number;

  /** Memory outside the heap that V8 accounts for, array buffers included. */
  external: number;
};

let exposed = false;
let gc: (() => void) | undefined;

/** Lets `collectedMemory()` collect, in every isolate of this process. */
export function exposeGarbageCollector(): void {
  setFlagsFromString("--expose-gc");
  exposed = true;
}

/** Returns whether `exposeGarbageCollector()` has run in this isolate. */
export function garbageCollectorExposed(): boolean {
  return exposed;
}

/**
 * Collects this isolate's whole heap, and returns the memory it still holds.
 * Throws unless `exposeGarbageCollector()` has run in some isolate of this
 * process.
 */
export function collectedMemory(): CollectedMemory {
  if (gc === undefined) {
    const found: unknown = runInNewContext("globalThis.gc");
    if (typeof found !== "function") {
      throw new Error(
        "V8 exposes no `gc()`, because this process has no `--expose-gc`",
      );
    }
    gc = () => found();
  }
  gc();
  const { heapUsed, external } = Deno.memoryUsage();
  return { heapUsed, external };
}
