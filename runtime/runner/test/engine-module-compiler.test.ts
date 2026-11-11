import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  CompiledTypeScriptModule,
  Source,
} from "@commonfabric/js-compiler";

import type {
  ModuleCompiler,
  ModuleCompileRequest,
} from "../src/harness/module-compile.ts";
import { ModuleCompileWorker } from "../src/harness/module-compile-worker.ts";
import { PatternCoverageCollector } from "../src/pattern-coverage.ts";
import {
  Runtime,
  type RuntimeProgram,
  signer,
  StorageManager,
} from "./engine-test-support.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  return { result: value };",
      "});",
    ].join("\n"),
  }],
};

/** A compile worker that records the requests it is sent. */
class RecordingCompiler implements ModuleCompiler {
  readonly #worker = new ModuleCompileWorker();
  readonly #requests: ModuleCompileRequest[] = [];

  /** The requests this compiler was sent, in order. */
  get requests(): readonly ModuleCompileRequest[] {
    return this.#requests;
  }

  /** Records `request` and runs it in a compile worker. */
  compile(
    request: ModuleCompileRequest,
  ): Promise<Map<string, CompiledTypeScriptModule>> {
    this.#requests.push(request);
    return this.#worker.compile(request);
  }

  /** Ends the compile worker. */
  close(): void {
    this.#worker.close();
  }
}

describe("Engine", () => {
  // Each case runs on a runtime whose `moduleCompiler` records what it is
  // sent, so a case reads where a compile's emit step ran.

  let compiler: RecordingCompiler;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    compiler = new RecordingCompiler();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      moduleCompiler: compiler,
    });
  });

  afterEach(async () => {
    compiler.close();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("instance members", () => {
    describe("compileToRecordGraph()", () => {
      it("runs the type-check, transform and emit step on the runtime's `moduleCompiler`", async () => {
        const compiled = await runtime.harness.compileToRecordGraph(PROGRAM);

        expect(compiler.requests.length).toBe(1);
        expect(compiler.requests[0]!.storedSource).toBe(false);
        expect(compiled.modules.some((module) => module.js.length > 0)).toBe(
          true,
        );
      });

      it("compiles in this realm a compile that collects pattern coverage", async () => {
        const coverage = new PatternCoverageCollector();
        const compiled = await runtime.harness.compileToRecordGraph(PROGRAM, {
          patternCoverage: coverage,
        });
        await runtime.harness.evaluateRecordGraph(
          compiled.id,
          compiled.graph,
          compiled.mainSpecifier,
          PROGRAM,
        );

        expect(compiler.requests.length).toBe(0);
        expect(coverage.report().totals.coveredRuntimeLines).toBeGreaterThan(
          0,
        );
      });

      it("compiles in this realm a compile that asks for its transformed program", async () => {
        let transformed = false;
        await runtime.harness.compileToRecordGraph(PROGRAM, {
          getTransformedProgram: () => {
            transformed = true;
          },
        });

        expect(transformed).toBe(true);
        expect(compiler.requests.length).toBe(0);
      });
    });

    describe("compileResolvedToRecordGraph()", () => {
      it("runs the recompile from stored source on the runtime's `moduleCompiler`, as stored source", async () => {
        const first = await runtime.harness.compileToRecordGraph(PROGRAM);
        const stored: Source[] = first.modules.map((module) => ({
          name: module.filename,
          contents: module.source,
        }));
        const entry =
          first.modules.find((module) =>
            module.identity === first.entryIdentity
          )!
            .filename;

        await runtime.harness.compileResolvedToRecordGraph(stored, entry);

        expect(compiler.requests.length).toBe(2);
        expect(compiler.requests[1]!.storedSource).toBe(true);
      });
    });
  });
});
