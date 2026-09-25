import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import { describe, it } from "@std/testing/bdd";
import {
  dropContainerCases,
  parseJUnit,
  RECORDS_DIR_VARIABLE,
  SKIP_LIST_VARIABLE,
} from "@commonfabric/test-support/records";
import { shuffleFlag, shuffleSeed } from "@commonfabric/test-support/shuffle";
import { loadUnitSuites } from "./unit.ts";
import type { Suite } from "./suite.ts";
import { EXCLUDED_FROM_COVERAGE_GATE } from "../test-selection/policy.ts";

/** This repository's root. A fixture takes its import map from here. */
const REPOSITORY = new URL("../../", import.meta.url);

/**
 * The import map the registration preload's modules resolve through. Deno
 * takes `--preload` as a path rather than through the import map, so a
 * fixture that runs the preload has to supply the specifiers it imports.
 *
 * The map is the repository's own, with each relative entry resolved against
 * the repository so it still names the same file. The preload's
 * `@commonfabric/` imports need no entry here, and the case that runs the
 * preload shows that they resolve without one.
 */
async function preloadImports(): Promise<Record<string, string>> {
  const manifest = parseJsonc(
    await Deno.readTextFile(new URL("deno.jsonc", REPOSITORY)),
  ) as { imports?: Record<string, string> };
  const imports: Record<string, string> = {};
  for (const [specifier, target] of Object.entries(manifest.imports ?? {})) {
    imports[specifier] = target.startsWith(".")
      ? new URL(target, REPOSITORY).href
      : target;
  }
  return imports;
}

/** A workspace holding the members a case describes. */
async function workspace(
  members: Record<string, {
    tasks: Record<string, unknown>;

    /**
     * The files the member holds. A record maps each file to its contents. A
     * list gives empty files, for cases that only read the list of files.
     */
    files?: readonly string[] | Record<string, string>;
  }>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "unit-suite-" });
  await Deno.writeTextFile(
    `${root}/deno.jsonc`,
    JSON.stringify(
      { workspace: Object.keys(members), imports: await preloadImports() },
      null,
      2,
    ),
  );
  // The preload names a test file relative to the directory holding
  // `.git`. Without one, no registration is attributed to a file.
  await Deno.mkdir(`${root}/.git`, { recursive: true });
  for (const [member, contents] of Object.entries(members)) {
    const dir = `${root}/${member}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: contents.tasks }, null, 2),
    );
    const files = Array.isArray(contents.files)
      ? Object.fromEntries(contents.files.map((file) => [file, ""]))
      : contents.files ?? {};
    for (const [file, source] of Object.entries(files)) {
      const at = `${dir}/${file}`;
      await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(at, source as string);
    }
  }
  return root;
}

/** The list allowing the fixture member to run whole. */
const BAKERY_RUNS_WHOLE = new Map([
  ["./packages/bakery", "its tests run through a runner of its own"],
]);

/** The workspace suite of a loaded pair. */
function workspaceUnit(suites: readonly Suite[]): Suite {
  return suites.find((suite) => suite.id === "workspace-unit")!;
}

describe("the workspace unit suites", () => {
  it("makes a file a unit where the member's task takes a subset", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test --allow-read test/*.test.ts" },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery/test/proof.test.ts",
    ]);
  });

  it("makes the member one unit where its task cannot", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno run --allow-read test/run-tests.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root, BAKERY_RUNS_WHOLE));
    expect(suite.units).toEqual(["packages/bakery"]);
  });

  it("gives a browser half a unit of its own", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read test/*.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery#browser-test",
    ]);
  });

  it("leaves a member that says it has no tests out entirely", async () => {
    const root = await workspace({
      "./packages/bakery": { tasks: { test: "echo 'No tests defined.'" } },
    });
    expect(workspaceUnit(await loadUnitSuites(root)).units).toEqual([]);
  });

  it("puts the runner package in a suite of its own", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
      "./packages/runner": {
        tasks: { test: "deno test --no-check test/cell.test.ts" },
        files: ["test/cell.test.ts"],
      },
    });
    const suites = await loadUnitSuites(root);
    expect(suites.map((suite) => suite.id)).toEqual([
      "workspace-unit",
      "runner-unit",
    ]);
    expect(suites[1]!.units).toEqual(["packages/runner/test/cell.test.ts"]);
  });

  it("locates a record by the file its producer recorded", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: { k: "unit", s: "bakery", n: "glaze > sets" },
        file: "packages/bakery/test/glaze.test.ts",
      }),
    ).toEqual({ level: "unit", unit: "packages/bakery/test/glaze.test.ts" });
  });

  it("declines a record carrying a variant it does not run", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: {
          k: "unit",
          s: "bakery",
          n: "glaze > sets",
          v: "server-execution",
        },
        file: "packages/bakery/test/glaze.test.ts",
      }),
    ).toBeUndefined();
  });

  it("declines a record whose file the tree no longer holds", async () => {
    // An identity whose file moved is unknown, and an unknown identity
    // runs; placing it on a unit that no longer exists would not.
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({
        test: { k: "unit", s: "bakery", n: "icing > sets" },
        file: "packages/bakery/test/icing.test.ts",
      }),
    ).toBeUndefined();
  });

  it("hands the run's seed to every `deno test` it builds", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir: "/out", spoolDir: "/spool" },
    );
    expect(invocation!.command).toContain(shuffleFlag(shuffleSeed()));
  });

  it("runs the chosen files with the member's own flags", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "ENV=test deno test --no-check test/*.test.ts" },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir, spoolDir: "/spool" },
    );
    expect(invocation!.command).toContain("--no-check");
    expect(invocation!.command).toContain("test/glaze.test.ts");
    expect(invocation!.command).not.toContain("test/proof.test.ts");
    expect(invocation!.env?.ENV).toBe("test");
    expect(invocation!.junit?.[0]?.scope).toBe("bakery");
  });

  it("stops a listed test running, and leaves its neighbor alone", async () => {
    // Running the invocation the suite built shows which key works. The preload
    // looks a name up under the file that registered it, so a list keyed by
    // anything else is never read.

    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test -A test/glaze.test.ts" },
        files: {
          "test/glaze.test.ts": 'Deno.test("sets overnight", () => {});\n' +
            'Deno.test("proofs the dough", () => {});\n',
        },
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [invocation] = await suite.command(
      [{
        unit: "packages/bakery/test/glaze.test.ts",
        skip: ["sets overnight"],
      }],
      { root, outputDir, spoolDir: `${outputDir}/spool` },
    );
    const run = await new Deno.Command(invocation!.command[0]!, {
      args: invocation!.command.slice(1),
      cwd: invocation!.cwd,
      // The lane running this test has its own spool. Clearing the variable
      // keeps the child's name map out of that lane's records.
      env: { ...invocation!.env, [RECORDS_DIR_VARIABLE]: "" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    expect(run.success).toBe(true);
    const report = parseJUnit(
      await Deno.readTextFile(invocation!.junit![0]!.path),
    );
    expect(
      new Map(
        dropContainerCases(report).map((leaf) => [leaf.name, leaf.outcome]),
      ),
    ).toEqual(
      new Map([["sets overnight", "skip"], ["proofs the dough", "pass"]]),
    );
  });

  it("names a skip list only where something inside a unit is skipped", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [whole] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir, spoolDir: "/spool" },
    );
    expect(whole!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();

    const [partial] = await suite.command(
      [{
        unit: "packages/bakery/test/glaze.test.ts",
        skip: ["glaze > sets overnight"],
      }],
      { root, outputDir, spoolDir: "/spool" },
    );
    const listPath = partial!.env?.[SKIP_LIST_VARIABLE];
    expect(listPath).toBeDefined();
    expect(JSON.parse(await Deno.readTextFile(listPath!))).toEqual({
      "packages/bakery/test/glaze.test.ts": ["glaze > sets overnight"],
    });
  });
});

describe("running a member that cannot be handed a subset", () => {
  it("runs the member's own task, and registers nothing as ignored", async () => {
    // The skip list the preload reads is keyed by the file that registered each
    // test. This unit is the member's own directory, which is not such a file,
    // so the lane writes no skip list for it.

    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno run --allow-read test/run-tests.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root, BAKERY_RUNS_WHOLE));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery", skip: ["glaze > sets overnight"] }],
      { root, outputDir, spoolDir: "/spool" },
    );
    expect(invocation!.command).toEqual([Deno.execPath(), "task", "test"]);
    expect(invocation!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();
    expect(suite.whole).toContain("packages/bakery");
  });

  it("enumerates a member whose task runs the sharded runner", async () => {
    // The runner walks a directory and runs the files assigned to its shard. A
    // lane takes that directory and runs the files it chose, so the member is
    // read a file at a time like any other.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: "deno run --allow-read " +
            "../../tasks/run-sharded-test-files.ts BAKERY_SHARD piece . " +
            "-- --no-check -A",
        },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery/test/proof.test.ts",
    ]);
    expect(suite.whole).toEqual([]);
  });

  it("runs the files the runner sets apart in a `deno test` each", async () => {
    // A serial file cannot run beside another test file in one process, and an
    // all-access file needs every permission. A lane that selects some of each
    // runs them apart, as the runner does, with a report and a skip list of
    // their own.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: "deno run --allow-read " +
            "../../tasks/run-sharded-test-files.ts BAKERY_SHARD cli . " +
            "--serial='**/*.serial.test.ts' --all-access=test/oven.test.ts " +
            "-- --no-check --parallel --allow-read",
        },
        files: [
          "test/glaze.test.ts",
          "test/oven.test.ts",
          "test/proof.serial.test.ts",
        ],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.whole).toEqual([]);
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const invocations = await suite.command(
      [
        { unit: "packages/bakery/test/proof.serial.test.ts", skip: ["rises"] },
        { unit: "packages/bakery/test/oven.test.ts", skip: [] },
        { unit: "packages/bakery/test/glaze.test.ts", skip: [] },
      ],
      { root, outputDir, spoolDir: "/spool" },
    );
    const files = invocations.map((invocation) =>
      invocation.command.filter((word) => word.endsWith(".test.ts"))
    );
    expect(files).toEqual([
      ["test/glaze.test.ts"],
      ["test/oven.test.ts"],
      ["test/proof.serial.test.ts"],
    ]);
    const [plain, allAccess, serial] = invocations;
    expect(plain!.command).toContain("--parallel");
    expect(plain!.command).toContain("--allow-read");
    expect(allAccess!.command).toContain("--allow-all");
    expect(allAccess!.command).not.toContain("--allow-read");
    expect(serial!.command).not.toContain("--parallel");
    expect(serial!.command).toContain("--allow-read");
    expect(
      new Set(invocations.map((invocation) => invocation.junit![0]!.path)).size,
    ).toBe(3);
    expect(plain!.env?.[SKIP_LIST_VARIABLE]).toBeUndefined();
    expect(
      JSON.parse(await Deno.readTextFile(serial!.env![SKIP_LIST_VARIABLE]!)),
    ).toEqual({ "packages/bakery/test/proof.serial.test.ts": ["rises"] });
  });

  it("refuses a member whose serial glob names no file", async () => {
    // Such a glob is a file renamed from under the task, which would
    // otherwise run beside the rest under `--parallel`.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: "deno run --allow-read " +
            "../../tasks/run-sharded-test-files.ts BAKERY_SHARD cli . " +
            "--serial=test/proof.serial.test.ts -- --no-check --parallel",
        },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    await expect(loadUnitSuites(root)).rejects.toThrow(
      "No test file in `./packages/bakery` matches " +
        "`test/proof.serial.test.ts`.",
    );
  });

  it("builds one `deno test` where the files all need the same flags", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: "deno run --allow-read " +
            "../../tasks/run-sharded-test-files.ts BAKERY_SHARD cli . " +
            "--serial='**/*.serial.test.ts' -- --no-check --parallel",
        },
        files: ["test/glaze.test.ts", "test/proof.serial.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const invocations = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir: "/out", spoolDir: "/spool" },
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.command).toContain("--parallel");
  });

  it("declares a browser half whole, since its runner takes no list", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read test/*.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.whole).toEqual(["packages/bakery#browser-test"]);
  });

  it("accounts for the files the browser half's task names", async () => {
    // A member that splits its halves by a name keeps the browser files
    // out of the `deno test` run, and the browser half is one unit
    // whatever it holds. Without saying so, those files would be test
    // files no suite claims, and the drift guard would fail on them.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read --ignore='**/*.browser.test.ts'",
          "browser-test":
            "deno run -A ../deno-web-test/cli.ts **/*.browser.test.ts",
        },
        files: ["test/glaze.test.ts", "test/oven.browser.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toContain("packages/bakery/test/glaze.test.ts");
    expect(suite.units).not.toContain(
      "packages/bakery/test/oven.browser.test.ts",
    );
    expect(suite.sources).toEqual([
      "packages/bakery/test/oven.browser.test.ts",
    ]);
  });

  it("leaves out a file neither half of a split member runs", async () => {
    // A task naming its own paths passes over everything outside them,
    // and what it passes over is not what the browser half runs, so a
    // file outside both halves' paths is claimed by neither.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test":
            "deno test --allow-read --ignore='**/*.browser.test.ts' test",
          "browser-test":
            "deno run -A ../deno-web-test/cli.ts **/*.browser.test.ts",
        },
        files: [
          "test/glaze.test.ts",
          "test/oven.browser.test.ts",
          "integration/proof.test.ts",
        ],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).not.toContain(
      "packages/bakery/integration/proof.test.ts",
    );
    expect(suite.sources).toEqual([
      "packages/bakery/test/oven.browser.test.ts",
    ]);
  });

  it("throws for a browser half whose task names no files it can read", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read --ignore='**/*.browser.test.ts'",
          "browser-test": "deno run -A ../deno-web-test/cli.ts",
        },
        files: ["test/glaze.test.ts", "test/oven.browser.test.ts"],
      },
    });
    await expect(loadUnitSuites(root)).rejects.toThrow(
      "`./packages/bakery`'s `browser-test` task names no files the " +
        "topology can read.",
    );
  });

  it("leaves out a file the Deno-only half ignores for another suite", async () => {
    // Another suite runs `integration/`, so the ignore that keeps it out
    // of the `deno test` run does not make it the browser half's.

    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read --ignore='integration' " +
            "--ignore='**/*.browser.test.ts' .",
          "browser-test":
            "deno run -A ../deno-web-test/cli.ts **/*.browser.test.ts",
        },
        files: [
          "test/glaze.test.ts",
          "test/oven.browser.test.ts",
          "integration/proof.test.ts",
        ],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery#browser-test",
    ]);
    expect(suite.sources).toEqual([
      "packages/bakery/test/oven.browser.test.ts",
    ]);
  });

  it("runs the browser half through the task that owns it", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test --allow-read test/*.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outputDir = await Deno.makeTempDir({ prefix: "unit-out-" });
    const made = await suite.command(
      [
        { unit: "packages/bakery#browser-test", skip: [] },
        { unit: "packages/bakery/test/glaze.test.ts", skip: [] },
      ],
      { root, outputDir, coverageDir: "/cov", spoolDir: "/spool" },
    );
    expect(made.length).toBe(2);
    expect(made.some((i) => i.command.includes("browser-test"))).toBe(true);
    // Each member's profiles go somewhere of their own, which is what
    // keeps one measured set's number out of another's.
    expect(made[0]!.env?.DENO_COVERAGE_DIR).toBe("/cov/packages__bakery");
  });

  it("locates a browser record on the half that produced it", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          test: { dependencies: ["deno-test", "browser-test"] },
          "deno-test": "deno test test/glaze.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({ test: { k: "browser", s: "bakery", n: "oven > heats" } }),
    ).toEqual({ level: "unit", unit: "packages/bakery#browser-test" });
  });

  it("gives a member with only a browser half no whole-member unit", async () => {
    // There is no Deno-only task for a `deno task test` to run, so a
    // whole-member unit would dispatch a task that does not exist.
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "browser-test": "deno run -A ../deno-web-test/cli.ts a.test.ts",
        },
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual(["packages/bakery#browser-test"]);
  });

  it("builds nothing for a unit no member holds", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      await suite.command([{ unit: "packages/elsewhere", skip: [] }], {
        root,
        outputDir: "/out",
        spoolDir: "/spool",
      }),
    ).toEqual([]);
  });
});

describe("what the unit suites decline to claim", () => {
  it("declines a record from a scope no member covers", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({ test: { k: "unit", s: "elsewhere", n: "bakes" } }),
    ).toBeUndefined();
  });

  it("declines a record from a member with no Deno-only half", async () => {
    // Its unit-kind records would have nowhere to go: the member runs
    // only a browser half, and that half records under `browser`.
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "browser-test": "deno run -A ../deno-web-test/cli.ts a.test.ts",
        },
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(
      suite.locate({ test: { k: "unit", s: "bakery", n: "bakes" } }),
    ).toBeUndefined();
    expect(
      suite.locate({ test: { k: "browser", s: "bakery", n: "bakes" } }),
    ).toEqual({ level: "unit", unit: "packages/bakery#browser-test" });
  });
});

describe("the measured sets a unit suite declares", () => {
  it("gives a member one set over its own files", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/*.test.ts" },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured).toEqual([{
      member: "packages/bakery",
      reachedBy: ["packages/bakery/"],
      units: [
        "packages/bakery/test/glaze.test.ts",
        "packages/bakery/test/proof.test.ts",
      ],
    }]);
  });

  it("gives a member whose task runs whole a set over that one unit", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno run -A test/run-tests.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root, BAKERY_RUNS_WHOLE));
    expect(suite.measured?.[0]?.units).toEqual(["packages/bakery"]);
  });

  it("covers a member added to the workspace with no other edit", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
      "./packages/cellar": {
        tasks: { test: "deno test test/rack.test.ts" },
        files: ["test/rack.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured?.map((set) => set.member))
      .toEqual(["packages/bakery", "packages/cellar"]);
  });

  it("covers a member at whatever depth it sits", async () => {
    const root = await workspace({
      "./packages/connectors/github": {
        tasks: { test: "deno test test/issue.test.ts" },
        files: ["test/issue.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured?.[0]?.member).toBe("packages/connectors/github");
  });

  it("leaves a nested member's tree out of the outer member's reach", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/shape.test.ts" },
        files: ["test/shape.test.ts"],
      },
      "./packages/bakery/cellar": {
        tasks: { test: "deno test test/rack.test.ts" },
        files: ["test/rack.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const outer = suite.measured?.find((set) =>
      set.member === "packages/bakery"
    );
    expect(outer?.reachedBy).toEqual([
      "packages/bakery/",
      "!packages/bakery/cellar/",
    ]);
  });

  it("leaves a member on the exclusion list without a set", async () => {
    const excluded = [...EXCLUDED_FROM_COVERAGE_GATE.keys()]
      .find((member) => !member.includes("/", "packages/".length))!;
    const root = await workspace({
      [`./${excluded}`]: {
        tasks: { test: "deno test test/one.test.ts" },
        files: ["test/one.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured).toBeUndefined();
  });

  it("leaves a member outside packages/ without a set", async () => {
    const root = await workspace({
      "./tools/bakery": {
        tasks: { test: "deno test test/one.test.ts" },
        files: ["test/one.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured).toBeUndefined();
  });

  it("measures a member's Deno-only half and never its browser unit", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "deno-test": "deno test test/glaze.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
          test: "deno task deno-test && deno task browser-test",
        },
        files: ["test/glaze.test.ts", "oven.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toContain("packages/bakery#browser-test");
    expect(suite.measured?.[0]?.units)
      .toEqual(["packages/bakery/test/glaze.test.ts"]);
  });

  it("leaves a member with only a browser half without a set", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
        },
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.measured).toBeUndefined();
  });
});

describe("where a unit suite writes its coverage profiles", () => {
  it("names a directory for the member, under the batch's directory", async () => {
    const root = await workspace({
      "./packages/connectors/github": {
        tasks: { test: "deno test test/issue.test.ts" },
        files: ["test/issue.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const [invocation] = await suite.command(
      [{ unit: "packages/connectors/github/test/issue.test.ts", skip: [] }],
      {
        root,
        outputDir: "/out",
        spoolDir: "/spool",
        coverageDir: "/cov",
      },
    );
    expect(invocation?.env?.DENO_COVERAGE_DIR)
      .toBe("/cov/packages__connectors__github");
  });

  it("writes nothing for a member the run is not measuring", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      {
        root,
        outputDir: "/out",
        spoolDir: "/spool",
        coverageDir: "/cov",
        measuredMembers: new Set(["packages/cellar"]),
      },
    );
    expect(invocation?.env?.DENO_COVERAGE_DIR).toBeUndefined();
  });

  it("keeps the browser half out of the member's measured directory", async () => {
    // The browser unit is not one of the set's units, so what it reached
    // must not move the set's number: a lane that happened to select it
    // would otherwise measure something a lane that did not would miss.
    const root = await workspace({
      "./packages/bakery": {
        tasks: {
          "deno-test": "deno test test/glaze.test.ts",
          "browser-test": "deno run -A ../deno-web-test/cli.ts oven.test.ts",
          test: "deno task deno-test && deno task browser-test",
        },
        files: ["test/glaze.test.ts", "oven.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const made = await suite.command(
      [
        { unit: "packages/bakery/test/glaze.test.ts", skip: [] },
        { unit: "packages/bakery#browser-test", skip: [] },
      ],
      { root, outputDir: "/out", spoolDir: "/spool", coverageDir: "/cov" },
    );
    const browser = made.find((one) => one.command.includes("browser-test"))!;
    const deno = made.find((one) => !one.command.includes("browser-test"))!;
    expect(deno.env?.DENO_COVERAGE_DIR).toBe("/cov/packages__bakery");
    expect(browser.env?.DENO_COVERAGE_DIR).toBeUndefined();
  });

  it("writes nothing at all where the batch is not being measured", async () => {
    const root = await workspace({
      "./packages/bakery": {
        tasks: { test: "deno test test/glaze.test.ts" },
        files: ["test/glaze.test.ts"],
      },
    });
    const suite = workspaceUnit(await loadUnitSuites(root));
    const [invocation] = await suite.command(
      [{ unit: "packages/bakery/test/glaze.test.ts", skip: [] }],
      { root, outputDir: "/out", spoolDir: "/spool" },
    );
    expect(invocation?.env?.DENO_COVERAGE_DIR).toBeUndefined();
  });
});

describe("a member whose tests a lane cannot hand a file list", () => {
  /** A member whose Deno-only half is the task given. */
  function bakery(denoTest: string) {
    return {
      "./packages/bakery": {
        tasks: {
          test: "deno run -A ../../tasks/run-member-tests.ts deno-test",
          "deno-test": denoTest,
        },
        files: ["test/glaze.test.ts", "test/proof.test.ts"],
      },
    };
  }

  /** What loading throws for the fixture member when it is not listed. */
  const UNLISTED = "A lane cannot hand `./packages/bakery`'s tests a file " +
    "list, so it would run the member whole";

  it("throws for one naming its own import map, where nothing records it", async () => {
    // Run whole, the member's tests would run in a lane with no preload and
    // no report path, so they would pass there and record nothing.

    const root = await workspace(
      bakery("deno test -A --import-map ./test-map.json ."),
    );
    await expect(loadUnitSuites(root)).rejects.toThrow(UNLISTED);
  });

  it("throws for one joining commands, where nothing records it", async () => {
    const root = await workspace(bakery("(deno test -A .) && deno check ."));
    await expect(loadUnitSuites(root)).rejects.toThrow(UNLISTED);
  });

  it("throws for a runner of the member's own, where nothing records it", async () => {
    // What the runner starts is out of the lane's sight, so whether it
    // records anything is for the entry's reason to answer.

    const root = await workspace(bakery("deno run -A test/run-tests.ts"));
    await expect(loadUnitSuites(root)).rejects.toThrow(UNLISTED);
  });

  it("reads the same tests a file at a time without the import map", async () => {
    const root = await workspace(bakery("deno test -A ."));
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([
      "packages/bakery/test/glaze.test.ts",
      "packages/bakery/test/proof.test.ts",
    ]);
    expect(suite.whole).toEqual([]);
  });

  it("gives no unit to one whose task reaches no test file", async () => {
    // Its task is one a lane can hand a file list, so nothing about it runs
    // whole. A unit for it would run the task with no preload and no report
    // path.

    const root = await workspace(bakery("deno test -A test/missing.test.ts"));
    const suite = workspaceUnit(await loadUnitSuites(root));
    expect(suite.units).toEqual([]);
    expect(suite.whole).toEqual([]);
    expect(suite.measured).toBeUndefined();
  });

  it("runs one whole where the list allows it", async () => {
    const root = await workspace(
      bakery("deno test -A --import-map ./test-map.json ."),
    );
    const suite = workspaceUnit(
      await loadUnitSuites(root, BAKERY_RUNS_WHOLE),
    );
    expect(suite.units).toEqual(["packages/bakery"]);
    expect(suite.whole).toEqual(["packages/bakery"]);
  });

  it("throws for a listed member whose tests a lane can read", async () => {
    const root = await workspace(bakery("deno test -A ."));
    await expect(loadUnitSuites(root, BAKERY_RUNS_WHOLE)).rejects.toThrow(
      "`./packages/bakery` is listed in `RUNS_WHOLE`, and a lane can hand " +
        "its tests a file list.",
    );
  });

  it("throws for a listed member the workspace does not hold", async () => {
    const root = await workspace(bakery("deno test -A ."));
    await expect(
      loadUnitSuites(
        root,
        new Map([["./packages/pantry", "its tests need the map"]]),
      ),
    ).rejects.toThrow(
      "`RUNS_WHOLE` lists members the workspace does not hold: " +
        "`./packages/pantry`.",
    );
  });
});
