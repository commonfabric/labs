import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Source } from "@commonfabric/js-compiler";
import { isDeterministicCompileFailure } from "../src/harness/compile-failure.ts";
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
});
