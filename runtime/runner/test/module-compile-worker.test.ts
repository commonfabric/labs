import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Source } from "@commonfabric/js-compiler";
import {
  CompilerError,
  TransformerError,
} from "@commonfabric/js-compiler/errors";

import {
  isDeterministicCompileFailure,
  markDeterministicCompileFailure,
} from "../src/harness/compile-failure.ts";
import type { ModuleCompileRequest } from "../src/harness/module-compile.ts";
import {
  COMPILE_WORKER_LOGGER_PREFIX,
  ModuleCompileWorker,
} from "../src/harness/module-compile-worker.ts";
import type { CacheableModule } from "../src/harness/types.ts";
import {
  Runtime,
  type RuntimeProgram,
  signer,
  StorageManager,
} from "./engine-test-support.ts";

// A two-module program, so a compile emits more than one body and source map.
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

const TYPE_ERROR_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const label: string = 1;",
      "  return { result: value, label };",
      "});",
    ].join("\n"),
  }],
};

// A result schema declaring a reserved key `unknown` draws a transformer
// error on an authoring compile.
const TRANSFORMER_ERROR_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      'import { pattern, UI } from "commonfabric";',
      "type Out = { [UI]: unknown; label: string };",
      "export default pattern<{ label: string }, Out>(",
      "  (s) => ({ [UI]: <span>{s.label}</span>, label: s.label }),",
      ");",
    ].join("\n"),
  }],
};

const DYING_WORKER = new URL(
  "./fixtures/compile-worker-that-dies.ts",
  import.meta.url,
);

/** What a compile emitted for each module, compared across two realms. */
function emitted(modules: readonly CacheableModule[]) {
  return modules.map((module) => ({
    identity: module.identity,
    filename: module.filename,
    js: module.js,
    sourceMap: module.sourceMap,
    builderSourceSites: module.builderSourceSites,
    policyManifests: module.policyManifests,
  }));
}

/** The settled outcome of `work`, so a rejection can be compared as a value. */
async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("The compile was expected to fail, and it succeeded");
}

describe("ModuleCompileWorker", () => {
  let worker: ModuleCompileWorker;
  let storageManagers: ReturnType<typeof StorageManager.emulate>[];
  let runtimes: Runtime[];

  /** A runtime whose compiles run on `moduleCompiler`, or here when absent. */
  function runtime(moduleCompiler?: ModuleCompileWorker): Runtime {
    const storageManager = StorageManager.emulate({ as: signer });
    storageManagers.push(storageManager);
    const built = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(moduleCompiler === undefined ? {} : { moduleCompiler }),
    });
    runtimes.push(built);
    return built;
  }

  beforeEach(() => {
    worker = new ModuleCompileWorker();
    storageManagers = [];
    runtimes = [];
  });

  afterEach(async () => {
    worker.close();
    for (const built of runtimes) await built.dispose();
    for (const manager of storageManagers) await manager.close();
  });

  describe("instance members", () => {
    describe("compile()", () => {
      it("emits the modules an in-realm compile of the same program emits", async () => {
        const here = await runtime().harness.compileToRecordGraph(PROGRAM);
        const there = await runtime(worker).harness.compileToRecordGraph(
          PROGRAM,
        );

        expect(there.entryIdentity).toBe(here.entryIdentity);
        expect(emitted(there.modules)).toEqual(emitted(here.modules));
        expect(there.modules.some((module) => module.sourceMap)).toBe(true);
      });

      it("recompiles stored source to the modules an in-realm recompile emits", async () => {
        const first = await runtime().harness.compileToRecordGraph(PROGRAM);
        const stored: Source[] = first.modules.map((module) => ({
          name: module.filename,
          contents: module.source,
        }));
        const entry =
          first.modules.find((module) =>
            module.identity === first.entryIdentity
          )!.filename;

        const here = await runtime().harness.compileResolvedToRecordGraph(
          stored,
          entry,
        );
        const there = await runtime(worker).harness
          .compileResolvedToRecordGraph(stored, entry);

        expect(there.entryIdentity).toBe(here.entryIdentity);
        expect(emitted(there.modules)).toEqual(emitted(here.modules));
      });

      it("rejects with the `CompilerError` an in-realm compile throws", async () => {
        const here = await rejectionOf(() =>
          runtime().harness.compileToRecordGraph(TYPE_ERROR_PROGRAM)
        );
        const there = await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(TYPE_ERROR_PROGRAM)
        );

        expect(here).toBeInstanceOf(CompilerError);
        expect(there).toBeInstanceOf(CompilerError);
        if (
          !(here instanceof CompilerError) || !(there instanceof CompilerError)
        ) return;
        expect(there.message).toBe(here.message);
        expect(there.errors.map((error) => ({ ...error }))).toEqual(
          here.errors.map((error) => ({ ...error })),
        );
        expect(there.errors.length).toBeGreaterThan(0);
      });

      it("rejects with the `TransformerError` an in-realm compile throws", async () => {
        const here = await rejectionOf(() =>
          runtime().harness.compileToRecordGraph(TRANSFORMER_ERROR_PROGRAM)
        );
        const there = await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(
            TRANSFORMER_ERROR_PROGRAM,
          )
        );

        expect(here).toBeInstanceOf(TransformerError);
        expect(there).toBeInstanceOf(TransformerError);
        if (
          !(here instanceof TransformerError) ||
          !(there instanceof TransformerError)
        ) return;
        expect(there.message).toBe(here.message);
        expect(there.diagnostics).toEqual(here.diagnostics);
      });

      it("fails a compile its worker held when the worker dies, as a failure of the place, and compiles the next in a fresh worker", async () => {
        worker = new ModuleCompileWorker(DYING_WORKER);
        const dies = { ...PROGRAM, main: "/dies.tsx" };
        dies.files = [
          { name: "/dies.tsx", contents: PROGRAM.files[0]!.contents },
          PROGRAM.files[1]!,
        ];

        const failure = await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(dies)
        );
        expect(markDeterministicCompileFailure(failure)).toBe(failure);
        expect(isDeterministicCompileFailure(failure)).toBe(false);

        const here = await runtime().harness.compileToRecordGraph(PROGRAM);
        const there = await runtime(worker).harness.compileToRecordGraph(
          PROGRAM,
        );
        expect(emitted(there.modules)).toEqual(emitted(here.modules));
      });

      it("classifies a compile error as deterministic, unlike a dead worker", async () => {
        const failure = await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(TYPE_ERROR_PROGRAM)
        );

        expect(isDeterministicCompileFailure(
          markDeterministicCompileFailure(failure),
        )).toBe(true);
      });

      it("leaves a recompile from stored source that a dying worker held unclassified", async () => {
        // The stored-source recompile is the engine site that classifies
        // its failures for the by-identity negative memo.

        const dies: RuntimeProgram = {
          main: "/dies.tsx",
          files: [
            { name: "/dies.tsx", contents: PROGRAM.files[0]!.contents },
            PROGRAM.files[1]!,
          ],
        };
        const first = await runtime().harness.compileToRecordGraph(dies);
        const stored: Source[] = first.modules.map((module) => ({
          name: module.filename,
          contents: module.source,
        }));
        worker = new ModuleCompileWorker(DYING_WORKER);

        const failure = await rejectionOf(() =>
          runtime(worker).harness.compileResolvedToRecordGraph(
            stored,
            "/dies.tsx",
          )
        );

        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) return;
        expect(failure.message).toMatch(/compile worker failed/);
        expect(isDeterministicCompileFailure(failure)).toBe(false);
      });

      it("classifies a compile error in a recompile from stored source as deterministic", async () => {
        // Stored source is the authored bytes, so the type error below is
        // stored as written.

        const stored: Source[] = TYPE_ERROR_PROGRAM.files.map((file) => ({
          name: file.name,
          contents: file.contents,
        }));

        const failure = await rejectionOf(() =>
          runtime(worker).harness.compileResolvedToRecordGraph(
            stored,
            TYPE_ERROR_PROGRAM.main,
          )
        );

        expect(failure).toBeInstanceOf(CompilerError);
        expect(isDeterministicCompileFailure(failure)).toBe(true);
      });
    });

    describe("timingStats()", () => {
      it("returns no timings before the first compile", async () => {
        expect(await worker.timingStats()).toEqual({});
      });

      it("returns the compiler's phase timings from the worker's realm, under prefixed logger names", async () => {
        await runtime(worker).harness.compileToRecordGraph(PROGRAM);

        const stats = await worker.timingStats();
        const phases = stats[`${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`];
        expect(phases?.["phase/emitFile"]?.count).toBeGreaterThan(0);
        expect(phases?.["phase/createProgram"]?.count).toBeGreaterThan(0);
        for (const name of Object.keys(stats)) {
          expect(name.startsWith(COMPILE_WORKER_LOGGER_PREFIX)).toBe(true);
        }
      });

      it("rejects once the instance is closed", async () => {
        await runtime(worker).harness.compileToRecordGraph(PROGRAM);
        worker.close();

        const failure = await rejectionOf(() => worker.timingStats());
        expect(failure).toBeInstanceOf(Error);
      });
    });

    describe("close()", () => {
      it("fails a compile it still held and every later one, as failures of the place", async () => {
        const request: ModuleCompileRequest = {
          program: {
            main: "/main.ts",
            files: [{ name: "/main.ts", contents: "export const x = 1;" }],
          },
          authoredSources: [],
          mounts: [],
          moduleIdentities: new Map<string, string>(),
          specifierAliases: new Map<string, string>(),
          storedSource: false,
          noCheck: true,
          diagnosticMessages: "typescript",
          instanceNames: false,
        };
        const compiling = rejectionOf(() => worker.compile(request));
        worker.close();

        const held = await compiling;
        const later = await rejectionOf(() => worker.compile(request));
        for (const failure of [held, later]) {
          expect(failure).toBeInstanceOf(Error);
          expect(isDeterministicCompileFailure(
            markDeterministicCompileFailure(failure),
          )).toBe(false);
        }
      });
    });
  });
});
