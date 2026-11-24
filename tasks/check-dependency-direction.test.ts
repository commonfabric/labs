import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { join } from "@std/path";

import { findViolations, main } from "./check-dependency-direction.ts";

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

    it("returns nothing for a pattern's import by a bare specifier", async () => {
      expect(
        await violationsIn({
          "patterns/system/home/home.tsx": 'import "commonfabric";\n',
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

  describe("main()", () => {
    /** Runs `main()` over a tree holding `files`, with console output captured. */
    async function check(
      files: Record<string, string>,
    ): Promise<{ code: number; out: string; err: string }> {
      const root = await fixtureTree(files);
      const out: string[] = [];
      const err: string[] = [];
      try {
        using _log = stub(console, "log", (...args) => {
          out.push(args.join(" "));
        });
        using _error = stub(console, "error", (...args) => {
          err.push(args.join(" "));
        });
        const code = await main(root);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }

    it("returns 0 and says so for imports that run in order", async () => {
      expect(
        await check({ "runtime/high/mod.ts": 'import "@commonfabric/low";\n' }),
      ).toEqual({
        code: 0,
        out: "Production imports run in the layout's order.",
        err: "",
      });
    });

    it("returns 1 and names the one import that runs against the order", async () => {
      const { code, out, err } = await check({
        "base/low/mod.ts": 'import "@commonfabric/high";\n',
      });

      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain(
        "\n1 production import runs against the layout's order:\n",
      );
      expect(err).toContain(
        "  low -> high: base/low/mod.ts  <-  @commonfabric/high",
      );
      expect(err).toContain("LAYOUT.md says what each place holds.");
    });

    it("returns 1 and counts several imports in the plural", async () => {
      const { code, err } = await check({
        "base/low/mod.ts": 'import "@commonfabric/high";\n',
        "patterns/system/home/home.tsx":
          'import "../../apps/topics/topic.tsx";\n',
      });

      expect(code).toBe(1);
      expect(err).toContain(
        "\n2 production imports run against the layout's order:\n",
      );
      expect(err).toContain(
        "  patterns/system -> patterns/apps: patterns/system/home/home.tsx" +
          "  <-  ../../apps/topics/topic.tsx",
      );
    });
  });
});
