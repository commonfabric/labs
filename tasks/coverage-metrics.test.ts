import { assert, assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  collectCoverageDebtMetrics,
  collectCoverageDebtMetricsFromLcov,
  collectMeasuredSetDebt,
  collectRegressedLines,
  collectSourceFiles,
  collectUncoveredLinesForFiles,
  countTrackedSourceLines,
  countUncoveredProfileLines,
  metricGroupFor,
  parseLcov,
  shouldTrackSourceFile,
  trackedSourceLineNumbers,
} from "./coverage-metrics.ts";
import { normalizeLcovInstancePaths } from "./write-coverage-lcov.ts";

Deno.test("parseLcov accumulates hits per source line", () => {
  const coverage = parseLcov([
    "SF:/repo/packages/example/src/mod.ts",
    "DA:1,1",
    "DA:2,0",
    "DA:2,3",
    "DA:3,0",
    "end_of_record",
  ].join("\n"));

  const file = coverage.get("/repo/packages/example/src/mod.ts");
  assertEquals(file?.lineHits.get(1), 1);
  assertEquals(file?.lineHits.get(2), 3);
  assertEquals(countUncoveredProfileLines(file!), 1);
});

Deno.test("instance-suffix normalization merges records of the same physical file", () => {
  // Deno's coverage emits one record per module INSTANCE — the same file
  // appears plain and as `?testRun=<uuid>` once per cache-busting import.
  // The suffix is stripped at LCOV GENERATION (normalizeLcovInstancePaths,
  // applied by write-coverage-lcov.ts and the local lcovFromCoverageProfile
  // path) so every consumer sees one record set per physical file, and a
  // line counts covered when ANY instance executed it. Without this the debt
  // metric counted the same physical line once per instance that skipped it,
  // flapping with test order and punishing added tests (CT-1861).
  const normalized = normalizeLcovInstancePaths([
    "SF:/repo/packages/example/src/mod.ts",
    "DA:1,1",
    "DA:2,0",
    "end_of_record",
    "SF:/repo/packages/example/src/mod.ts?testRun=aaaa-1111",
    "DA:1,0",
    "DA:2,2",
    "DA:3,0",
    "end_of_record",
    "SF:/repo/packages/example/src/mod.ts?testRun=bbbb-2222",
    "DA:3,0",
    "end_of_record",
  ].join("\n"));
  const coverage = parseLcov(normalized);

  assertEquals(coverage.size, 1);
  const file = coverage.get("/repo/packages/example/src/mod.ts");
  // Line 1 covered by the plain instance, line 2 by testRun aaaa; line 3 by
  // neither — the ONLY genuinely uncovered line.
  assertEquals(file?.lineHits.get(1), 1);
  assertEquals(file?.lineHits.get(2), 2);
  assertEquals(file?.lineHits.get(3), 0);
  assertEquals(countUncoveredProfileLines(file!), 1);
});

Deno.test("countTrackedSourceLines ignores blank and comment-only lines", () => {
  assertEquals(
    countTrackedSourceLines([
      "",
      "// comment",
      "const value = 1;",
      "/* block",
      "comment */",
      "export const next = value + 1;",
      "const inline = 2; // comment",
    ].join("\n")),
    3,
  );
});

Deno.test("trackedSourceLineNumbers reports the executable line numbers", () => {
  assertEquals(
    trackedSourceLineNumbers([
      "", // 1
      "// comment", // 2
      "const value = 1;", // 3
      "/* block", // 4
      "comment */", // 5
      "export const next = value + 1;", // 6
      "const inline = 2; // comment", // 7
    ].join("\n")),
    [3, 6, 7],
  );
});

Deno.test("source inventory helpers group tracked files by package", () => {
  assertEquals(shouldTrackSourceFile("packages/runner/src/cell.ts"), true);
  assertEquals(
    shouldTrackSourceFile("packages/runner/test/cell.test.ts"),
    false,
  );
  assertEquals(shouldTrackSourceFile("scripts/start-local-dev.sh"), false);
  assertEquals(shouldTrackSourceFile("scripts/build.ts"), false);
  assertEquals(
    metricGroupFor("packages/runner/src/cell.ts"),
    "packages/runner",
  );
  assertEquals(metricGroupFor("tasks/coverage-check.ts"), "tasks");
});

Deno.test("collectSourceFiles excludes generated and dependency directories", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-source-test-" });
  try {
    const writeSourceFile = async (relativePath: string) => {
      const fullPath = path.join(rootDir, ...relativePath.split("/"));
      await Deno.mkdir(path.dirname(fullPath), { recursive: true });
      await Deno.writeTextFile(fullPath, "export const value = 1;\n");
    };

    await writeSourceFile("packages/example/src/mod.ts");
    await writeSourceFile("packages/example/build/generated.ts");
    await writeSourceFile("packages/example/node_modules/dep/index.ts");
    await writeSourceFile("packages/example/coverage/report.ts");
    await writeSourceFile("packages/example/src/test/helper.ts");
    await writeSourceFile("scripts/build.ts");

    const files = await collectSourceFiles(rootDir);
    assertEquals(
      files.map((file) => file.relativePath),
      ["packages/example/src/mod.ts"],
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectCoverageDebtMetricsFromLcov computes debt from compact reports", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lcov-test-" });
  try {
    const sourcePath = path.join(rootDir, "packages/example/src/mod.ts");
    await Deno.mkdir(path.dirname(sourcePath), { recursive: true });
    await Deno.writeTextFile(
      sourcePath,
      [
        "export const covered = 1;",
        "export const uncovered = 2;",
      ].join("\n"),
    );

    const metrics = await collectCoverageDebtMetricsFromLcov({
      rootDir,
      lcov: [
        `SF:${sourcePath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n"),
    });

    assertEquals(
      metrics.find((metric) =>
        metric.name === "coverage-debt: workspace uncovered lines"
      )?.uncoveredLines,
      1,
    );
    assertEquals(
      metrics.find((metric) =>
        metric.name === "coverage-debt: packages/example uncovered lines"
      )?.uncoveredLines,
      1,
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectCoverageDebtMetrics scores the profiles a directory holds", async () => {
  // The profiles are generated by the Deno running this test, from the working
  // directory this test runs in, which is also the one reporting them: one
  // Deno version cannot read the transpiled sources another cached, and the
  // cache key covers the configuration in scope where a file was compiled.
  const rootDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "coverage-profile-dir-" }),
  );
  try {
    const sourceDir = path.join(rootDir, "packages", "example", "src");
    await Deno.mkdir(sourceDir, { recursive: true });
    await Deno.writeTextFile(
      path.join(sourceDir, "mod.ts"),
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const testPath = path.join(rootDir, "sample.test.ts");
    await Deno.writeTextFile(
      testPath,
      [
        'import { add } from "./packages/example/src/mod.ts";',
        'Deno.test("add", () => {',
        '  if (add(1, 2) !== 3) throw new Error("wrong");',
        "});",
        "",
      ].join("\n"),
    );
    const coverageProfileDir = path.join(rootDir, "raw");
    const generated = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--no-check",
        "--no-lock",
        `--coverage=${coverageProfileDir}`,
        testPath,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    assert(generated.success, "generating the sample coverage profile failed");

    expect(await collectCoverageDebtMetrics({ rootDir, coverageProfileDir }))
      .toEqual([
        {
          name: "coverage-debt: workspace uncovered lines",
          uncoveredLines: 0,
        },
        {
          name: "coverage-debt: packages/example uncovered lines",
          uncoveredLines: 0,
        },
      ]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("a file that compiles to nothing carries no debt", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-types-test-" });
  try {
    const writeSourceFile = async (relativePath: string, content: string) => {
      const fullPath = path.join(rootDir, ...relativePath.split("/"));
      await Deno.mkdir(path.dirname(fullPath), { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    };

    // Declarations only: no statement to run, so no test could cover a line of
    // it, and Deno's coverage reports no record for it either way.
    await writeSourceFile(
      "packages/example/src/types.ts",
      [
        "export interface Shape {",
        "  sides: number;",
        "}",
        "export type Either = Shape | number;",
      ].join("\n"),
    );
    // Real code no test loaded: charged in full.
    await writeSourceFile(
      "packages/example/src/untested.ts",
      ["export function untested() {", "  return 1;", "}"].join("\n"),
    );

    const metrics = await collectCoverageDebtMetricsFromLcov({
      rootDir,
      lcov: "",
    });

    expect(
      metrics.find((metric) =>
        metric.name === "coverage-debt: packages/example uncovered lines"
      )?.uncoveredLines,
    ).toBe(3);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("a file that opts out of coverage carries no debt", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-ignore-test-" });
  try {
    const writeSourceFile = async (relativePath: string, content: string) => {
      const fullPath = path.join(rootDir, ...relativePath.split("/"));
      await Deno.mkdir(path.dirname(fullPath), { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    };

    // Opted out on the first line, which is where Deno reads the comment, with
    // a reason after the directive: no test loaded it, and it owes nothing.
    await writeSourceFile(
      "packages/example/src/browser-only.js",
      [
        "// deno-coverage-ignore-file -- runs only in a browser",
        "// @ts-check",
        "export function browserOnly() {",
        "  return 1;",
        "}",
      ].join("\n"),
    );
    // Opted out on the line after a shebang, the other line Deno reads it
    // from.
    await writeSourceFile(
      "packages/example/src/script.ts",
      [
        "#!/usr/bin/env -S deno run",
        "// deno-coverage-ignore-file",
        "export function script() {",
        "  return 1;",
        "}",
      ].join("\n"),
    );
    // The same comment on any later line is one Deno does not read, so the
    // file stays charged in full, as it would stay in Deno's report.
    await writeSourceFile(
      "packages/example/src/late-comment.ts",
      [
        "// @ts-check",
        "// deno-coverage-ignore-file",
        "export function late() {",
        "  return 1;",
        "}",
      ].join("\n"),
    );

    const metrics = await collectCoverageDebtMetricsFromLcov({
      rootDir,
      lcov: "",
    });

    // Comment lines are not tracked, so the charged file owes its three lines
    // of code.
    expect(
      metrics.find((metric) =>
        metric.name === "coverage-debt: packages/example uncovered lines"
      )?.uncoveredLines,
    ).toBe(3);

    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: "",
      files: [
        "packages/example/src/browser-only.js",
        "packages/example/src/script.ts",
        "packages/example/src/late-comment.ts",
      ],
    });
    expect(uncovered.has("packages/example/src/browser-only.js")).toBe(false);
    expect(uncovered.has("packages/example/src/script.ts")).toBe(false);
    expect(uncovered.get("packages/example/src/late-comment.ts")?.length).toBe(
      3,
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("integration pattern coverage feeds the debt metric", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-fold-test-" });
  try {
    const sourcePath = path.join(rootDir, "packages/patterns/main.tsx");
    await Deno.mkdir(path.dirname(sourcePath), { recursive: true });
    await Deno.writeTextFile(
      sourcePath,
      [
        "export const a = 1;",
        "export const b = 2;",
        "export const c = 3;",
      ].join("\n"),
    );

    const metricFor = async (lcov: string) =>
      (await collectCoverageDebtMetricsFromLcov({ rootDir, lcov })).find(
        (metric) =>
          metric.name === "coverage-debt: packages/patterns uncovered lines",
      )?.uncoveredLines;

    // No record: every tracked line is uncovered.
    assertEquals(await metricFor(""), 3);

    // A record from the integration stream is scored like any other: its
    // covered lines leave the debt and its unhit lines stay in it. Nothing
    // discriminates on the test name, so a line only an end-to-end flow
    // exercises lowers the gated number.
    assertEquals(
      await metricFor([
        "TN:pattern-runtime-integration",
        `SF:${sourcePath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n")),
      1,
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles resolves lines only for requested files", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const coveredPath = path.join(rootDir, "packages/example/src/covered.ts");
    const untestedPath = path.join(rootDir, "packages/example/src/untested.ts");
    const otherPath = path.join(rootDir, "packages/example/src/other.ts");
    await Deno.mkdir(path.dirname(coveredPath), { recursive: true });
    await Deno.writeTextFile(
      coveredPath,
      [
        "export const covered = 1;",
        "export const uncovered = 2;",
      ].join("\n"),
    );
    // Never appears in the LCOV report, so every tracked line is uncovered.
    await Deno.writeTextFile(untestedPath, "export const neverRun = 3;\n");
    // Not requested, so it should not be read or returned.
    await Deno.writeTextFile(otherPath, "export const ignored = 4;\n");

    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: [
        `SF:${coveredPath}`,
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
      ].join("\n"),
      files: [
        "packages/example/src/covered.ts",
        "packages/example/src/untested.ts",
        "scripts/build.ts",
        // A test file is not tracked source, so it is skipped.
        "packages/example/src/covered.test.ts",
      ],
    });

    // Covered file: only the zero-hit line.
    assertEquals(uncovered.get("packages/example/src/covered.ts"), [2]);
    // Absent from the report: every tracked line is uncovered.
    assertEquals(uncovered.get("packages/example/src/untested.ts"), [1]);
    // Untracked and unrequested files are absent.
    assertEquals(uncovered.has("scripts/build.ts"), false);
    assertEquals(uncovered.has("packages/example/src/covered.test.ts"), false);
    assertEquals(uncovered.has("packages/example/src/other.ts"), false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles reports no lines for a file that compiles to nothing", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const typesPath = path.join(rootDir, "packages/example/src/types.ts");
    await Deno.mkdir(path.dirname(typesPath), { recursive: true });
    await Deno.writeTextFile(
      typesPath,
      ["export interface Shape {", "  sides: number;", "}"].join("\n"),
    );

    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: "",
      files: ["packages/example/src/types.ts"],
    });

    expect(uncovered.size).toBe(0);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles skips a deleted file (absent from checkout)", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    const uncovered = await collectUncoveredLinesForFiles({
      rootDir,
      lcov: "",
      // Tracked source path with no file on disk — i.e. deleted by the PR.
      files: ["packages/example/src/deleted.ts"],
    });
    assertEquals(uncovered.size, 0);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectUncoveredLinesForFiles surfaces non-NotFound read failures", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-lines-test-" });
  try {
    // A directory at a tracked source path makes readTextFile fail with a
    // non-NotFound error, which must propagate rather than be swallowed.
    const trackedPath = path.join(rootDir, "packages/example/src/mod.ts");
    await Deno.mkdir(trackedPath, { recursive: true });

    await assertRejects(() =>
      collectUncoveredLinesForFiles({
        rootDir,
        lcov: "",
        files: ["packages/example/src/mod.ts"],
      })
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectRegressedLines names lines the baseline covered and this run did not", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const flakyPath = path.join(rootDir, "packages/example/src/flaky.ts");
    const steadyPath = path.join(rootDir, "packages/example/src/steady.ts");
    const debtPath = path.join(rootDir, "packages/example/src/debt.ts");
    await Deno.mkdir(path.dirname(flakyPath), { recursive: true });
    await Deno.writeTextFile(
      flakyPath,
      [
        "export const one = 1;",
        "export const two = 2;",
        "export const three = 3;",
      ].join("\n"),
    );
    await Deno.writeTextFile(steadyPath, "export const steady = 1;\n");
    // Uncovered in both runs: existing debt, not something this run lost.
    await Deno.writeTextFile(debtPath, "export const owed = 1;\n");

    const report = (flakyHits: string[]) =>
      [
        `SF:${flakyPath}`,
        ...flakyHits,
        "end_of_record",
        `SF:${steadyPath}`,
        "DA:1,1",
        "end_of_record",
        `SF:${debtPath}`,
        "DA:1,0",
        "end_of_record",
      ].join("\n");

    const regressed = await collectRegressedLines({
      rootDir,
      // Line 2 covered before and not now; line 3 uncovered in both.
      lcov: report(["DA:1,1", "DA:2,0", "DA:3,0"]),
      baselineLcov: report(["DA:1,1", "DA:2,4", "DA:3,0"]),
      groups: new Set(["packages/example"]),
      changedFiles: new Set(),
    });

    // Only the line that moved: the file uncovered in both runs is not one
    // this run regressed, and the file covered in both has nothing to report.
    assertEquals(regressed, [{
      relativePath: "packages/example/src/flaky.ts",
      metricGroup: "packages/example",
      lines: [2],
    }]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectRegressedLines skips changed files and other groups", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const changedPath = path.join(rootDir, "packages/example/src/changed.ts");
    const otherPath = path.join(rootDir, "packages/other/src/mod.ts");
    await Deno.mkdir(path.dirname(changedPath), { recursive: true });
    await Deno.mkdir(path.dirname(otherPath), { recursive: true });
    await Deno.writeTextFile(changedPath, "export const changed = 1;\n");
    await Deno.writeTextFile(otherPath, "export const other = 1;\n");

    const regressed = await collectRegressedLines({
      rootDir,
      lcov: [
        `SF:${changedPath}`,
        "DA:1,0",
        "end_of_record",
        `SF:${otherPath}`,
        "DA:1,0",
        "end_of_record",
      ].join("\n"),
      baselineLcov: [
        `SF:${changedPath}`,
        "DA:1,2",
        "end_of_record",
        `SF:${otherPath}`,
        "DA:1,2",
        "end_of_record",
      ].join("\n"),
      // A file the PR changed has line numbers that moved between the two
      // checkouts, and a group the PR did not regress is not being explained.
      groups: new Set(["packages/example"]),
      changedFiles: new Set(["packages/example/src/changed.ts"]),
    });

    assertEquals(regressed, []);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("collectRegressedLines counts a file the baseline reported and this run did not", async () => {
  const rootDir = await Deno.makeTempDir({
    prefix: "coverage-regressed-test-",
  });
  try {
    const droppedPath = path.join(rootDir, "packages/example/src/dropped.ts");
    await Deno.mkdir(path.dirname(droppedPath), { recursive: true });
    await Deno.writeTextFile(
      droppedPath,
      ["export const first = 1;", "export const second = 2;"].join("\n"),
    );

    const regressed = await collectRegressedLines({
      rootDir,
      // No record at all: a file no job loaded this time owes every tracked
      // line, the same rule the debt metric charges it by.
      lcov: "",
      baselineLcov: [
        `SF:${droppedPath}`,
        "DA:1,1",
        "DA:2,1",
        "end_of_record",
      ].join("\n"),
      groups: new Set(["packages/example"]),
      changedFiles: new Set(),
    });

    assertEquals(regressed, [{
      relativePath: "packages/example/src/dropped.ts",
      metricGroup: "packages/example",
      lines: [1, 2],
    }]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

/**
 * Runs `body` over a tree holding one file of `lines` statements under
 * each named member, and removes the tree afterwards.
 */
async function withMembers(
  members: readonly string[],
  body: (rootDir: string) => Promise<void>,
  lines = 4,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "measured-set-" });
  for (const member of members) {
    const dir = path.join(rootDir, member, "src");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      path.join(dir, "main.ts"),
      `${
        Array.from({ length: lines }, (_, at) => `const v${at} = ${at};`)
          .join("\n")
      }\n`,
    );
  }
  try {
    await body(rootDir);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
}

/** An LCOV record covering the first `covered` lines of one file. */
function lcovFor(file: string, lines: number, covered: number): string {
  const records = Array.from(
    { length: lines },
    (_, at) => `DA:${at + 1},${at < covered ? 1 : 0}`,
  );
  return `SF:${file}\n${records.join("\n")}\nend_of_record\n`;
}

Deno.test("collectMeasuredSetDebt counts only the member's own lines", async () => {
  await withMembers([
    "packages/bakery",
    "packages/cellar",
  ], async (rootDir) => {
    const bakery = path.join(rootDir, "packages/bakery/src/main.ts");
    const cellar = path.join(rootDir, "packages/cellar/src/main.ts");
    // The set's tests covered lines in both members. Only the member the
    // set is scored over is counted, so what the tests reached elsewhere
    // cannot pay another set's debt down.
    const lcov = lcovFor(bakery, 4, 1) + lcovFor(cellar, 4, 4);
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov,
        member: "packages/bakery",
        members: ["packages/bakery", "packages/cellar"],
      })).uncoveredLines,
      3,
    );
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: "",
        member: "packages/cellar",
        members: ["packages/bakery", "packages/cellar"],
      })).uncoveredLines,
      4,
    );
  });
});

Deno.test("collectMeasuredSetDebt charges a nested member to itself", async () => {
  await withMembers([
    "packages/bakery",
    "packages/bakery/cellar",
  ], async (rootDir) => {
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: "",
        member: "packages/bakery",
        members: ["packages/bakery", "packages/bakery/cellar"],
      })).uncoveredLines,
      4,
    );
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: "",
        member: "packages/bakery/cellar",
        members: ["packages/bakery", "packages/bakery/cellar"],
      })).uncoveredLines,
      4,
    );
  });
});

Deno.test("collectMeasuredSetDebt charges a file no test loaded in full", async () => {
  await withMembers(["packages/bakery"], async (rootDir) => {
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: "",
        member: "packages/bakery",
        members: ["packages/bakery"],
      })).uncoveredLines,
      4,
    );
  });
});

Deno.test("collectMeasuredSetDebt refuses a member with no tree", async () => {
  await withMembers(["packages/bakery"], async (rootDir) => {
    // Scoring it as nothing uncovered would pass a gate over a name that
    // measures nothing, which a count of zero cannot be told apart from.
    await assertRejects(
      () =>
        collectMeasuredSetDebt({
          rootDir,
          lcov: "",
          member: "packages/nowhere",
          members: ["packages/bakery"],
        }),
      Error,
      "no directory for the workspace member packages/nowhere",
    );
  });
});

Deno.test("collectMeasuredSetDebt reads a record with no line as none at all", async () => {
  await withMembers(["packages/bakery"], async (rootDir) => {
    // Such a record says nothing about the file, so counting it as
    // measured would let the gate score a report that measured nothing.
    const bakery = path.join(rootDir, "packages/bakery/src/main.ts");
    const measured = await collectMeasuredSetDebt({
      rootDir,
      lcov: `SF:${bakery}\nend_of_record\n`,
      member: "packages/bakery",
      members: ["packages/bakery"],
    });
    assertEquals(measured.files, 0);
    assertEquals(measured.uncoveredLines, 4);
  });
});

Deno.test("collectMeasuredSetDebt counts the files the report named", async () => {
  await withMembers(["packages/bakery"], async (rootDir) => {
    const bakery = path.join(rootDir, "packages/bakery/src/main.ts");
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: lcovFor(bakery, 4, 1),
        member: "packages/bakery",
        members: ["packages/bakery"],
      })).files,
      1,
    );
    // An empty report names none of them, which says the measurement
    // produced nothing rather than that it covered nothing.
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov: "",
        member: "packages/bakery",
        members: ["packages/bakery"],
      })).files,
      0,
    );
  });
});

Deno.test("a measured set and its source group are two readings of one report", async () => {
  await withMembers([
    "packages/bakery",
    "packages/cellar",
  ], async (rootDir) => {
    const bakery = path.join(rootDir, "packages/bakery/src/main.ts");
    const lcov = lcovFor(bakery, 4, 2);
    // The group counts every member's lines the report speaks for; the set
    // counts one member's. Neither is the other, which is why they are
    // published under different names.
    const group = (await collectCoverageDebtMetricsFromLcov({ rootDir, lcov }))
      .find((metric) => metric.name.includes("packages/bakery"));
    assertEquals(group?.uncoveredLines, 2);
    assertEquals(
      (await collectMeasuredSetDebt({
        rootDir,
        lcov,
        member: "packages/cellar",
        members: ["packages/bakery", "packages/cellar"],
      })).uncoveredLines,
      4,
    );
  });
});
