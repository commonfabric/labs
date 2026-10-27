import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { findViolations } from "./check-dependency-direction.ts";

/**
 * A workspace holding a `base/low` package, a `runtime/high` package, and the
 * `patterns` package, with the given files written into it.
 */
async function fixtureTree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({
    prefix: "check-dependency-direction-",
  });
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({
      workspace: ["./base/low", "./runtime/high", "./patterns"],
    }),
  );
  const configs = {
    "base/low/deno.jsonc": { name: "@commonfabric/low" },
    "runtime/high/deno.jsonc": { name: "@commonfabric/high" },
    "patterns/deno.jsonc": { name: "@commonfabric/patterns" },
  };
  for (const [path, contents] of Object.entries(configs)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), JSON.stringify(contents));
  }
  for (const [path, contents] of Object.entries(files)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
  return root;
}

async function violationsIn(files: Record<string, string>) {
  const root = await fixtureTree(files);
  try {
    return (await findViolations(root)).map(({ from, to, file }) => ({
      from,
      to,
      file,
    }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

describe("check-dependency-direction", () => {
  describe("findViolations()", () => {
    it("returns an import from a package to one in a later place", async () => {
      expect(
        await violationsIn({
          "base/low/mod.ts": 'import "@commonfabric/high";\n',
          "runtime/high/mod.ts": "export {};\n",
        }),
      ).toEqual([{ from: "low", to: "high", file: "base/low/mod.ts" }]);
    });

    it("returns nothing for an import from a package to one in an earlier place", async () => {
      expect(
        await violationsIn({
          "base/low/mod.ts": "export {};\n",
          "runtime/high/mod.ts": 'import "@commonfabric/low";\n',
        }),
      ).toEqual([]);
    });

    it("returns a pattern's import from a later category", async () => {
      expect(
        await violationsIn({
          "patterns/system/home/home.tsx":
            'import "../../apps/topics/topic.tsx";\n',
          "patterns/apps/topics/topic.tsx": "export {};\n",
        }),
      ).toEqual([{
        from: "patterns/system",
        to: "patterns/apps",
        file: "patterns/system/home/home.tsx",
      }]);
    });

    it("returns nothing for a pattern's import from an earlier category or its own", async () => {
      expect(
        await violationsIn({
          "patterns/apps/topics/topic.tsx":
            'import "../../system/home/home.tsx";\nimport "../notes/a.tsx";\n',
          "patterns/system/home/home.tsx": "export {};\n",
          "patterns/apps/notes/a.tsx": "export {};\n",
        }),
      ).toEqual([]);
    });

    it("returns nothing for a test that imports from anywhere", async () => {
      expect(
        await violationsIn({
          "base/low/test/low.test.ts": 'import "@commonfabric/high";\n',
          "patterns/system/home/home.test.tsx":
            'import "../../apps/topics/topic.tsx";\n',
          "runtime/high/mod.ts": "export {};\n",
          "patterns/apps/topics/topic.tsx": "export {};\n",
        }),
      ).toEqual([]);
    });
  });
});
