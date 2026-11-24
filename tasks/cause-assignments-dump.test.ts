import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { createRuntime } from "../runtime/cli/lib/dev.ts";
import {
  buildAssignment,
  type DumpOutput,
  type DumpRuntime,
  type Program,
  runDump,
} from "./cause-assignments-dump.ts";
import { movedCells } from "./cause-assignments-lib.ts";

// Each child pattern sits in a module of its own, which every parent below
// imports unchanged, so that a child is known by one pattern identity in
// every one of them.
const childModule = (name: string) => ({
  name: `/${name.toLowerCase()}.tsx`,
  contents: [
    "import { pattern } from 'commonfabric';",
    `export const ${name} = pattern<{ n: number }, { n: number }>(`,
    "  ({ n }) => ({ n }),",
    ");",
    "",
  ].join("\n"),
});

/**
 * A parent of the positional children `children` builds, each of `Child` or
 * `Other`.
 */
const parent = (children: readonly string[]): Program => ({
  main: "/main.tsx",
  files: [childModule("Child"), childModule("Other"), {
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "import { Child } from './child.tsx';",
      "import { Other } from './other.tsx';",
      "export default pattern<{ n: number }>(({ n }) => {",
      `  const children = [${
        children.map((child) => `${child}({ n })`).join(", ")
      }];`,
      "  return { views: children };",
      "});",
      "",
    ].join("\n"),
  }],
});

// A parent of one child, whose module exports it first as `Tally`, which a
// load registers first, and then as `Counter`, the least of its names. The
// module also exports another pattern under a name less than either.
const ALIASED: Program = {
  main: "/main.tsx",
  files: [{
    name: "/tally.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export const Tally = pattern<{ n: number }, { n: number }>(",
      "  ({ n }) => ({ n }),",
      ");",
      "export const Counter = Tally;",
      "export const Abacus = pattern<{ n: number }, { n: number }>(",
      "  ({ n }) => ({ n: n + 1 }),",
      ");",
      "",
    ].join("\n"),
  }, {
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "import { Tally } from './tally.tsx';",
      "export default pattern<{ n: number }>(({ n }) => {",
      "  const children = [Tally({ n })];",
      "  return { views: children };",
      "});",
      "",
    ].join("\n"),
  }],
};

/** The descriptions of `built`'s entry level, its children's identities elided. */
const childDescriptions = (
  built: Awaited<ReturnType<typeof buildAssignment>>,
): string[] | undefined =>
  built?.levels[0].cells.map((cell) =>
    cell.description.replace(/sub-pattern \S+#/, "sub-pattern #")
  );

const BOTH = parent(["Child", "Other"]);
const CHILD_ONLY = parent(["Child"]);

describe("cause-assignments-dump", () => {
  let runtime: Awaited<ReturnType<typeof createRuntime>>;

  beforeEach(async () => {
    runtime = await createRuntime();
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  describe("buildAssignment()", () => {
    it("returns the compiled pattern's numbered cells, each sub-pattern child named by its pattern", async () => {
      const built = await buildAssignment(runtime, BOTH, "main.tsx");

      expect(
        built?.levels[0].cells.map((cell) => [
          cell.number,
          cell.hasState,
          cell.description.replace(/sub-pattern \S+#/, "sub-pattern #"),
        ]),
      ).toEqual([
        [0, true, "cell, computed, written by sub-pattern #Other"],
        [1, true, "cell, computed, written by sub-pattern #Child"],
      ]);
    });

    it("returns, for a sub-pattern child its module exports under several names, a description naming the least of them", async () => {
      const built = await buildAssignment(runtime, ALIASED, "main.tsx");

      expect(childDescriptions(built)).toEqual([
        "cell, computed, written by sub-pattern #Counter",
      ]);
    });

    it("returns the same description of such a child from a runtime that has no least-symbol lookup", async () => {
      // A base checkout older than the lookup offers its runtime's first
      // registration only, and the gate holds both builds to one
      // description.
      const { harness, patternManager } = runtime;
      const baseStyle: DumpRuntime = {
        harness,
        patternManager: {
          registerEvaluatedModules: (evaluated) =>
            patternManager.registerEvaluatedModules(evaluated as never),
          getArtifactEntryRef: (artifact) =>
            patternManager.getArtifactEntryRef(artifact),
        },
      };

      const built = await buildAssignment(baseStyle, ALIASED, "main.tsx");

      expect(childDescriptions(built)).toEqual([
        "cell, computed, written by sub-pattern #Counter",
      ]);
    });

    it("returns builds whose comparison finds a child moved, where a cell ahead of it is gone", async () => {
      // The two programs differ in source, which the gate never compares;
      // here the difference stands in for a compiler change that drops the
      // cell ahead of the child.

      const before = await buildAssignment(runtime, BOTH, "main.tsx");
      const after = await buildAssignment(runtime, CHILD_ONLY, "main.tsx");

      expect(
        movedCells(before!, after!).map(({ hasState, from, to }) => ({
          hasState,
          from,
          to,
        })),
      ).toEqual([{ hasState: true, from: 1, to: 0 }]);
    });

    it("returns builds whose comparison finds nothing moved, for one program built twice", async () => {
      const once = await buildAssignment(runtime, BOTH, "main.tsx");
      const twice = await buildAssignment(runtime, BOTH, "main.tsx");

      expect(movedCells(once!, twice!)).toEqual([]);
      expect(twice?.source).toBe(once?.source);
    });

    it("returns children named by their pattern alone, from a runtime that gives no entry ref", async () => {
      const unnamed: DumpRuntime = {
        harness: runtime.harness,
        patternManager: {
          registerEvaluatedModules: () => {},
          getArtifactEntryRef: () => undefined,
        },
      };

      const built = await buildAssignment(unnamed, BOTH, "main.tsx");

      expect(built?.levels[0].cells.map((cell) => cell.description)).toEqual([
        "cell, computed, written by sub-pattern",
        "cell, computed, written by sub-pattern",
      ]);
    });

    it("returns `undefined` for a module whose default export is an object but no pattern", async () => {
      expect(
        await buildAssignment(runtime, {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: "export default { nodes: 3 };\n",
          }],
        }, "main.tsx"),
      ).toBeUndefined();
    });

    it("returns `undefined` for a module that exports no pattern", async () => {
      expect(
        await buildAssignment(runtime, {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 3;\n" }],
        }, "main.tsx"),
      ).toBeUndefined();
    });
  });

  describe("runDump()", () => {
    const ROOT = fromFileUrl(new URL("..", import.meta.url));
    let scratch: string;

    beforeEach(async () => {
      scratch = await Deno.makeTempDir({ prefix: "cause-assignments-dump-" });
    });
    afterEach(async () => {
      await Deno.remove(scratch, { recursive: true });
    });

    it("writes an assignment for a pattern, the source alone for a helper module, and an error for a file that will not compile", async () => {
      const out = join(scratch, "dump.json");

      await runDump([
        "--root",
        ROOT,
        "--out",
        out,
        "patterns/examples/clock/clock.tsx",
        "patterns/system/social-space/short-did.ts",
        "patterns/examples/no-such-pattern.tsx",
      ]);

      const dumped: DumpOutput = JSON.parse(await Deno.readTextFile(out));
      expect(dumped.assignments.map(({ pattern }) => pattern)).toEqual([
        "examples/clock/clock.tsx",
      ]);
      expect(dumped.assignments[0].levels.length).toBeGreaterThan(0);
      expect(dumped.unassigned).toEqual([{
        pattern: "system/social-space/short-did.ts",
        source: expect.stringMatching(/^[0-9a-f]{64}$/),
      }]);
      expect(dumped.errors).toEqual([{
        pattern: "examples/no-such-pattern.tsx",
        error: expect.any(String),
      }]);
    });

    it("throws the usage, and writes nothing, given no `--root`", async () => {
      await expect(
        runDump([
          "--out",
          join(scratch, "dump.json"),
          "patterns/examples/clock/clock.tsx",
        ]),
      ).rejects.toThrow("usage: cause-assignments-dump.ts --root <dir>");
      expect([...Deno.readDirSync(scratch)]).toEqual([]);
    });
  });
});
