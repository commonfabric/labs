import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Source } from "@commonfabric/js-compiler";
import { getTopFrame, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame } from "../src/builder/types.ts";
import { isDeterministicCompileFailure } from "../src/harness/compile-failure.ts";
import type { CompiledModuleGraph } from "../src/sandbox/module-record-compiler.ts";
import {
  Engine,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";

// A two-module program, so the interleaved driver has several steps to yield
// between: the program build, then each module's checks and emit.
const PROGRAM: RuntimeProgram = {
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
 * Count the event-loop turns that run while `work` is pending. A posted
 * message is a macrotask, and its handler posts the next one, so each turn the
 * awaited work yields runs exactly one of them.
 */
async function turnsDuring<T>(
  work: () => Promise<T>,
): Promise<{ result: T; turns: number }> {
  const { port1, port2 } = new MessageChannel();
  let turns = 0;
  port1.onmessage = () => {
    turns++;
    port2.postMessage(null);
  };
  port2.postMessage(null);
  try {
    const result = await work();
    return { result, turns };
  } finally {
    // The work can settle in the microtasks after a message dispatch on any
    // port. Closing this port there while its handler still re-posts never
    // returns in Deno, so the handler goes first.
    port1.onmessage = null;
    port1.close();
    port2.close();
  }
}

describe("Engine", () => {
  describe("interleaveCompile", () => {
    // The stored-source recompile is the one a runtime-version bump runs for
    // every pattern reloaded by identity. Its interleaved driver is what keeps
    // the browser worker's event loop answering during those compiles, and
    // these cases pin it from Deno, where the default is the synchronous
    // driver.

    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let synchronous: Engine;
    let interleaved: Engine;
    let storedSource: Source[];
    let entryFilename: string;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      synchronous = new Engine(runtime, { interleaveCompile: false });
      interleaved = new Engine(runtime, { interleaveCompile: true });
      // The content-addressed source set a `pattern:<identity>` closure
      // stores, which is what the cold path recompiles from.
      const first = await synchronous.compileToRecordGraph(PROGRAM);
      storedSource = first.modules.map((module) => ({
        name: module.filename,
        contents: module.source,
      }));
      entryFilename = first.modules.find((module) =>
        module.identity === first.entryIdentity
      )!.filename;
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("recompiles stored source to the same modules with either driver", async () => {
      const sync = await synchronous.compileResolvedToRecordGraph(
        storedSource,
        entryFilename,
      );
      const inter = await interleaved.compileResolvedToRecordGraph(
        storedSource,
        entryFilename,
      );

      expect(inter.entryIdentity).toBe(sync.entryIdentity);
      const bodies = (modules: typeof sync.modules) =>
        modules.map(({ identity, filename, js }) => ({
          identity,
          filename,
          js,
        }))
          .sort((a, b) => a.filename.localeCompare(b.filename));
      expect(bodies(inter.modules)).toEqual(bodies(sync.modules));
    });

    it("runs queued event-loop tasks between the steps of an interleaved cold compile", async () => {
      // The synchronous driver runs the whole compile in one stretch, so a
      // task queued before it waits until the compile is over; the
      // interleaved driver yields a turn after the program build and after
      // each module's steps, so the same task runs in between.
      const sync = await turnsDuring(() =>
        synchronous.compileResolvedToRecordGraph(storedSource, entryFilename)
      );
      const inter = await turnsDuring(() =>
        interleaved.compileResolvedToRecordGraph(storedSource, entryFilename)
      );

      expect(inter.turns - sync.turns).toBeGreaterThanOrEqual(
        PROGRAM.files.length + 1,
      );
    });

    it("gives a due timer a turn during a serving runtime's cold compile, and during no other's in Deno", async () => {
      // A serving runtime's thread also serves other spaces and, in a worker,
      // posts the heartbeat its watchdog listens for, so a stretch as long as a
      // whole program would silence all of it.
      const serving = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        servingPosture: true,
      });
      try {
        const compile = (engine: Engine) =>
          engine.compileResolvedToRecordGraph(storedSource, entryFilename);
        const timerFiredDuring = async (engine: Engine) => {
          // `yieldToEventLoop()` gives timers a turn only once some
          // `performance.now()` has passed since it last did, and this fake
          // clock stands still during a compile unless the test moves it.
          await clock.tick(1_000);
          let fired = false;
          const timer = setTimeout(() => {
            fired = true;
          }, 0);
          await compile(engine);
          clearTimeout(timer);
          return fired;
        };
        // Past the first compile, which loads the compiler and takes turns of
        // its own on either driver.
        await compile(serving.harness);
        await compile(runtime.harness);

        expect(await timerFiredDuring(runtime.harness)).toBe(false);
        expect(await timerFiredDuring(serving.harness)).toBe(true);
      } finally {
        await serving.dispose();
      }
    });

    it("classifies a compile failure as deterministic with either driver", async () => {
      // A failure that is a function of the verified bytes keeps the
      // by-identity negative memo honest; the interleaved driver surfaces it
      // as a rejection rather than a throw, and the classification follows it.
      const illTyped: Source[] = [
        { name: "/main.tsx", contents: 'export const n: number = "text";' },
      ];

      for (const engine of [synchronous, interleaved]) {
        let failure: unknown;
        try {
          await engine.compileResolvedToRecordGraph(illTyped, "/main.tsx");
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(isDeterministicCompileFailure(failure)).toBe(true);
      }
    });
  });

  describe("module-graph evaluation", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let batch: Runtime;
    let serving: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      const options = { apiUrl: new URL(import.meta.url), storageManager };
      batch = new Runtime(options);
      serving = new Runtime({ ...options, servingPosture: true });
    });

    afterEach(async () => {
      await serving?.dispose();
      await batch?.dispose();
      await storageManager?.close();
    });

    /** Runs `visit` as each authored module of `graph` starts to evaluate. */
    const onEvaluate = (graph: CompiledModuleGraph, visit: () => void) => {
      for (const [specifier, record] of graph.records) {
        if (!specifier.startsWith("cf:module/")) continue;
        const execute = record.execute;
        record.execute = (...args) => {
          visit();
          execute(...args);
        };
      }
    };

    const evaluate = async (
      engine: Engine,
      program: RuntimeProgram,
      prepare: (graph: CompiledModuleGraph) => void,
    ) => {
      const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
        program,
      );
      prepare(graph);
      return () =>
        engine.evaluateRecordGraph(id, graph, mainSpecifier, program);
    };

    it("yields with no frame of the evaluation on the stack", async () => {
      // Code that runs during a yield reads the same root stack the evaluation
      // pushed onto. A frame left there would hand its runtime to that code,
      // and admit that code's builder calls as module-scope mints. A message a
      // module posts runs in the yield after that module.
      const { port1, port2 } = new MessageChannel();
      const seenDuringYields: (Frame | undefined)[] = [];
      port1.onmessage = () => seenDuringYields.push(getTopFrame());
      const run = await evaluate(
        serving.harness,
        PROGRAM,
        (graph) => onEvaluate(graph, () => port2.postMessage(null)),
      );
      const before = getTopFrame();
      try {
        await run();
      } finally {
        port1.close();
        port2.close();
      }

      expect(seenDuringYields.length).toBeGreaterThan(0);
      expect(seenDuringYields.every((frame) => frame === before)).toBe(true);
      expect(getTopFrame()).toBe(before);
    });

    it("evaluates each graph under one frame of its own runtime while other work interleaves", async () => {
      const other = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        servingPosture: true,
      });
      try {
        const events: string[] = [];
        const framesOf = new Map<string, (Frame | undefined)[]>([
          ["serving", []],
          ["other", []],
        ]);
        const sample = (name: string) => (graph: CompiledModuleGraph) =>
          onEvaluate(graph, () => {
            events.push(name);
            framesOf.get(name)!.push(getTopFrame());
          });
        const runServing = await evaluate(
          serving.harness,
          PROGRAM,
          sample("serving"),
        );
        const runOther = await evaluate(
          other.harness,
          PROGRAM,
          sample("other"),
        );

        // An action that awaits leaves its frame on the stack, and a module
        // evaluated then must not take that action's space or transaction.
        // The message is queued ahead of the first yield, so it runs during it.
        const { port1, port2 } = new MessageChannel();
        const suspended: Frame[] = [];
        port1.onmessage = () => {
          suspended.push(pushFrame({ space: "did:key:suspended-action" }));
        };
        port2.postMessage(null);
        try {
          await Promise.all([runServing(), runOther()]);
        } finally {
          port1.close();
          port2.close();
          suspended.forEach(popFrame);
        }

        expect(suspended.length).toBe(1);
        // The second graph started before the first finished.
        expect(events.indexOf("other")).toBeLessThan(
          events.lastIndexOf("serving"),
        );
        for (
          const [name, runtime] of [
            ["serving", serving],
            ["other", other],
          ] as const
        ) {
          const frames = framesOf.get(name)!;
          expect(frames.length).toBe(PROGRAM.files.length);
          expect(new Set(frames).size).toBe(1);
          expect(frames[0]?.moduleEvaluation).toBe(true);
          expect(frames[0]?.runtime).toBe(runtime);
          expect(frames[0]?.space).toBeUndefined();
          expect(frames[0]?.tx).toBeUndefined();
        }
      } finally {
        await other.dispose();
      }
    });

    it("finishes evaluating a graph whose runtime is disposed during a yield", async () => {
      // A parked space's runtime can be disposed while a load is under way, and
      // the load's caller is left waiting on this evaluation.
      const other = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        servingPosture: true,
      });
      const { port1, port2 } = new MessageChannel();
      let disposed: Promise<void> | undefined;
      port1.onmessage = () => {
        disposed ??= other.dispose();
      };
      const run = await evaluate(
        other.harness,
        PROGRAM,
        (graph) => onEvaluate(graph, () => port2.postMessage(null)),
      );
      try {
        const { main } = await run();
        expect(main).toBeDefined();
      } finally {
        port1.close();
        port2.close();
        await disposed;
      }

      expect(disposed).toBeDefined();
      expect(getTopFrame()?.moduleEvaluation).toBeUndefined();
    });

    it("evaluates modules dependencies first, in import order, with or without yields", async () => {
      // main -> left, right; left -> shared, right -> shared.
      const diamond: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { left } from './left.ts';",
              "import { right } from './right.ts';",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  return { result: left(right(value)) };",
              "});",
            ].join("\n"),
          },
          {
            name: "/left.ts",
            contents: [
              "import { lift } from 'commonfabric';",
              "import { offset } from './shared.ts';",
              "export const left = lift<number>((x) => x + offset);",
            ].join("\n"),
          },
          {
            name: "/right.ts",
            contents: [
              "import { lift } from 'commonfabric';",
              "import { offset } from './shared.ts';",
              "export const right = lift<number>((x) => x - offset);",
            ].join("\n"),
          },
          { name: "/shared.ts", contents: "export const offset = 1;" },
        ],
      };
      const completionOrderOf = async (engine: Engine) => {
        const order: string[] = [];
        const run = await evaluate(engine, diamond, (graph) => {
          for (const [path, specifier] of graph.specifierByPath) {
            const record = graph.records.get(specifier)!;
            const execute = record.execute;
            record.execute = (...args) => {
              execute(...args);
              order.push(path.slice(path.lastIndexOf("/") + 1));
            };
          }
        });
        await run();
        return order;
      };

      const expected = ["shared.ts", "left.ts", "right.ts", "main.tsx"];
      expect(await completionOrderOf(serving.harness)).toEqual(expected);
      expect(await completionOrderOf(batch.harness)).toEqual(expected);
    });
  });
});
