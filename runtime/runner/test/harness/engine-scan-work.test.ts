import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import type { Source } from "@commonfabric/js-compiler";

import * as compiler from "../../src/harness/compiler-stack.ts";
import { ensureCompilerStack } from "../../src/harness/deferred-compiler-stack.ts";
import type { Engine } from "../../src/harness/engine.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  DATA_FILE_SPECIFIER,
  type SourcePackageIdentity,
} from "../../src/sandbox/module-record-compiler.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

// This file's isolated runtime installs the counting loader; the engine's
// identity tests use the real compiler stack in their own files. All three
// scans the stack offers are counted, so a step that parses a module through
// any of them shows up here. So is each resolution of a program, which parses
// every module it reaches on its own, and every parse the runner makes through
// the stack's `typescript`, which is how record assembly reads a compiled body.
const scans = spy(compiler.scanModuleDeclarations);
const importScans = spy(compiler.collectImportSpecifiers);
const dataFileScans = spy(compiler.collectDataFileNames);
const resolves = spy(compiler.TypeScriptCompiler.prototype.resolveProgram);
const parses = spy(compiler.ts.createSourceFile);

/** The stack's compiler, with each program resolution recorded in `resolves`. */
class CountingCompiler extends compiler.TypeScriptCompiler {
  override resolveProgram(
    ...args: Parameters<compiler.TypeScriptCompiler["resolveProgram"]>
  ): ReturnType<compiler.TypeScriptCompiler["resolveProgram"]> {
    return resolves.call(this, ...args);
  }
}

await ensureCompilerStack(() =>
  Promise.resolve({
    ...compiler,
    ts: new Proxy(compiler.ts, {
      get: (target, key, receiver) =>
        key === "createSourceFile"
          ? parses
          : Reflect.get(target, key, receiver),
    }),
    scanModuleDeclarations: scans,
    collectImportSpecifiers: importScans,
    collectDataFileNames: dataFileScans,
    TypeScriptCompiler: CountingCompiler,
  })
);

const signer = await Identity.fromPassphrase("engine scan work");

const MAIN = [
  'import { dataFile } from "commonfabric";',
  'import { words } from "./words.ts";',
  'export default () => words(dataFile("./words.txt"));',
].join("\n");
const WORDS = "export const words = (text: string) => text.split(`\\n`);\n";
const DATA = 'import "./not-a-module.ts";\nalpha\nbeta\n';

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    { name: "/words.ts", contents: WORDS },
    { name: "/words.txt", contents: DATA },
  ],
  dataFiles: ["/words.txt"],
};

const FRAME = [
  'import { dataFile } from "commonfabric";',
  'export const html = () => dataFile("./frame.html");',
].join("\n");
const FRAME_DATA = "<p>frame</p>\n";

/** A program whose data file is read by a module the entry imports. */
const CHILD_READER: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: 'export { html } from "./frame.ts";\n' },
    { name: "/frame.ts", contents: FRAME },
    { name: "/frame.html", contents: FRAME_DATA },
  ],
  dataFiles: ["/frame.html"],
};

/** Runs `work` and returns the source text of every module it scanned. */
async function scannedDuring(work: () => Promise<unknown>): Promise<string[]> {
  const starts = [scans, importScans, dataFileScans].map((s) => s.calls.length);
  await work();
  return [scans, importScans, dataFileScans].flatMap((s, i) =>
    s.calls.slice(starts[i]).map((call) => call.args[0].contents)
  );
}

/**
 * Runs `work` and returns the text of every parse it made through the
 * stack's `typescript`.
 */
async function parsedDuring(work: () => Promise<unknown>): Promise<string[]> {
  const start = parses.calls.length;
  await work();
  return parses.calls.slice(start).map((call) => call.args[1]);
}

/**
 * What a cold load reads back from a compiled program's stored documents: each
 * module's authored source, and the source-package edges each module owns.
 */
function storedClosureOf(
  compiled: Awaited<ReturnType<Engine["compileToRecordGraph"]>>,
): { files: Source[]; sourcePackages: SourcePackageIdentity[] } {
  const filenameOf = new Map(
    compiled.modules.map((module) => [module.identity, module.filename]),
  );
  const sourcePackages = compiled.modules.map((module) => ({
    ownerPath: module.filename,
    rootPaths: [],
    dataPaths: module.imports
      .filter((edge) => edge.specifier.startsWith(DATA_FILE_SPECIFIER))
      .map((edge) => filenameOf.get(edge.targetIdentity)!),
  })).filter((owner) => owner.dataPaths.length > 0);
  return {
    files: compiled.modules.map((module) => ({
      name: module.filename,
      contents: module.source,
    })),
    sourcePackages,
  };
}

describe("engine", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("parses each authored module once on a cold compile and on a cache hit", async () => {
    let first: Awaited<ReturnType<Engine["compileToRecordGraph"]>>;
    const cold = await scannedDuring(async () => {
      first = await engine.compileToRecordGraph(PROGRAM);
    });
    const cached = new Map(
      first!.modules.map((module) => [module.identity, { js: module.js }]),
    );
    let entryIdentity = "";
    const hit = await scannedDuring(async () => {
      ({ entryIdentity } = await engine.compileToRecordGraph(PROGRAM, {
        precompiledModulesFor: () => Promise.resolve(cached),
      }));
    });

    expect(entryIdentity).toBe(first!.entryIdentity);
    for (const scanned of [cold, hit]) {
      expect(scanned.filter((text) => text === MAIN)).toHaveLength(1);
      expect(scanned.filter((text) => text === WORDS)).toHaveLength(1);
      expect(scanned).not.toContain(DATA);
    }
  });

  it("parses no compiled body on a cache hit whose artifacts list their imports", async () => {
    const first = await engine.compileToRecordGraph(PROGRAM);
    const code = first.modules.filter((module) => !module.isData);
    const bodies = code.map((module) => module.js);
    const bodiesOnly = new Map(
      code.map((module) => [module.identity, { js: module.js }]),
    );
    const listed = new Map(
      code.map((module) => [
        module.identity,
        { js: module.js, importSpecs: module.importSpecs },
      ]),
    );

    // A body with no list is parsed for its imports, which shows the count
    // sees record assembly at all.
    const unlisted = await parsedDuring(() =>
      engine.compileToRecordGraph(PROGRAM, {
        precompiledModulesFor: () => Promise.resolve(bodiesOnly),
      })
    );
    let hit: Awaited<ReturnType<Engine["compileToRecordGraph"]>>;
    const parsed = await parsedDuring(async () => {
      hit = await engine.compileToRecordGraph(PROGRAM, {
        precompiledModulesFor: () => Promise.resolve(listed),
      });
    });

    expect(unlisted.filter((text) => bodies.includes(text)).sort()).toEqual(
      [...bodies].sort(),
    );
    expect(parsed.filter((text) => bodies.includes(text))).toEqual([]);
    for (const [specifier, record] of first.graph.records) {
      const { imports, exports } = hit!.graph.records.get(specifier)!;
      expect({ imports, exports }).toEqual({
        imports: record.imports,
        exports: record.exports,
      });
    }
  });

  it("resolves a stored closure once when a child module owns a data file", async () => {
    const compiled = await engine.compileToRecordGraph(CHILD_READER);
    const { files, sourcePackages } = storedClosureOf(compiled);
    expect(sourcePackages.map((owner) => owner.ownerPath)).toEqual([
      "/frame.ts",
    ]);

    const start = resolves.calls.length;
    let entryIdentity = "";
    const scanned = await scannedDuring(async () => {
      ({ entryIdentity } = await engine.compileResolvedToRecordGraph(
        files,
        CHILD_READER.main,
        { sourcePackages },
      ));
    });

    expect(entryIdentity).toBe(compiled.entryIdentity);
    // The entry's own imports reach the reader, so resolution starts from the
    // entry alone.
    expect(resolves.calls.length - start).toBe(1);
    expect(scanned.filter((text) => text === FRAME)).toHaveLength(1);
    expect(scanned).not.toContain(FRAME_DATA);
  });
});
