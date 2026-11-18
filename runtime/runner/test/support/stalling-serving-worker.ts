/**
 * A serving worker's entry module whose verb named `stall` stops the worker's
 * thread for good, inside its host's wave cycle and holding the space's lease,
 * as an action that never returns does. Its verb named `compile` compiles a
 * program with the compiler already loaded, and returns how many times a timer
 * on the worker's thread fired during that compile. Its verb named `evaluate`
 * returns the same count for the evaluation of a two-module graph, by the serving
 * runtime's engine and by an engine with the default for a runtime that does not
 * serve. Every other verb runs and returns `served`.
 */

import type { Source } from "@commonfabric/js-compiler";
import type { PortLike } from "../../src/executor/serving-port-protocol.ts";
import { serveFromPort } from "../../src/executor/serving-worker-main.ts";
import { Engine } from "../../src/harness/engine.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
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

const TWO_MODULES: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { double } from './double.ts';",
        "export default pattern<{ value: number }>(({ value }) => {",
        "  return { result: double(value) };",
        "});",
      ].join("\n"),
    },
    {
      name: "/double.ts",
      contents: [
        "import { lift } from 'commonfabric';",
        "export const double = lift<number>((x) => x * 2);",
      ].join("\n"),
    },
  ],
};

/**
 * Helper for the `evaluate` verb: each module holds the thread for longer than
 * the budget between a yield's trips through the timer queue, as a large one
 * does, so the count is zero only for a graph that evaluates as one stretch.
 */
async function timerFiresDuringEvaluation(engine: Engine): Promise<number> {
  const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
    TWO_MODULES,
  );
  for (const record of graph.records.values()) {
    const execute = record.execute;
    record.execute = (...args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      execute(...args);
    };
  }
  let fires = 0;
  const timer = setInterval(() => fires += 1, 0);
  try {
    await engine.evaluateRecordGraph(id, graph, mainSpecifier, TWO_MODULES);
    return fires;
  } finally {
    clearInterval(timer);
  }
}

serveFromPort(self as unknown as PortLike, {
  runLifecycleVerb: async (host, space, verb) => {
    const receipt = await host.runLifecycleVerb(space, {
      name: verb.name,
      run: async (runtime): Promise<string | number | number[]> => {
        if (verb.name === "stall") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        if (verb.name === "compile") return timerFiresDuringCompile(runtime);
        if (verb.name === "evaluate") {
          return [
            await timerFiresDuringEvaluation(runtime.harness),
            await timerFiresDuringEvaluation(new Engine(runtime)),
          ];
        }
        return "served";
      },
    });
    return { receipt, timings: [] };
  },
});
