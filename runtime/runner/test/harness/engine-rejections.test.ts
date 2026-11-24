import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ProgramResolver, Source } from "@commonfabric/js-compiler";

import { isDeterministicCompileFailure } from "../../src/harness/compile-failure.ts";
import type { ModuleCompiler } from "../../src/harness/module-compile.ts";
import {
  Engine,
  InMemoryProgram,
  Runtime,
  type RuntimeProgram,
  signer,
  StorageManager,
} from "../engine-test-support.ts";

/** A compiler that emits nothing for any program. */
const EMITS_NOTHING: ModuleCompiler = {
  compile: () => Promise.resolve(new Map()),
};

const ENTRY: RuntimeProgram = {
  main: "/main.ts",
  files: [{ name: "/main.ts", contents: "export default 1;" }],
};

/**
 * A resolver over `modules`, with `/main.ts` as its entry, that counts the
 * sources it is asked for by name. `contents` overrides what a name reads, by
 * how many times it was read before.
 */
function countingResolver(
  modules: Record<string, string>,
  contents: (name: string, readsBefore: number) => string | undefined = () =>
    undefined,
): { resolver: ProgramResolver; reads: Map<string, number> } {
  const inner = new InMemoryProgram("/main.ts", modules);
  const reads = new Map<string, number>();
  return {
    reads,
    resolver: {
      main: () => inner.main(),
      resolveSource: async (name) => {
        const readsBefore = reads.get(name) ?? 0;
        reads.set(name, readsBefore + 1);
        const source = await inner.resolveSource(name);
        const replaced = contents(name, readsBefore);
        return source === undefined || replaced === undefined
          ? source
          : { name, contents: replaced };
      },
    },
  };
}

/** The settled outcome of `work`, so a rejection can be compared as a value. */
async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("The work was expected to fail, and it succeeded");
}

describe("Engine", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtimes: Runtime[];

  /** The engine of a fresh runtime, compiling on `moduleCompiler` if given. */
  function engine(moduleCompiler?: ModuleCompiler): Engine {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(moduleCompiler === undefined ? {} : { moduleCompiler }),
    });
    runtimes.push(runtime);
    return runtime.harness as Engine;
  }

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager.close();
  });

  describe("instance members", () => {
    describe("resolve()", () => {
      it("throws for a source root the resolver cannot produce", async () => {
        const { resolver } = countingResolver({ "/main.ts": "export {};" });

        await expect(
          engine().resolve(resolver, { sourceRoots: ["/absent.ts"] }),
        ).rejects.toThrow('Source root "/absent.ts" could not be resolved.');
      });

      it("reads the entry as the entry alone when a source root names it", async () => {
        const { resolver, reads } = countingResolver({
          "/main.ts": "export default 1;",
          "/main.test.ts": "export default 2;",
        });

        const program = await engine().resolve(resolver, {
          sourceRoots: ["/main.ts", "/main.test.ts"],
        });

        expect(program.files.map((file) => file.name).toSorted()).toEqual([
          "/main.test.ts",
          "/main.ts",
        ]);
        expect(reads.get("/main.test.ts")).toBe(1);
        expect(reads.get("/main.ts")).toBeUndefined();
      });

      it("throws for source roots whose closures read one file with different contents", async () => {
        const { resolver } = countingResolver(
          {
            "/main.ts": "import './shared.ts';\nexport default 1;",
            "/main.test.ts": "import './shared.ts';\nexport default 2;",
            "/shared.ts": "export const read = 0;",
          },
          (name, readsBefore) =>
            name === "/shared.ts"
              ? `export const read = ${readsBefore};`
              : undefined,
        );

        await expect(
          engine().resolve(resolver, { sourceRoots: ["/main.test.ts"] }),
        ).rejects.toThrow(
          'Resolved source roots produced conflicting files named "/shared.ts".',
        );
      });
    });

    describe("compileToRecordGraph()", () => {
      it("throws for a file under the reserved `/~cf/` namespace", async () => {
        const program: RuntimeProgram = {
          main: "/main.ts",
          files: [
            ...ENTRY.files,
            { name: "/~cf/mount/main.ts", contents: "export default 2;" },
          ],
        };

        await expect(engine().compileToRecordGraph(program)).rejects.toThrow(
          "/~cf/ is a reserved namespace",
        );
        expect(
          typeof (await engine().compileToRecordGraph(ENTRY)).entryIdentity,
        )
          .toBe("string");
      });

      it("throws for an entry that is a declaration file, which emits no module", async () => {
        const program: RuntimeProgram = {
          main: "/types.d.ts",
          files: [{
            name: "/types.d.ts",
            contents: "export declare const x: number;",
          }],
        };

        await expect(engine().compileToRecordGraph(program)).rejects.toThrow(
          "ESM compile produced no record for the program entry",
        );
      });

      it("throws for a compiler that emits no body for an authored module", async () => {
        const failure = await rejectionOf(() =>
          engine(EMITS_NOTHING).compileToRecordGraph(ENTRY)
        );

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toMatch(
          /^Error: ESM compile produced no module body for '\/[^/]+\/main\.ts'$/,
        );
      });
    });

    describe("compileResolvedToRecordGraph()", () => {
      it("throws a deterministic failure for a compiler that emits no body for a stored module", async () => {
        const stored: Source[] = ENTRY.files;

        const failure = await rejectionOf(() =>
          engine(EMITS_NOTHING).compileResolvedToRecordGraph(stored, "/main.ts")
        );

        expect(String(failure)).toBe(
          "Error: Recompile from source produced no body for '/main.ts'",
        );
        expect(isDeterministicCompileFailure(failure)).toBe(true);
        expect(
          typeof (await engine().compileResolvedToRecordGraph(
            stored,
            "/main.ts",
          )).entryIdentity,
        ).toBe("string");
      });
    });

    describe("compileAndEvaluateModules()", () => {
      it("registers an exported builder by its implementation only where that is a function", async () => {
        // A built-in node factory such as `fetchJson` names the built-in its
        // node runs, so its implementation is a string.

        const compiling = engine();
        const { exportsByIdentity } = await compiling.compileAndEvaluateModules(
          {
            main: "/main.ts",
            files: [{
              name: "/main.ts",
              contents: [
                "import { fetchJson, lift } from 'commonfabric';",
                "export const fetcher = fetchJson;",
                "export const double = lift((x: number) => x * 2);",
                "export default 1;",
              ].join("\n"),
            }],
          },
        );
        const [identity] = [...(exportsByIdentity?.keys() ?? [])];

        expect(typeof compiling.getVerifiedImplementation(identity!, "double"))
          .toBe("function");
        expect(compiling.getVerifiedImplementation(identity!, "fetcher"))
          .toBeUndefined();
      });
    });

    describe("evaluateCachedModules()", () => {
      it("throws for a closure that does not hold its entry module", async () => {
        const compiled = await engine().compileToRecordGraph(ENTRY);
        const modules = compiled.modules.map((module) => ({
          identity: module.identity,
          filename: module.filename,
          code: module.js,
          imports: module.imports,
        }));
        const absent = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

        await expect(engine().evaluateCachedModules(modules, absent)).rejects
          .toThrow(
            `Module graph entry specifier is not present: cf:module/${absent}`,
          );
        const { main } = await engine().evaluateCachedModules(
          modules,
          compiled.entryIdentity,
        );
        expect(main?.default).toBe(1);
      });
    });
  });
});
