/**
 * The serving worker entry `heap-worker-probe.ts` starts: the runner's worker
 * main with the pattern-lifecycle verbs a toolshed adds, plus a heap snapshot
 * on request. When `snap.req` appears in the directory `HEAP_PROBE_DIR` names,
 * holding an output path, the worker collects, writes its heap there, and
 * writes `<path>.done` holding its heap size. A snapshot the worker writes
 * holds the worker's heap and nothing else, which the inspector, reaching the
 * main thread alone, cannot give. Loading this module anywhere but in a Worker
 * serves nothing.
 */

// deno-lint-ignore no-external-import -- Deno writes a heap snapshot through this Node builtin alone.
import v8 from "node:v8";
import {
  runServedLifecycleVerb,
  type ServedLifecycleVerbDescriptor,
} from "@commonfabric/piece/ops";
import { serveFromPort } from "@commonfabric/runner/executor/serving-worker-main";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";

serveFromPort(self as unknown as Parameters<typeof serveFromPort>[0], {
  runLifecycleVerb: (host, space, verb, identity) =>
    runServedLifecycleVerb(
      host,
      space,
      verb as ServedLifecycleVerbDescriptor,
      identity,
    ),
  moduleByteCache: new ProcessModuleByteCache(),
});

const directory = Deno.env.get("HEAP_PROBE_DIR");
if (directory !== undefined) {
  const request = `${directory}/snap.req`;
  const gc = (globalThis as { gc?: () => void }).gc;
  const snapshot = async () => {
    let out: string;
    try {
      out = (await Deno.readTextFile(request)).trim();
    } catch {
      return;
    }
    await Deno.remove(request);
    gc?.();
    const heapUsed = Deno.memoryUsage().heapUsed;
    v8.writeHeapSnapshot(out);
    await Deno.writeTextFile(`${out}.done`, String(heapUsed));
  };
  (async () => {
    for await (const event of Deno.watchFs(directory)) {
      if (event.paths.includes(request)) await snapshot();
    }
  })();
}
