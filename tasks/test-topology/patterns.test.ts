import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SKIP_LIST_VARIABLE } from "@commonfabric/test-support/records";
import { serverExecutionCiLane } from "../server-execution-ci.ts";
import { loadPatternSuites } from "./patterns.ts";
import { loadPackageIntegrationSuites } from "./package-integration.ts";
import type { CommandContext, Suite } from "./suite.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const suites = [
  ...await loadPatternSuites(root),
  ...await loadPackageIntegrationSuites(root),
];
const pick = (from: readonly Suite[], id: string): Suite =>
  from.find((suite) => suite.id === id)!;
const byId = (id: string): Suite => pick(suites, id);

/** A directory each case writes its reports and lists into. */
async function outputDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "patterns-suite-" });
}

/** A context that measures both streams, writing into stated directories. */
function measured(outputDir: string): CommandContext {
  return {
    root,
    outputDir,
    coverageDir: "/cov",
    patternCoverageDir: "/pattern",
    spoolDir: "/spool",
  };
}

/** The two pattern integration suites, named by the arm each resolves to. */
function arms(defaultEnabled: boolean): { on: string; off: string } {
  return defaultEnabled
    ? { on: "pattern-integration", off: "pattern-integration-opposite" }
    : { on: "pattern-integration-opposite", off: "pattern-integration" };
}

describe("the pattern and package suites", () => {
  it("runs the chosen files where the package lives", async () => {
    const suite = byId("pattern-integration");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir(), spoolDir: "/spool" },
    );
    expect(invocation!.cwd).toBe(`${root}/packages/patterns`);
    expect(invocation!.env?.HEADLESS).toBe("1");
    expect(invocation!.junit?.[0]?.scope).toBe("patterns");
  });

  it("leaves the pattern integration type check to the type check", async () => {
    // `packages/patterns/integration` is one of the paths
    // `tasks/typecheck.ts` lists, so a run that checks them again is
    // doing that work twice.
    for (const id of ["pattern-integration", "pattern-integration-opposite"]) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        { root, outputDir: await outputDir(), spoolDir: "/spool" },
      );
      expect(invocation!.command).toContain("--no-check");
    }
  });

  it("gives every suite that measures a pattern somewhere to report it", async () => {
    // Authored-pattern coverage is LCOV the instrumentation writes for
    // itself rather than a V8 profile the lane converts, so it needs a
    // directory of its own. It is the only source of coverage for the
    // pattern files, and a suite that measured one and reported nowhere
    // would take that coverage out of the repository-wide figure with
    // nothing saying so.

    const context = measured(await outputDir());
    for (const defaultEnabled of [true, false]) {
      const loaded = await loadPatternSuites(root, defaultEnabled);
      const { off } = arms(defaultEnabled);
      for (const id of [off, "pattern-unit", "pattern-reload"]) {
        const suite = pick(loaded, id);
        const [invocation] = await suite.command(
          [{ unit: suite.units[0]!, skip: [] }],
          context,
        );
        expect(invocation!.env?.CF_PATTERN_COVERAGE_DIR).toBe("/pattern");
        expect(invocation!.env?.DENO_COVERAGE_DIR).toBeDefined();
      }
    }
  });

  it("leaves the pattern instrumentation off the arm that compiles twice", async () => {
    // Instrumenting a pattern compiles it a second way, and what the
    // browser worker records is the whole of what ran only where that
    // worker does all the compiling. The arm running server execution
    // has another compiler on the server, so it collects the V8 profile
    // and leaves the authored-pattern report to the other arm.

    const context = measured(await outputDir());
    for (const defaultEnabled of [true, false]) {
      const loaded = await loadPatternSuites(root, defaultEnabled);
      const suite = pick(loaded, arms(defaultEnabled).on);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        context,
      );
      expect(invocation!.env?.CF_PATTERN_COVERAGE_DIR).toBeUndefined();
      expect(invocation!.env?.DENO_COVERAGE_DIR).toBeDefined();
    }
  });

  it("leaves the pattern report out where nothing measures the batch", async () => {
    const suite = byId("pattern-unit");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir(), spoolDir: "/spool" },
    );
    expect(invocation!.env?.CF_PATTERN_COVERAGE_DIR).toBeUndefined();
    expect(invocation!.env?.DENO_COVERAGE_DIR).toBeUndefined();
  });

  it("runs an integration suite the way its own task runs it", async () => {
    // Each package's `integration` task sets the log level, and running
    // the same files at the default level is running them differently
    // from the way they are meant to run.

    for (
      const id of [
        "pattern-integration",
        "pattern-integration-opposite",
        "package-integration",
        "package-integration-opposite",
      ]
    ) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        { root, outputDir: await outputDir(), spoolDir: "/spool" },
      );
      expect(invocation!.env?.LOG_LEVEL).toBe("warn");
    }
  });

  it("runs the opposite arm with an explicit define and history", async () => {
    const opposite = serverExecutionCiLane("opposite");
    const suite = byId("pattern-integration-opposite");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: await outputDir(), spoolDir: "/spool" },
    );
    expect(invocation!.env?.EXPERIMENTAL_SERVER_EXECUTION).toBe(
      String(opposite.enabled),
    );
    expect(suite.variant).toBe(opposite.recordVariant);
  });

  it("moves the test surfaces with the roles after a default flip", async () => {
    const defaultEnabled = !serverExecutionCiLane("default").enabled;
    const opposite = serverExecutionCiLane("opposite", defaultEnabled);
    const flipped = [
      ...await loadPatternSuites(root, defaultEnabled),
      ...await loadPackageIntegrationSuites(root, defaultEnabled),
    ];
    for (
      const id of [
        "pattern-integration-opposite",
        "package-integration-opposite",
      ]
    ) {
      const suite = flipped.find((candidate) => candidate.id === id)!;
      expect(suite.variant).toBe(opposite.recordVariant);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        { root, outputDir: await outputDir(), spoolDir: "/spool" },
      );
      expect(invocation!.env?.EXPERIMENTAL_SERVER_EXECUTION).toBe(
        String(opposite.enabled),
      );
    }
  });

  it("names a skip list only where a leaf inside a unit is skipped", async () => {
    const suite = byId("pattern-integration");
    const out = await outputDir();
    const unit = suite.units[0]!;
    const [whole] = await suite.command([{ unit, skip: [] }], {
      root,
      outputDir: out,
      spoolDir: "/spool",
    });
    expect(whole!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();
    const [partial] = await suite.command(
      [{ unit, skip: ["counter > counts up"] }],
      { root, outputDir: out, spoolDir: "/spool" },
    );
    const listed = partial!.env?.[SKIP_LIST_VARIABLE];
    expect(listed).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listed!))).toEqual({
      [unit]: ["counter > counts up"],
    });
  });

  it("points a measured batch at a directory of its own", async () => {
    const suite = byId("pattern-integration");
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      {
        root,
        outputDir: await outputDir(),
        coverageDir: "/cov",
        spoolDir: "/spool",
      },
    );
    expect(invocation!.env?.DENO_COVERAGE_DIR).toBe(
      "/cov/packages__patterns",
    );
  });

  it("runs one invocation per package the suite spans", async () => {
    // The three packages share a command shape and a server, and each
    // records under its own scope, so a batch holding files from two of
    // them runs twice and reports twice.
    const suite = byId("package-integration");
    const runner = suite.units.find((u) => u.startsWith("packages/runner/"))!;
    const shell = suite.units.find((u) => u.startsWith("packages/shell/"))!;
    const made = await suite.command(
      [{ unit: runner, skip: [] }, { unit: shell, skip: [] }],
      { root, outputDir: await outputDir(), spoolDir: "/spool" },
    );
    expect(made.length).toBe(2);
    expect(made.map((i) => i.junit?.[0]?.scope).toSorted())
      .toEqual(["runner", "shell"]);
  });

  it("owns the deployed-topology posture gate", async () => {
    const suite = byId("deployed-topology");
    expect(suite.units).toEqual([
      "packages/cf-harness/integration/fabric-session-posture-gate.test.ts",
    ]);
    expect(suite.needs).toContain("toolshed");
    const made = await suite.command(
      suite.units.map((unit) => ({ unit, skip: [] })),
      { root, outputDir: await outputDir(), spoolDir: "/spool" },
    );
    expect(made.map((invocation) => invocation.junit?.[0]?.scope)).toEqual([
      "cf-harness",
    ]);
  });

  it("gives the reload suite its own unit and its own task", async () => {
    // Its task brings the whole local development stack up around the
    // run and hard-codes the directory it walks, so a lane can ask for
    // the suite or not, and nothing finer.
    const suite = byId("pattern-reload");
    expect(suite.units).toEqual(["packages/patterns/integration/reload"]);
    const [invocation] = await suite.command(
      [{ unit: suite.units[0]!, skip: [] }],
      { root, outputDir: "/out", spoolDir: "/spool" },
    );
    expect(invocation!.command).toContain("patterns-reload");
    expect(
      await suite.command([], { root, outputDir: "/out", spoolDir: "/spool" }),
    ).toEqual([]);
  });

  it("locates a reload record by the directory it came from", () => {
    const suite = byId("pattern-reload");
    expect(
      suite.locate({
        test: { k: "integration", s: "patterns", n: "reloads" },
        file: "packages/patterns/integration/reload/default-app.test.ts",
      }),
    ).toEqual({ level: "unit", unit: "packages/patterns/integration/reload" });
    // A file elsewhere under the same scope belongs to the integration
    // suite, which claims it by being the suite that enumerates it.
    expect(
      suite.locate({
        test: { k: "integration", s: "patterns", n: "counts" },
        file: "packages/patterns/integration/counter.test.ts",
      }),
    ).toBeUndefined();
  });

  it("hands the pattern unit tests the files it was given", async () => {
    // A selected set is a list of unrelated paths and no substring
    // filter expresses one, so the files travel in a file.
    const suite = byId("pattern-unit");
    const out = await outputDir();
    const chosen = suite.units.slice(0, 2);
    const [invocation] = await suite.command(
      chosen.map((unit) => ({ unit, skip: [] })),
      { root, outputDir: out, spoolDir: "/spool" },
    );
    const flag = invocation!.command.find((arg) => arg.startsWith("--files="))!;
    const listed = await Deno.readTextFile(flag.slice("--files=".length));
    expect(listed.trim().split("\n")).toEqual(chosen);
  });

  it("names a pattern test by its own path", () => {
    const suite = byId("pattern-unit");
    const unit = suite.units[0]!;
    expect(suite.locate({ test: { k: "pattern", s: "patterns", n: unit } }))
      .toEqual({ level: "unit", unit });
    expect(
      suite.locate({
        test: { k: "pattern", s: "patterns", n: "gone.test.tsx" },
      }),
    ).toBeUndefined();
  });

  it("builds nothing for a suite asked for no units", async () => {
    for (const id of ["pattern-unit", "generated-patterns"]) {
      expect(
        await byId(id).command([], {
          root,
          outputDir: "/out",
          spoolDir: "/spool",
        }),
      )
        .toEqual([]);
    }
  });
});

describe("enumerating a tree that cannot be read", () => {
  /** A root where a directory the suites walk is a file instead. */
  async function obstructed(at: string): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "obstructed-" });
    const parent = at.slice(0, at.lastIndexOf("/"));
    await Deno.mkdir(`${root}/${parent}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${at}`, "not a directory");
    return root;
  }

  it("raises rather than reporting a suite with no files", async () => {
    // Passing over a missing directory is right; passing over one that
    // cannot be read would take tests out of the topology without a
    // word, and the drift guard would then report success over a
    // shorter list than the tree holds. Both readers are held to it: the
    // integration directory is read flat and the pattern trees are
    // walked, and each has its own rethrow.
    for (
      const directory of [
        "packages/patterns/integration",
        "packages/connectors/agents/debug-view",
      ]
    ) {
      const root = await obstructed(directory);
      await expect(loadPatternSuites(root)).rejects.toThrow();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("raises for a package integration directory it cannot read", async () => {
    const root = await obstructed("packages/runner/integration");
    await expect(loadPackageIntegrationSuites(root)).rejects.toThrow();
    await Deno.remove(root, { recursive: true });
  });

  it("reports no files for a directory the tree does not hold", async () => {
    // The other half of the same judgement: a package without
    // integration tests contributes nothing and fails nothing.
    const root = await Deno.makeTempDir({ prefix: "bare-" });
    const suites = await loadPackageIntegrationSuites(root);
    expect(suites.flatMap((suite) => suite.units)).toEqual([]);
    await Deno.remove(root, { recursive: true });
  });
});

describe("a tree holding no patterns at all", () => {
  it("enumerates nothing rather than failing", async () => {
    const root = await Deno.makeTempDir({ prefix: "no-patterns-" });
    try {
      const suites = await loadPatternSuites(root);
      const unit = suites.find((suite) => suite.id === "pattern-unit")!;
      expect(unit.units).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
