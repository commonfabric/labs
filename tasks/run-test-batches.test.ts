import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  dropContainerCases,
  parseJUnit,
} from "@commonfabric/test-support/records";
import {
  mergeJUnitReports,
  runMemberBatches,
  runTestBatches,
} from "./run-test-batches.ts";

/** A directory holding the files a case describes, by name and source. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "batches-fixture-" });
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

describe("run-test-batches", () => {
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

  describe("runMemberBatches()", () => {
    const FILES = {
      "rise.test.ts": 'Deno.test("rises", () => {});\n',
      "proof.serial.test.ts": 'Deno.test("proofs", () => {});\n',
    };

    it("runs every file in its group, and leaves one report", async () => {
      const dir = await fixture(FILES);
      const report = await Deno.makeTempFile({ suffix: ".xml" });
      try {
        const code = await runMemberBatches(
          [
            ".",
            "--serial=**/*.serial.test.ts",
            "--",
            "--no-config",
            "--parallel",
            `--junit-path=${report}`,
          ],
          dir,
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

    it("throws naming a glob that matches no test file", async () => {
      const dir = await fixture(FILES);
      try {
        await expect(
          runMemberBatches(
            [".", "--all-access=oven.test.ts", "--", "--no-config"],
            dir,
          ),
        ).rejects.toThrow("No test file matches `oven.test.ts`.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws when the member holds no test file to run", async () => {
      const dir = await fixture({ "helper.ts": "export {};\n" });
      try {
        await expect(runMemberBatches([".", "--"], dir)).rejects.toThrow(
          "No test file to run.",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws the usage for arguments it cannot read", async () => {
      await expect(runMemberBatches(["."], ".")).rejects.toThrow(
        "Usage: run-test-batches.ts",
      );
    });
  });
});
