import { expect } from "@std/expect";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  dropContainerCases,
  parseJUnit,
} from "@commonfabric/test-support/records";
import {
  collectTestFiles,
  mergeJUnitReports,
  runShardedTests,
  runTestBatches,
  selectShardedTestFiles,
} from "./run-sharded-test-files.ts";
import { AGENTS_HOST_TEST_WEIGHTS } from "./test-timing-weights.ts";

const AGENTS_HOST_SHARDS = 5;

/** A directory holding the files a case describes, by name and source. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "sharded-fixture-" });
  for (const [name, source] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, source);
  }
  return dir;
}

/** The names and outcomes of the cases the report at `file` holds. */
async function outcomes(file: string): Promise<Map<string, string>> {
  return new Map(
    dropContainerCases(parseJUnit(await Deno.readTextFile(file)))
      .map((leaf) => [leaf.name, leaf.outcome]),
  );
}

describe("run-sharded-test-files", () => {
  it("collects test modules recursively in stable order", async () => {
    const dir = await Deno.makeTempDir({ prefix: "sharded-tests-" });
    try {
      await Deno.mkdir(`${dir}/nested`);
      await Deno.writeTextFile(`${dir}/z.test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/a_test.ts`, "");
      await Deno.writeTextFile(`${dir}/nested/helper.ts`, "");

      expect(await collectTestFiles(dir)).toEqual([
        "nested/a_test.ts",
        "z.test.ts",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("leaves out what the member excludes, as the topology does", async () => {
    // The runner and the topology have to list the same files. A file only the
    // runner lists runs in the full run but belongs to no unit, so no lane can
    // ask for it.
    const dir = await Deno.makeTempDir({ prefix: "sharded-rule-" });
    try {
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ test: { exclude: ["fixtures/"] } }),
      );
      await Deno.mkdir(`${dir}/fixtures`);
      await Deno.mkdir(`${dir}/node_modules`);
      await Deno.writeTextFile(`${dir}/taken.test.ts`, "");
      await Deno.writeTextFile(`${dir}/fixtures/sample.test.ts`, "");
      await Deno.writeTextFile(`${dir}/passed-test.ts`, "");
      await Deno.writeTextFile(`${dir}/node_modules/vendored.test.ts`, "");

      expect(await collectTestFiles(dir)).toEqual(["taken.test.ts"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("leaves out what the runner's `--ignore` names", async () => {
    const dir = await Deno.makeTempDir({ prefix: "sharded-ignore-" });
    try {
      await Deno.mkdir(`${dir}/fixtures`);
      await Deno.writeTextFile(`${dir}/taken.test.ts`, "");
      await Deno.writeTextFile(`${dir}/fixtures/pattern.test.tsx`, "");
      await Deno.writeTextFile(`${dir}/left.test.ts`, "");

      expect(
        await collectTestFiles(dir, {
          paths: ["."],
          ignores: ["**/*.test.tsx", "left.test.ts"],
        }),
      ).toEqual(["taken.test.ts"]);
      expect(await collectTestFiles(dir)).toEqual([
        "fixtures/pattern.test.tsx",
        "left.test.ts",
        "taken.test.ts",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("runs every file locally when no shard is selected", () => {
    expect(selectShardedTestFiles(
      ["b.test.ts", "a.test.ts"],
      undefined,
      {},
      1,
    )).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("covers every file exactly once across weighted shards", () => {
    const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
    const weights = { "a.test.ts": 10, "b.test.ts": 4 };
    const selected = [1, 2, 3].flatMap((index) =>
      selectShardedTestFiles(files, { index, total: 3 }, weights, 1)
    );

    expect(selected.sort()).toEqual(files);
  });

  it("keeps each of the five heaviest agents-host files on its own shard", async () => {
    const root = path.fromFileUrl(
      new URL("../packages/connectors/agents/host", import.meta.url),
    );
    const files = await collectTestFiles(root);
    const expensiveFiles = Object.entries(AGENTS_HOST_TEST_WEIGHTS)
      .toSorted(([, left], [, right]) => right - left)
      .slice(0, AGENTS_HOST_SHARDS)
      .map(([file]) => file);
    const shards = Array.from(
      { length: AGENTS_HOST_SHARDS },
      (_, offset) =>
        selectShardedTestFiles(
          files,
          { index: offset + 1, total: AGENTS_HOST_SHARDS },
          AGENTS_HOST_TEST_WEIGHTS,
          0.4,
        ),
    );

    expect(expensiveFiles).toHaveLength(AGENTS_HOST_SHARDS);
    expect(shards.flat().toSorted()).toEqual(files.toSorted());
    const placements = expensiveFiles.map((file) => ({
      file,
      shardIndexes: shards.flatMap((shard, index) =>
        shard.includes(file) ? [index] : []
      ),
    }));
    expect(
      placements.filter(({ shardIndexes }) => shardIndexes.length !== 1),
    ).toEqual([]);
    expect(
      new Set(placements.flatMap(({ shardIndexes }) => shardIndexes)).size,
    ).toBe(expensiveFiles.length);
  });

  it("rejects more shards than test files", () => {
    expect(() =>
      selectShardedTestFiles(
        ["a.test.ts"],
        { index: 1, total: Number.MAX_SAFE_INTEGER },
        {},
        1,
      )
    ).toThrow("Shard count 9007199254740991 exceeds test file count 1.");
  });

  describe("mergeJUnitReports()", () => {
    const report = (tests: number, failures: number, body: string) =>
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<testsuites name="deno test" tests="${tests}" failures="${failures}" ` +
      `errors="0" time="0.500">\n${body}</testsuites>\n`;

    it("holds every suite of each report, and sums the root's counts", () => {
      const merged = mergeJUnitReports([
        report(
          1,
          0,
          '<testsuite name="./a.test.ts"><testcase name="a"/></testsuite>\n',
        ),
        report(
          2,
          1,
          '<testsuite name="./b.test.ts"><testcase name="b"/><testcase name="c"><failure/></testcase></testsuite>\n',
        ),
      ]);
      expect(dropContainerCases(parseJUnit(merged)).map((leaf) => leaf.name))
        .toEqual(["a", "b", "c"]);
      expect(merged).toContain(
        '<testsuites name="deno test" tests="3" failures="1" errors="0" ' +
          'time="1.000">',
      );
    });

    it("throws on a report with no root element", () => {
      expect(() => mergeJUnitReports(["<testsuite/>"])).toThrow(
        "Not a JUnit report",
      );
    });
  });

  describe("runTestBatches()", () => {
    it("leaves one report holding every batch's tests", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = `--junit-path=${dir}/report.xml`;
        const code = await runTestBatches([
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/a.test.ts`],
          },
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/b.test.ts`],
          },
        ]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"], ["sets", "pass"]]),
        );
        expect(
          (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort(),
        ).toEqual(["a.test.ts", "b.test.ts", "report.xml"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("runs every batch past a failing one, and returns its code", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("fails on purpose", () => {\n' +
          '  throw new Error("a fixture of runTestBatches() failing");\n' +
          "});\n",
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = `--junit-path=${dir}/report.xml`;
        const code = await runTestBatches([
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/a.test.ts`],
          },
          {
            flags: ["--no-config", "--no-check", junit],
            files: [`${dir}/b.test.ts`],
          },
        ]);
        expect(code).not.toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["fails on purpose", "fail"], ["sets", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("merges the reports where the path is written as two words", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
        "b.test.ts": 'Deno.test("sets", () => {});\n',
      });
      try {
        const junit = ["--junit-path", `${dir}/report.xml`];
        const code = await runTestBatches([
          { flags: ["--no-config", ...junit], files: [`${dir}/a.test.ts`] },
          { flags: ["--no-config", ...junit], files: [`${dir}/b.test.ts`] },
        ]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"], ["sets", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("hands a lone batch the report path as it stands", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("rises", () => {});\n',
      });
      try {
        const code = await runTestBatches([{
          flags: [
            "--no-config",
            "--no-check",
            `--junit-path=${dir}/report.xml`,
          ],
          files: [`${dir}/a.test.ts`],
        }]);
        expect(code).toBe(0);
        expect(await outcomes(`${dir}/report.xml`)).toEqual(
          new Map([["rises", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("runShardedTests()", () => {
    const FILES = {
      "rise.test.ts": 'Deno.test("rises", () => {});\n',
      "proof.serial.test.ts": 'Deno.test("proofs", () => {});\n',
    };

    it("runs every file in its group, and leaves one report", async () => {
      const dir = await fixture(FILES);
      const report = await Deno.makeTempFile({ suffix: ".xml" });
      try {
        const code = await runShardedTests(
          [
            "BAKERY_SHARD",
            "cli",
            ".",
            "--serial=**/*.serial.test.ts",
            "--",
            "--no-config",
            "--parallel",
            `--junit-path=${report}`,
          ],
          dir,
          () => undefined,
        );
        expect(code).toBe(0);
        expect(await outcomes(report)).toEqual(
          new Map([["rises", "pass"], ["proofs", "pass"]]),
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(report);
      }
    });

    it("runs only the files of the shard the variable names", async () => {
      const dir = await fixture(FILES);
      const report = await Deno.makeTempFile({ suffix: ".xml" });
      try {
        const run = (shard: string) =>
          runShardedTests(
            [
              "BAKERY_SHARD",
              "cli",
              ".",
              "--",
              "--no-config",
              `--junit-path=${report}`,
            ],
            dir,
            (variable) => variable === "BAKERY_SHARD" ? shard : undefined,
          );
        expect(await run("1/2")).toBe(0);
        const first = [...(await outcomes(report)).keys()];
        expect(await run("2/2")).toBe(0);
        const second = [...(await outcomes(report)).keys()];
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect([...first, ...second].sort()).toEqual(["proofs", "rises"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(report);
      }
    });

    it("throws naming a glob that matches no test file", async () => {
      const dir = await fixture(FILES);
      try {
        await expect(
          runShardedTests(
            ["X", "cli", ".", "--all-access=oven.test.ts", "--", "--no-config"],
            dir,
            () => undefined,
          ),
        ).rejects.toThrow("No test file matches `oven.test.ts`.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws when the member holds no test file to run", async () => {
      const dir = await fixture({ "helper.ts": "export {};\n" });
      try {
        await expect(
          runShardedTests(["X", "cli", ".", "--"], dir, () => undefined),
        ).rejects.toThrow("No test files selected.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws the usage for a profile it does not know", async () => {
      await expect(
        runShardedTests(["X", "bakery", ".", "--"], ".", () => undefined),
      ).rejects.toThrow("Usage: run-sharded-test-files.ts");
    });
  });
});
