import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import {
  PatternCompileError,
  PatternCompiler,
  PatternCompilerMissingError,
} from "../../src/compiled/compile.deno.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";

/** What the stand-in for the crate's binary prints as the artifacts. */
const EMITTED = JSON.stringify([
  {
    module: "main.tsx",
    patterns: [
      {
        name: "default",
        plan: { patterns: ["sha256:main"] },
        schemas: [],
        unsupported: [],
        code: { modules: [], main: 0, unsupported: [] },
      },
      {
        name: "Other",
        plan: { patterns: ["sha256:other"] },
        schemas: [],
        unsupported: [],
        code: {
          modules: [],
          main: 0,
          unsupported: [{ kind: "a construct", file: "main.tsx", start: 0 }],
        },
      },
    ],
  },
]);

/**
 * A stand-in for the crate's binary: it appends its arguments to the file
 * `calls` beside it and the text of `main.tsx` and of `lib/helper.ts` in
 * its working directory to the file `read`. Where `main.tsx` holds
 * `REFUSED` it prints a diagnostic to the standard error and fails, and
 * otherwise it prints `EMITTED`.
 */
const STAND_IN = `#!/bin/sh
here=$(dirname "$0")
echo "$@" >> "$here/calls"
cat main.tsx lib/helper.ts >> "$here/read" 2>/dev/null
if grep -q REFUSED main.tsx; then
  echo "main.tsx:1:1: error [stand-in] refused" >&2
  exit 1
fi
cat "$here/emitted"
`;

const program = (
  contents: string,
  more: Partial<RuntimeProgram> = {},
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents },
    { name: "/lib/helper.ts", contents: "export const helper = 1;\n" },
  ],
  ...more,
});

describe("PatternCompiler", () => {
  let directory: string;
  let binary: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir();
    binary = join(directory, "stand-in");
    await Deno.writeTextFile(binary, STAND_IN, { mode: 0o755 });
    await Deno.writeTextFile(join(directory, "emitted"), EMITTED);
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  /** The lines of the file `name` beside the stand-in, none where absent. */
  const lines = async (name: string): Promise<string[]> => {
    try {
      return (await Deno.readTextFile(join(directory, name))).split("\n")
        .filter((line) => line.length > 0);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  };

  describe("compile()", () => {
    it("runs the binary on the files of the program, written where it runs", async () => {
      const compiler = new PatternCompiler({ binary });

      await compiler.compile(program("export default 1;"));

      expect(await lines("calls")).toEqual([
        "emit --accepted main.tsx lib/helper.ts",
      ]);
      expect(await lines("read")).toEqual([
        "export default 1;export const helper = 1;",
      ]);
    });

    it("returns the pattern the main file exports as default", async () => {
      const compiler = new PatternCompiler({ binary });

      const compiled = await compiler.compile(program("export default 1;"));

      expect(compiled.main.name).toBe("default");
      expect(compiled.cached).toBe(false);
      expect(compiled.artifacts("sha256:other")?.name).toBe("Other");
      expect(compiled.artifacts("sha256:absent")).toBeUndefined();
    });

    it("returns the pattern the main file exports as default by its name", async () => {
      await Deno.writeTextFile(
        join(directory, "emitted"),
        JSON.stringify([{
          module: "main.tsx",
          patterns: [{
            name: "Named",
            plan: { patterns: ["sha256:named"] },
            schemas: [],
            unsupported: [],
            code: { modules: [], main: 0, unsupported: [] },
          }],
        }]),
      );
      const compiler = new PatternCompiler({ binary });

      const compiled = await compiler.compile(
        program("const Named = 1;\nexport default Named;\n"),
      );

      expect(compiled.main.name).toBe("Named");
    });

    it("rejects where the main file exports no pattern under the name the program gives", async () => {
      const compiler = new PatternCompiler({ binary });

      await expect(
        compiler.compile(program("export default 1;", { mainExport: "No" })),
      ).rejects.toThrow("exports no pattern as `No`");
    });

    it("rejects where the crate wrote no value code for a construct of the pattern", async () => {
      const compiler = new PatternCompiler({ binary });

      const compiling = compiler.compile(
        program("export default 1;", { mainExport: "Other" }),
      );

      await expect(compiling).rejects.toThrow(PatternCompileError);
      await expect(compiling).rejects.toThrow("a construct");
    });

    it("rejects with the diagnostics where the binary refuses the program", async () => {
      const compiler = new PatternCompiler({ binary });

      const compiling = compiler.compile(program("REFUSED"));

      await expect(compiling).rejects.toThrow(PatternCompileError);
      await expect(compiling).rejects.toThrow(
        "main.tsx:1:1: error [stand-in] refused",
      );
    });

    it("rejects with the path where no binary is there", async () => {
      const absent = join(directory, "absent");
      const compiler = new PatternCompiler({ binary: absent });

      const compiling = compiler.compile(program("export default 1;"));

      await expect(compiling).rejects.toThrow(PatternCompilerMissingError);
      await expect(compiling).rejects.toThrow(absent);
    });

    it("rejects with the path where no binary is there and a cache directory is given", async () => {
      const absent = join(directory, "absent");
      const compiler = new PatternCompiler({
        binary: absent,
        cacheDir: join(directory, "cache"),
      });

      await expect(compiler.compile(program("export default 1;")))
        .rejects.toThrow(PatternCompilerMissingError);
    });

    it("rejects a file name that leaves the directory the binary runs in", async () => {
      const compiler = new PatternCompiler({ binary });

      await expect(
        compiler.compile({
          main: "/main.tsx",
          files: [
            { name: "/main.tsx", contents: "export default 1;" },
            { name: "/../outside.ts", contents: "" },
          ],
        }),
      ).rejects.toThrow("Not a file name of a program");
      expect(await lines("calls")).toEqual([]);
    });

    it("runs the binary for each compile where no cache directory is given", async () => {
      const compiler = new PatternCompiler({ binary });

      await compiler.compile(program("export default 1;"));
      await compiler.compile(program("export default 1;"));

      expect((await lines("calls")).length).toBe(2);
    });

    it("runs the binary once for two compiles of one source with a cache directory", async () => {
      const cacheDir = join(directory, "cache");

      const first = await new PatternCompiler({ binary, cacheDir }).compile(
        program("export default 1;"),
      );
      const second = await new PatternCompiler({ binary, cacheDir }).compile(
        program("export default 1;"),
      );

      expect((await lines("calls")).length).toBe(1);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.main).toEqual(first.main);
    });

    it("runs the binary again for a source one of whose files differs", async () => {
      const compiler = new PatternCompiler({
        binary,
        cacheDir: join(directory, "cache"),
      });

      await compiler.compile(program("export default 1;"));
      const second = await compiler.compile(program("export default 2;"));

      expect((await lines("calls")).length).toBe(2);
      expect(second.cached).toBe(false);
    });

    it("runs the binary again once the binary differs", async () => {
      const cacheDir = join(directory, "cache");
      await new PatternCompiler({ binary, cacheDir }).compile(
        program("export default 1;"),
      );
      await Deno.writeTextFile(binary, `${STAND_IN}# another build\n`);

      const second = await new PatternCompiler({ binary, cacheDir }).compile(
        program("export default 1;"),
      );

      expect((await lines("calls")).length).toBe(2);
      expect(second.cached).toBe(false);
    });

    it("keeps nothing in the cache directory for a program the binary refuses", async () => {
      const cacheDir = join(directory, "cache");
      const compiler = new PatternCompiler({ binary, cacheDir });

      await expect(compiler.compile(program("REFUSED"))).rejects.toThrow(
        PatternCompileError,
      );
      await expect(compiler.compile(program("REFUSED"))).rejects.toThrow(
        PatternCompileError,
      );

      expect((await lines("calls")).length).toBe(2);
    });
  });
});
