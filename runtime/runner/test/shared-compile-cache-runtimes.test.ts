/**
 * Runtimes that each open the shared compiled-module cache at one directory,
 * as the serving workers and processes of a host do, compiling the same
 * program: the modules compile once, whichever of them asks first, and a
 * compile that fails is not taken for one that succeeded.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CompilerError } from "@commonfabric/js-compiler/errors";

import { openSharedCompileCache } from "../src/compilation-cache/shared-compile-cache.deno.ts";
import type { ModuleCompiler } from "../src/harness/module-compile.ts";
import { ModuleCompileWorker } from "../src/harness/module-compile-worker.ts";
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
      "import { NAME, pattern } from 'commonfabric';",
      "export default pattern(() => ({ [NAME]: 'shared' }));",
    ].join("\n"),
  }],
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

describe("runtimes on one shared compiled-module cache", () => {
  let dir: string;
  let worker: ModuleCompileWorker;
  let compiles: number;
  let compiler: ModuleCompiler;
  let storageManagers: ReturnType<typeof StorageManager.emulate>[];
  let runtimes: Runtime[];

  /**
   * A runtime with a shared cache of its own over `dir`, as a serving worker
   * or another process has, compiling on the counted compiler.
   */
  function runtimeOnSharedCache(): Runtime {
    const storageManager = StorageManager.emulate({ as: signer });
    storageManagers.push(storageManager);
    const { moduleByteCache, compileClaims } = openSharedCompileCache(dir);
    const built = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      moduleByteCache,
      compileTurns: compileClaims,
      moduleCompiler: compiler,
    });
    runtimes.push(built);
    return built;
  }

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "shared-compile-runtimes-" });
    worker = new ModuleCompileWorker();
    compiles = 0;
    compiler = {
      compile(request) {
        compiles += 1;
        return worker.compile(request);
      },
    };
    storageManagers = [];
    runtimes = [];
  });

  afterEach(async () => {
    worker.close();
    for (const built of runtimes) await built.dispose();
    for (const manager of storageManagers) await manager.close();
    await Deno.remove(dir, { recursive: true });
  });

  it("compiles a program two runtimes ask for at once, once", async () => {
    const first = runtimeOnSharedCache();
    const second = runtimeOnSharedCache();

    const [one, two] = await Promise.all([
      first.patternManager.compileAndRegisterModules(PROGRAM),
      second.patternManager.compileAndRegisterModules(PROGRAM),
    ]);

    expect(compiles).toBe(1);
    expect(
      first.patternManager.getArtifactEntryRef(one.main!["default"] as object),
    ).toBeDefined();
    expect(
      second.patternManager.getArtifactEntryRef(two.main!["default"] as object),
    ).toBeDefined();
  });

  it("serves a program a runtime that has since closed compiled", async () => {
    await runtimeOnSharedCache().patternManager.compileAndRegisterModules(
      PROGRAM,
    );
    const later = runtimeOnSharedCache();

    await later.patternManager.compileAndRegisterModules(PROGRAM);

    expect(compiles).toBe(1);
  });

  it("compiles a program that failed again for the runtime that waited, and fails it alike", async () => {
    const first = runtimeOnSharedCache();
    const second = runtimeOnSharedCache();

    const outcomes = await Promise.allSettled([
      first.patternManager.compileAndRegisterModules(TYPE_ERROR_PROGRAM),
      second.patternManager.compileAndRegisterModules(TYPE_ERROR_PROGRAM),
    ]);

    expect(compiles).toBe(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(CompilerError);
      }
    }
  });
});
