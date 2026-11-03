/**
 * A serving worker's entry module whose verb named `stall` stops the worker's
 * thread for good, inside its host's wave cycle and holding the space's lease,
 * as an action that never returns does. Its verb named `compile` compiles a
 * program with the compiler already loaded, and returns how many times a timer
 * on the worker's thread fired during that compile. Every other verb runs and
 * returns `served`.
 */

import type { Source } from "@commonfabric/js-compiler";
import type { PortLike } from "../../src/executor/serving-port-protocol.ts";
import { serveFromPort } from "../../src/executor/serving-worker-main.ts";
import type { Runtime } from "../../src/runtime.ts";

const SOURCE: Source[] = [{
  name: "/main.tsx",
  contents: [
    "import { pattern } from 'commonfabric';",
    "export default pattern<{ value: number }>(({ value }) => {",
    "  return { result: value };",
    "});",
  ].join("\n"),
}];

/**
 * Helper for the `compile` verb: the compile takes a timer's firings only
 * through the turns it yields, so the count is zero for a compile that runs as
 * one stretch, however long it takes.
 */
async function timerFiresDuringCompile(runtime: Runtime): Promise<number> {
  const compile = () =>
    runtime.harness.compileResolvedToRecordGraph(SOURCE, "/main.tsx");
  await compile();
  let fires = 0;
  const timer = setInterval(() => fires += 1, 0);
  try {
    await compile();
    return fires;
  } finally {
    clearInterval(timer);
  }
}

serveFromPort(self as unknown as PortLike, {
  runLifecycleVerb: async (host, space, verb) => {
    const receipt = await host.runLifecycleVerb(space, {
      name: verb.name,
      run: (runtime) => {
        if (verb.name === "stall") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        if (verb.name === "compile") return timerFiresDuringCompile(runtime);
        return Promise.resolve("served");
      },
    });
    return { receipt, timings: [] };
  },
});
