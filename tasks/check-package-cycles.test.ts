import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  type AllowedCycle,
  ALLOWLIST,
  buildEdges,
  type Edge,
  extractSpecifiers,
  findCycles,
  isExcused,
  isProductionSource,
  isStronglyConnected,
  main,
  packageOfPath,
  readWorkspace,
  resolveRelative,
  scan,
  targetPackage,
} from "./check-package-cycles.ts";

const edge = (from: string, to: string): Edge => ({
  from,
  to,
  file: `packages/${from}/src/mod.ts`,
  specifier: `@commonfabric/${to}`,
});

/** A workspace whose packages hold exactly the given files. */
async function fixtureTree(
  packages: Record<string, Record<string, string>>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-package-cycles-" });
  const members = Object.keys(packages).map((name) => `./packages/${name}`);
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({ workspace: members }),
  );
  for (const [name, files] of Object.entries(packages)) {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, "packages", name, path);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, contents);
    }
    const config = join(root, "packages", name, "deno.jsonc");
    try {
      await Deno.stat(config);
    } catch {
      await Deno.writeTextFile(
        config,
        JSON.stringify({ name: `@commonfabric/${name}` }),
      );
    }
  }
  return root;
}

/** Runs `body` with console output captured, returning what each stream got. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

const trees: string[] = [];
const tree = async (
  packages: Record<string, Record<string, string>>,
): Promise<string> => {
  const root = await fixtureTree(packages);
  trees.push(root);
  return root;
};

const MEMBERS = [
  "runner",
  "html",
  "ui",
  "patterns",
  "integration",
  "connectors/agents/connector",
];

describe("check-package-cycles", () => {
  afterEach(async () => {
    for (const root of trees.splice(0)) {
      await Deno.remove(root, { recursive: true });
    }
  });

  describe("extractSpecifiers()", () => {
    it("returns the specifier of a static import", () => {
      expect(extractSpecifiers(`import { h } from "@commonfabric/html";`))
        .toEqual(["@commonfabric/html"]);
    });

    it("returns the specifier of a re-export", () => {
      expect(extractSpecifiers(`export { h } from "./h.ts";`))
        .toEqual(["./h.ts"]);
    });

    it("returns the specifier of a side-effect import", () => {
      expect(extractSpecifiers(`import "@commonfabric/utils/polyfill";`))
        .toEqual(["@commonfabric/utils/polyfill"]);
    });

    it("returns the specifier of a dynamic import", () => {
      expect(extractSpecifiers(`await import("@commonfabric/llm");`))
        .toEqual(["@commonfabric/llm"]);
    });

    it("returns the specifier of a type-only import", () => {
      expect(extractSpecifiers(`import type { Cell } from "@commonfabric/x";`))
        .toEqual(["@commonfabric/x"]);
    });

    it("returns every specifier in the order it appears", () => {
      const source = `import "a";\nimport { b } from "b";\nexport * from "c";`;
      expect(extractSpecifiers(source)).toEqual(["a", "b", "c"]);
    });

    it("returns an empty array for source with no imports", () => {
      expect(extractSpecifiers("export const x = 1;")).toEqual([]);
    });
  });

  describe("isProductionSource()", () => {
    it("returns true for a source file inside a package", () => {
      expect(isProductionSource("packages/runner/src/cell.ts", MEMBERS)).toBe(
        true,
      );
    });

    it("returns true for a `.tsx` source file", () => {
      expect(isProductionSource("packages/html/src/view.tsx", MEMBERS)).toBe(
        true,
      );
    });

    it("returns false for a file under a package's `test` directory", () => {
      expect(isProductionSource("packages/runner/test/cell.test.ts", MEMBERS))
        .toBe(false);
    });

    it("returns false for a file under a package's `integration` directory", () => {
      expect(
        isProductionSource("packages/runner/integration/setup.ts", MEMBERS),
      )
        .toBe(false);
    });

    it("returns false for a file nested below a `test` directory", () => {
      expect(
        isProductionSource("packages/runner/test/support/fake.ts", MEMBERS),
      )
        .toBe(false);
    });

    it("returns false for a `.test.tsx` file sitting beside its subject", () => {
      expect(
        isProductionSource("packages/ui/src/cf-card/cf-card.test.tsx", MEMBERS),
      )
        .toBe(false);
    });

    it("returns false for a `.bench.ts` file", () => {
      expect(isProductionSource("packages/runner/src/cell.bench.ts", MEMBERS))
        .toBe(false);
    });

    it("returns true for source in a package whose own name is `integration`", () => {
      expect(isProductionSource("packages/integration/src/mod.ts", MEMBERS))
        .toBe(true);
    });

    it("returns false for a file outside `packages/`", () => {
      expect(isProductionSource("tasks/check-package-cycles.ts", MEMBERS)).toBe(
        false,
      );
    });

    it("returns false for a file with no code extension", () => {
      expect(isProductionSource("packages/runner/README.md", MEMBERS)).toBe(
        false,
      );
    });
  });

  describe("resolveRelative()", () => {
    it("returns a sibling path for a `./` specifier", () => {
      expect(resolveRelative("packages/a/src/x.ts", "./y.ts"))
        .toBe("packages/a/src/y.ts");
    });

    it("returns the parent's path for a `../` specifier", () => {
      expect(resolveRelative("packages/a/src/x.ts", "../mod.ts"))
        .toBe("packages/a/mod.ts");
    });

    it("returns another package's path when the specifier climbs out", () => {
      expect(resolveRelative("packages/a/src/x.ts", "../../b/src/y.ts"))
        .toBe("packages/b/src/y.ts");
    });
  });

  describe("targetPackage()", () => {
    const workspace = {
      members: [
        "runner",
        "sprocket-service",
        "a",
        "connectors/agents/connector",
      ],
      names: new Map([
        ["@commonfabric/runner", "runner"],
        ["@commonfabric/sprocket", "sprocket-service"],
        ["@commonfabric/agents-connector", "connectors/agents/connector"],
      ]),
    };

    it("returns the package a bare specifier names", () => {
      expect(
        targetPackage("packages/a/x.ts", "@commonfabric/runner", workspace),
      )
        .toBe("runner");
    });

    it("returns the package a subpath export names", () => {
      expect(
        targetPackage("packages/a/x.ts", "@commonfabric/runner/cfc", workspace),
      ).toBe("runner");
    });

    it("returns the directory rather than the package name where they differ", () => {
      expect(
        targetPackage(
          "packages/a/x.ts",
          "@commonfabric/sprocket",
          workspace,
        ),
      ).toBe("sprocket-service");
    });

    it("returns the nested member a bare specifier names", () => {
      expect(
        targetPackage(
          "packages/a/x.ts",
          "@commonfabric/agents-connector",
          workspace,
        ),
      ).toBe("connectors/agents/connector");
    });

    it("returns the nested member a relative specifier climbs into", () => {
      expect(
        targetPackage(
          "packages/a/src/x.ts",
          "../../connectors/agents/connector/src/y.ts",
          workspace,
        ),
      ).toBe("connectors/agents/connector");
    });

    it("returns the package a relative specifier climbs into", () => {
      expect(
        targetPackage(
          "packages/a/src/x.ts",
          "../../runner/src/cell.ts",
          workspace,
        ),
      ).toBe("runner");
    });

    it("returns the importing package for a specifier that stays inside it", () => {
      expect(targetPackage("packages/a/src/x.ts", "./y.ts", workspace)).toBe(
        "a",
      );
    });

    it("returns undefined for a specifier naming no workspace package", () => {
      expect(targetPackage("packages/a/x.ts", "@std/path", workspace))
        .toBe(undefined);
    });

    it("returns undefined for an npm specifier", () => {
      expect(targetPackage("packages/a/x.ts", "npm:typescript", workspace))
        .toBe(undefined);
    });
  });

  describe("findCycles()", () => {
    it("returns an empty array for a graph with no cycle", () => {
      expect(findCycles([edge("a", "b"), edge("b", "c")])).toEqual([]);
    });

    it("returns the pair for two packages importing each other", () => {
      expect(findCycles([edge("a", "b"), edge("b", "a")])).toEqual([[
        "a",
        "b",
      ]]);
    });

    it("returns all three for a cycle running through a third package", () => {
      const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
      expect(findCycles(edges)).toEqual([["a", "b", "c"]]);
    });

    it("returns each disjoint cycle separately", () => {
      const edges = [
        edge("a", "b"),
        edge("b", "a"),
        edge("x", "y"),
        edge("y", "x"),
      ];
      expect(findCycles(edges)).toEqual([["a", "b"], ["x", "y"]]);
    });

    it("returns one group when a shared package joins two cycles", () => {
      const edges = [
        edge("a", "b"),
        edge("b", "a"),
        edge("b", "c"),
        edge("c", "b"),
      ];
      expect(findCycles(edges)).toEqual([["a", "b", "c"]]);
    });

    it("returns the packages of a group in sorted order", () => {
      const edges = [edge("z", "m"), edge("m", "a"), edge("a", "z")];
      expect(findCycles(edges)).toEqual([["a", "m", "z"]]);
    });
  });

  describe("isStronglyConnected()", () => {
    it("returns true when every package can reach every other", () => {
      expect(isStronglyConnected(["a", "b"], [edge("a", "b"), edge("b", "a")]))
        .toBe(true);
    });

    it("returns false when one direction is missing", () => {
      expect(isStronglyConnected(["a", "b"], [edge("a", "b")])).toBe(false);
    });

    it("returns false for a single package", () => {
      expect(isStronglyConnected(["a"], [])).toBe(false);
    });

    it("ignores edges that leave the given package set", () => {
      const edges = [edge("a", "c"), edge("c", "b")];
      expect(isStronglyConnected(["a", "b"], edges)).toBe(false);
    });
  });

  describe("isExcused()", () => {
    const allowlist: AllowedCycle[] = [
      { packages: ["a", "b"], reason: "test" },
    ];

    it("returns true for an edge between two members of one entry", () => {
      expect(isExcused(edge("a", "b"), allowlist)).toBe(true);
    });

    it("returns false for an edge leaving the entry", () => {
      expect(isExcused(edge("a", "c"), allowlist)).toBe(false);
    });
  });

  describe("readWorkspace()", () => {
    it("returns the package name declared by each workspace member", async () => {
      const root = await tree({ alpha: { "src/mod.ts": "" } });
      const workspace = await readWorkspace(root);
      expect(workspace.members).toEqual(["alpha"]);
      expect(workspace.names)
        .toEqual(new Map([["@commonfabric/alpha", "alpha"]]));
    });

    it("returns a nested member under its full directory", async () => {
      const root = await tree({
        "connectors/agents/connector": { "src/mod.ts": "" },
      });
      const workspace = await readWorkspace(root);
      expect(workspace.members).toEqual(["connectors/agents/connector"]);
      expect(workspace.names).toEqual(
        new Map([
          [
            "@commonfabric/connectors/agents/connector",
            "connectors/agents/connector",
          ],
        ]),
      );
    });

    it("omits a member that declares no name but keeps its directory", async () => {
      const root = await tree({
        alpha: { "deno.jsonc": "{}", "src/mod.ts": "" },
      });
      const workspace = await readWorkspace(root);
      expect(workspace.members).toEqual(["alpha"]);
      expect(workspace.names).toEqual(new Map());
    });

    it("ignores malformed and non-package workspace entries", async () => {
      const root = await tree({
        alpha: { "deno.json": JSON.stringify({ name: "alpha-from-json" }) },
      });
      await Deno.writeTextFile(
        join(root, "deno.jsonc"),
        JSON.stringify({
          workspace: [null, 42, "./tools", "./packages/alpha"],
        }),
      );
      await Deno.remove(join(root, "packages", "alpha", "deno.jsonc"));

      const workspace = await readWorkspace(root);
      expect(workspace.members).toEqual(["alpha"]);
      expect(workspace.names).toEqual(
        new Map([["alpha-from-json", "alpha"]]),
      );
    });
  });

  describe("packageOfPath()", () => {
    it("returns the member holding the file", () => {
      expect(packageOfPath("packages/runner/src/cell.ts", MEMBERS))
        .toBe("runner");
    });

    it("returns the nested member rather than the directory containing it", () => {
      expect(
        packageOfPath(
          "packages/connectors/agents/connector/src/x.ts",
          MEMBERS,
        ),
      ).toBe("connectors/agents/connector");
    });

    it("returns undefined for a path in no member", () => {
      expect(packageOfPath("packages/connectors/README.md", MEMBERS))
        .toBe(undefined);
    });

    it("returns undefined for a path outside `packages/`", () => {
      expect(packageOfPath("tasks/check-package-cycles.ts", MEMBERS))
        .toBe(undefined);
    });
  });

  describe("buildEdges()", () => {
    it("returns an edge for an import naming another package", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": "" },
      });
      expect(await buildEdges(root)).toEqual([{
        from: "alpha",
        to: "beta",
        file: "packages/alpha/src/mod.ts",
        specifier: "@commonfabric/beta",
      }]);
    });

    it("returns an edge for a relative import reaching into another package", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "../../beta/src/mod.ts";` },
        beta: { "src/mod.ts": "" },
      });
      expect((await buildEdges(root)).map((e) => `${e.from}->${e.to}`))
        .toEqual(["alpha->beta"]);
    });

    it("returns no edge for an import inside the same package", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "./other.ts";`, "src/other.ts": "" },
      });
      expect(await buildEdges(root)).toEqual([]);
    });

    it("returns no edge for an import in a test file", async () => {
      const root = await tree({
        alpha: { "test/mod.test.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": "" },
      });
      expect(await buildEdges(root)).toEqual([]);
    });
  });

  describe("scan()", () => {
    it("returns no unexpected cycle for an acyclic workspace", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": "" },
      });
      const result = await scan(root, []);
      expect(result.unexpected).toEqual([]);
      expect(result.resolved).toEqual([]);
    });

    it("returns the cycle two packages importing each other form", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      expect((await scan(root, [])).unexpected).toEqual([["alpha", "beta"]]);
    });

    it("returns no unexpected cycle when the allowlist covers it", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      const allowlist = [{ packages: ["alpha", "beta"], reason: "test" }];
      expect((await scan(root, allowlist)).unexpected).toEqual([]);
    });

    it("returns the cycle when a third package joins an allowlisted pair", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/gamma";` },
        gamma: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      const allowlist = [{ packages: ["alpha", "beta"], reason: "test" }];
      expect((await scan(root, allowlist)).unexpected)
        .toEqual([["alpha", "beta", "gamma"]]);
    });

    it("returns an allowlist entry that no longer describes a cycle", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": "" },
      });
      const allowlist = [{ packages: ["alpha", "beta"], reason: "test" }];
      expect((await scan(root, allowlist)).resolved).toEqual(allowlist);
    });
  });

  describe("main()", () => {
    it("returns 0 and says so for an acyclic workspace", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": "" },
      });
      let code = -1;
      const { out } = await captureConsole(async () => {
        code = await main(root, []);
      });
      expect(code).toBe(0);
      expect(out).toContain("acyclic");
    });

    it("returns 1 and names the import that closes the cycle", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      let code = -1;
      const { err } = await captureConsole(async () => {
        code = await main(root, []);
      });
      expect(code).toBe(1);
      expect(err).toContain("1 package import cycle not on the allowlist");
      expect(err).toContain("alpha + beta");
      expect(err).toContain("packages/alpha/src/mod.ts");
      expect(err).toContain("alpha -> beta, 1 import:");
      expect(err).toContain("Removing any one of these would break the cycle");
    });

    it("returns 1 without the shrink message when a cycle grows past its entry", async () => {
      // The two-package entry stops matching because the cycle it named has
      // absorbed a third package, not because anyone fixed it. Saying the
      // allowlist should shrink would send the reader to the wrong file.
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/gamma";` },
        gamma: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      let code = -1;
      const { err } = await captureConsole(async () => {
        code = await main(root, [{ packages: ["alpha", "beta"], reason: "t" }]);
      });
      expect(code).toBe(1);
      expect(err).toContain("alpha + beta + gamma");
      expect(err).not.toContain("The allowlist may only shrink");
    });

    it("returns 1 and asks for the entry's removal when a cycle is gone", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": "" },
        beta: { "src/mod.ts": "" },
      });
      let code = -1;
      const { err } = await captureConsole(async () => {
        code = await main(root, [{ packages: ["alpha", "beta"], reason: "t" }]);
      });
      expect(code).toBe(1);
      expect(err).toContain("1 ALLOWLIST entry");
      expect(err).toContain("no longer describes a cycle");
      expect(err).toContain("The allowlist may only shrink. Delete it.");
    });

    it("writes the plural forms when two entries no longer describe a cycle", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": "" },
        beta: { "src/mod.ts": "" },
      });
      let code = -1;
      const { err } = await captureConsole(async () => {
        code = await main(root, [
          { packages: ["alpha", "beta"], reason: "t" },
          { packages: ["gamma", "delta"], reason: "t" },
        ]);
      });
      expect(code).toBe(1);
      expect(err).toContain("2 ALLOWLIST entries");
      expect(err).toContain("no longer describe a cycle");
      expect(err).toContain("The allowlist may only shrink. Delete them.");
    });

    it("says nothing of an allowlist when there are no allowed cycles", async () => {
      const root = await tree({ alpha: { "src/mod.ts": "" } });
      let code = -1;
      const { out } = await captureConsole(async () => {
        code = await main(root, []);
      });
      expect(code).toBe(0);
      expect(out).toBe("Package imports are acyclic.");
    });

    it("counts one allowlisted cycle in the singular", async () => {
      const root = await tree({
        alpha: { "src/mod.ts": `import "@commonfabric/beta";` },
        beta: { "src/mod.ts": `import "@commonfabric/alpha";` },
      });
      let code = -1;
      const { out } = await captureConsole(async () => {
        code = await main(root, [{ packages: ["alpha", "beta"], reason: "t" }]);
      });
      expect(code).toBe(0);
      expect(out).toBe(
        "Package imports are acyclic, apart from 1 allowlisted cycle.",
      );
    });
  });

  describe("ALLOWLIST", () => {
    it("names each entry's packages in sorted order", () => {
      for (const entry of ALLOWLIST) {
        expect([...entry.packages]).toEqual([...entry.packages].sort());
      }
    });

    it("gives every entry a reason", () => {
      for (const entry of ALLOWLIST) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });

    it("holds no duplicate entries", () => {
      const keys = ALLOWLIST.map((entry) => entry.packages.join("+"));
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
