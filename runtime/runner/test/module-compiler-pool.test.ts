import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ModuleCompileRequest } from "../src/harness/module-compile.ts";
import { COMPILE_WORKER_LOGGER_PREFIX } from "../src/harness/module-compile-worker.ts";
import { ModuleCompilerPool } from "../src/harness/module-compiler-pool.ts";

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

describe("ModuleCompilerPool", () => {
  let started: number;
  let pool: ModuleCompilerPool | undefined;

  /** Starts a real compile worker, counting it. */
  const startWorker = (): Worker => {
    started += 1;
    return new Worker(
      new URL("../src/harness/compile-worker.ts", import.meta.url),
      { type: "module" },
    );
  };

  beforeEach(() => {
    started = 0;
    pool = undefined;
  });

  afterEach(() => {
    pool?.close();
  });

  describe("constructor()", () => {
    it("throws for a size below one", () => {
      expect(() => new ModuleCompilerPool(0)).toThrow(RangeError);
    });

    it("starts no worker until it is asked to compile", () => {
      pool = new ModuleCompilerPool(2, startWorker);

      expect(started).toBe(0);
    });
  });

  describe("instance members", () => {
    describe("compile()", () => {
      it("runs compiles one after another on one worker", async () => {
        pool = new ModuleCompilerPool(3, startWorker);

        await pool.compile(requestFor("/a.ts"));
        await pool.compile(requestFor("/b.ts"));

        expect(started).toBe(1);
      });

      it("runs compiles asked for at once on no more workers than its size", async () => {
        pool = new ModuleCompilerPool(2, startWorker);

        const compiled = await Promise.all(
          ["/a.ts", "/b.ts", "/c.ts", "/d.ts"].map((main) =>
            pool!.compile(requestFor(main))
          ),
        );

        expect(started).toBe(2);
        expect(compiled.map((modules) => modules.size)).toEqual([1, 1, 1, 1]);
      });
    });

    describe("diagnostics()", () => {
      it("names each worker's loggers apart, keeping the first worker's names", async () => {
        pool = new ModuleCompilerPool(2, startWorker);
        await Promise.all([
          pool.compile(requestFor("/a.ts")),
          pool.compile(requestFor("/b.ts")),
        ]);

        const names = Object.keys(pool.diagnostics().timingStats);

        expect(
          names.some((name) => name.startsWith(COMPILE_WORKER_LOGGER_PREFIX)),
        )
          .toBe(true);
        expect(names.some((name) => name.startsWith("compile-worker[1]:")))
          .toBe(true);
      });
    });
  });
});
