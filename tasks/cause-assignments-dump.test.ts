import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import { buildAssignment, type Program } from "./cause-assignments-dump.ts";
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
          cell.holdsState,
          cell.description.replace(/sub-pattern \S+#/, "sub-pattern #"),
        ]),
      ).toEqual([
        [0, true, "cell, computed, written by sub-pattern #Other"],
        [1, true, "cell, computed, written by sub-pattern #Child"],
      ]);
    });

    it("returns builds whose comparison finds a child moved, where a cell ahead of it is gone", async () => {
      // The two programs differ in source, which the gate never compares;
      // here the difference stands in for a compiler change that drops the
      // cell ahead of the child.

      const before = await buildAssignment(runtime, BOTH, "main.tsx");
      const after = await buildAssignment(runtime, CHILD_ONLY, "main.tsx");

      expect(
        movedCells(before!, after!).map(({ holdsState, from, to }) => ({
          holdsState,
          from,
          to,
        })),
      ).toEqual([{ holdsState: true, from: 1, to: 0 }]);
    });

    it("returns builds whose comparison finds nothing moved, for one program built twice", async () => {
      const once = await buildAssignment(runtime, BOTH, "main.tsx");
      const twice = await buildAssignment(runtime, BOTH, "main.tsx");

      expect(movedCells(once!, twice!)).toEqual([]);
      expect(twice?.source).toBe(once?.source);
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
});
