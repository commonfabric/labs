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

/** Starts a compile worker that dies on a request for `/dies.tsx`. */
function startDyingWorker(): Worker {
  return new Worker(
    new URL("./fixtures/compile-worker-that-dies.ts", import.meta.url),
    { type: "module" },
  );
}

/** Starts a compile worker that compiles nothing and misanswers on cue. */
function startMisansweringWorker(): Worker {
  return new Worker(
    new URL("./fixtures/compile-worker-that-misanswers.ts", import.meta.url),
    { type: "module" },
  );
}

/** A request to compile a one-module program whose entry is `main`. */
function requestFor(main: string): ModuleCompileRequest {
  return {
    program: {
      main,
      files: [{ name: main, contents: "export const x = 1;" }],
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
}

/**
 * The name and message of `failure` where it is an error marked as a failure
 * of the place a compile ran, and `undefined` otherwise.
 */
function placeFailure(
  failure: unknown,
): { name: string; message: string } | undefined {
  if (
    !(failure instanceof Error) ||
    isDeterministicCompileFailure(markDeterministicCompileFailure(failure))
  ) return undefined;
  return { name: failure.name, message: failure.message };
}

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
        worker = new ModuleCompileWorker(startDyingWorker);
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
        worker = new ModuleCompileWorker(startDyingWorker);

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

    describe("compile() when the worker misbehaves", () => {
      it("fails a compile whose worker cannot be started, as a failure of the place, and starts one for the next", async () => {
        let starts = 0;
        worker = new ModuleCompileWorker(() => {
          starts++;
          if (starts === 1) throw new RangeError("No thread to spare");
          if (starts === 2) throw "No thread to spare either";
          return startMisansweringWorker();
        });

        const failures = [
          await rejectionOf(() => worker.compile(requestFor("/main.ts"))),
          await rejectionOf(() => worker.compile(requestFor("/main.ts"))),
        ];

        expect(failures.map(placeFailure)).toEqual([
          { name: "RangeError", message: "No thread to spare" },
          { name: "Error", message: "No thread to spare either" },
        ]);
        expect(await worker.compile(requestFor("/main.ts"))).toEqual(new Map());
        expect(starts).toBe(3);
      });

      it("fails what its worker held, as a failure of the place, when the worker sends a message that cannot be read, and compiles the next in a fresh worker", async () => {
        const started: Worker[] = [];
        const firstStart = Promise.withResolvers<Worker>();
        worker = new ModuleCompileWorker(() => {
          const fresh = startMisansweringWorker();
          started.push(fresh);
          firstStart.resolve(started[0]!);
          return fresh;
        });

        const compiling = rejectionOf(() =>
          worker.compile(requestFor("/main.ts"))
        );
        (await firstStart.promise).dispatchEvent(
          new MessageEvent("messageerror"),
        );

        expect(placeFailure(await compiling)).toEqual({
          name: "Error",
          message: "The compile worker sent a message that could not be read",
        });
        expect(await worker.compile(requestFor("/main.ts"))).toEqual(new Map());
        expect(started.length).toBe(2);
      });

      it("fails what its worker held, as a failure of the place, when the worker sends an answer that does not decode", async () => {
        worker = new ModuleCompileWorker(startMisansweringWorker);

        const garbled = rejectionOf(() =>
          worker.compile(requestFor("/garbled.ts"))
        );
        const held = rejectionOf(() => worker.compile(requestFor("/main.ts")));

        const failure = await garbled;
        expect(placeFailure(failure)).toEqual({
          name: "Error",
          message:
            "The compile worker protocol carried modules that are not a list",
        });
        expect(await held).toBe(failure);
        expect(await worker.compile(requestFor("/main.ts"))).toEqual(new Map());
      });

      it("fails what its worker held, as a failure of the place, when the worker answers a request it was not sent", async () => {
        worker = new ModuleCompileWorker(startMisansweringWorker);

        const failure = await rejectionOf(() =>
          worker.compile(requestFor("/stranger.ts"))
        );

        expect(placeFailure(failure)).toEqual({
          name: "Error",
          message:
            "The compile worker answered request 1000, which it does not hold",
        });
        expect(await worker.compile(requestFor("/main.ts"))).toEqual(new Map());
      });

      it("fails a request that cannot be sent, alone and as a failure of the place, whether or not the worker was ready", async () => {
        worker = new ModuleCompileWorker(startMisansweringWorker);
        const sendable = requestFor("/main.ts");
        const unsendable = {
          ...sendable,
          program: {
            ...sendable.program,
            files: [{
              ...sendable.program.files[0]!,
              describe: () => "a function, which no structured clone carries",
            }],
          },
        };

        const queued = rejectionOf(() => worker.compile(unsendable));
        const sent = worker.compile(sendable);

        expect(placeFailure(await queued)?.name).toBe("DataCloneError");
        expect(await sent).toEqual(new Map());
        expect(
          placeFailure(await rejectionOf(() => worker.compile(unsendable)))
            ?.name,
        ).toBe("DataCloneError");
        expect(await worker.compile(sendable)).toEqual(new Map());
      });
    });

    describe("diagnostics()", () => {
      it("returns none before the first compile", () => {
        expect(worker.diagnostics()).toEqual({
          timingStats: {},
          loggerCounts: {},
        });
      });

      it("returns the worker realm's phase timings and log counts after a compile, under prefixed logger names", async () => {
        await runtime(worker).harness.compileToRecordGraph(PROGRAM);

        const { timingStats, loggerCounts } = worker.diagnostics();
        const phases =
          timingStats[`${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`];
        expect(phases?.["phase/emitFile"]?.count).toBeGreaterThan(0);
        expect(phases?.["phase/createProgram"]?.count).toBeGreaterThan(0);
        expect(
          Object.values(loggerCounts).some((byKey) =>
            Object.values(byKey).some((counts) => counts.total > 0)
          ),
        ).toBe(true);
        for (
          const name of [
            ...Object.keys(timingStats),
            ...Object.keys(loggerCounts),
          ]
        ) {
          expect(name.startsWith(COMPILE_WORKER_LOGGER_PREFIX)).toBe(true);
        }
      });

      it("puts the worker's timestamps on this realm's clock", async () => {
        // A slow timing records when it ended on both clocks; moved onto
        // this realm's, its `at` counts from this realm's time origin to the
        // same instant its `epochMs` names.

        await runtime(worker).harness.compileToRecordGraph(PROGRAM);

        const slowest = worker.diagnostics().timingStats[
          `${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`
        ]?.["phase/emitFile"]?.slowest ?? [];
        expect(slowest.length).toBeGreaterThan(0);
        for (const slow of slowest) {
          expect(
            Math.abs(performance.timeOrigin + slow.at - slow.epochMs),
          ).toBeLessThan(50);
        }
      });

      it("takes a snapshot from a compile that failed as well", async () => {
        await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(TYPE_ERROR_PROGRAM)
        );

        expect(
          worker.diagnostics().timingStats[
            `${COMPILE_WORKER_LOGGER_PREFIX}js-compiler`
          ]?.["phase/createProgram"]?.count,
        ).toBeGreaterThan(0);
      });

      it("keeps the latest diagnostics after its worker dies", async () => {
        worker = new ModuleCompileWorker(startDyingWorker);
        await runtime(worker).harness.compileToRecordGraph(PROGRAM);
        const latest = worker.diagnostics();
        const dies: RuntimeProgram = {
          main: "/dies.tsx",
          files: [
            { name: "/dies.tsx", contents: PROGRAM.files[0]!.contents },
            PROGRAM.files[1]!,
          ],
        };

        await rejectionOf(() =>
          runtime(worker).harness.compileToRecordGraph(dies)
        );
        expect(worker.diagnostics()).toBe(latest);
      });

      it("keeps the latest diagnostics once the instance is closed", async () => {
        await runtime(worker).harness.compileToRecordGraph(PROGRAM);
        const latest = worker.diagnostics();
        worker.close();

        expect(worker.diagnostics()).toBe(latest);
      });
    });

    describe("close()", () => {
      it("fails a compile it still held and every later one, as failures of the place", async () => {
        const request = requestFor("/main.ts");
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
