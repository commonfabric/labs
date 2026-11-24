/**
 * Covers the shared LCOV reader on the reports that are not a straightforward
 * list of records: coverage for one file spread over several reports, several
 * source paths that map to a single key, records carrying counts that do not
 * parse, and one file recorded by two producers that name different lines of
 * the same statement. Those are the cases where a reader can quietly lose
 * coverage, or invent debt, rather than fail.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
  PATTERN_COVERAGE_MULTI_RUNTIME_TEST_NAME,
  PATTERN_COVERAGE_TEST_NAME,
  PatternCoverageCollector,
  patternCoverageReportToLcov,
} from "@commonfabric/runner";
import {
  addLcovReport,
  type LcovFileCoverage,
  parseLcovReports,
} from "./lcov.ts";

/**
 * A record from Deno's coverage of a statement on lines 3 to 5 that ends
 * with a closing `);` on line 5, which Deno's coverage does not name.
 */
function denoRecord(hits: number): string {
  return ["SF:/repo/a.ts", `DA:3,${hits}`, `DA:4,${hits}`, "end_of_record"]
    .join("\n");
}

/** The pattern runtime's record of the same statement, which names line 5. */
function patternRecord(hits: number, testName = "pattern-runtime"): string {
  return [
    `TN:${testName}`,
    "SF:/repo/a.ts",
    `DA:3,${hits}`,
    `DA:4,${hits}`,
    `DA:5,${hits}`,
    "end_of_record",
  ].join("\n");
}

describe("lcov", () => {
  describe("parseLcovReports()", () => {
    it("sums the hits for a file split across several reports", () => {
      const files = parseLcovReports([
        ["SF:/repo/a.ts", "DA:1,1", "DA:2,0", "end_of_record"].join("\n"),
        ["SF:/repo/a.ts", "DA:1,4", "DA:2,0", "end_of_record"].join("\n"),
      ]);

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      const file = files.get("/repo/a.ts")!;
      expect(file.sourcePath).toBe("/repo/a.ts");
      expect([...file.lineHits]).toEqual([[1, 5], [2, 0]]);
    });

    it("merges the source paths `mapPath` sends to one key", () => {
      const files = parseLcovReports([
        [
          "SF:/runner-a/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "SF:/runner-b/repo/a.ts",
          "DA:2,1",
          "end_of_record",
        ].join("\n"),
      ], { mapPath: (sourcePath) => sourcePath.replace(/^\/runner-[ab]/, "") });

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[1, 1], [2, 1]]);
    });

    it("returns the path carried by the record that opened an entry", () => {
      const files = parseLcovReports([
        [
          "SF:/runner-a/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "SF:/runner-b/repo/a.ts",
          "DA:2,1",
          "end_of_record",
        ].join("\n"),
      ], { mapPath: (sourcePath) => sourcePath.replace(/^\/runner-[ab]/, "") });

      expect(files.get("/repo/a.ts")!.sourcePath).toBe("/runner-a/repo/a.ts");
    });

    it("returns the first test name a file is given", () => {
      const files = parseLcovReports([
        [
          "TN:pattern-runtime-integration",
          "SF:/repo/a.ts",
          "DA:1,1",
          "end_of_record",
          "TN:pattern-runtime",
          "SF:/repo/a.ts",
          "DA:2,1",
          "end_of_record",
          "SF:/repo/b.ts",
          "DA:1,1",
          "end_of_record",
        ].join("\n"),
      ]);

      expect(files.get("/repo/a.ts")!.testName).toBe(
        "pattern-runtime-integration",
      );
      expect(files.get("/repo/b.ts")!.testName).toBeUndefined();
    });

    it("omits records and counts it cannot read", () => {
      const files = parseLcovReports([
        [
          // A `DA:` line outside any record has no file to charge.
          "DA:9,1",
          "SF:/repo/a.ts",
          "FN:1,add",
          "BRDA:2,0,0,1",
          "DA:1.5,1",
          "DA:2,not-a-number",
          "DA:3,7",
          "LF:1",
          "LH:1",
          "end_of_record",
          "DA:9,1",
        ].join("\n"),
      ]);

      expect([...files.keys()]).toEqual(["/repo/a.ts"]);
      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[3, 7]]);
    });

    it("omits records with a blank line number or count", () => {
      const files = parseLcovReports([
        [
          "SF:/repo/a.ts",
          "DA:,0",
          "DA:1,",
          "DA:,",
          "DA: , ",
          "DA:3",
          "DA:4,2",
          "end_of_record",
        ].join("\n"),
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[4, 2]]);
    });

    it("omits records numbering a line at or below zero", () => {
      const files = parseLcovReports([
        [
          "SF:/repo/a.ts",
          "DA:0,5",
          "DA:-1,5",
          "DA:2,5",
          "end_of_record",
        ].join("\n"),
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[2, 5]]);
    });

    it("reads reports with carriage returns", () => {
      const files = parseLcovReports([
        "SF:/repo/a.ts\r\nDA:1,1\r\nend_of_record\r\n",
      ]);

      expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([[1, 1]]);
    });

    describe("a file both Deno's coverage and the pattern instrumentation recorded", () => {
      it("returns only the lines Deno's records name", () => {
        const file = parseLcovReports([patternRecord(0), denoRecord(1)])
          .get("/repo/a.ts")!;

        expect(file.namedByDeno).toBe(true);
        expect([...file.lineHits]).toEqual([[3, 1], [4, 1]]);
        // A reader that looks up each line in turn reads the lines once.
        expect(file.lineHits).toBe(file.lineHits);
      });

      it("returns a statement no test ran as unrun on Deno's lines", () => {
        const files = parseLcovReports([patternRecord(0), denoRecord(0)]);

        expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([
          [3, 0],
          [4, 0],
        ]);
      });

      it("adds the instrumentation's hits to Deno's lines", () => {
        // A statement the pattern tests ran and the Deno tests did not.

        const files = parseLcovReports([denoRecord(0), patternRecord(2)]);

        expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([
          [3, 2],
          [4, 2],
        ]);
      });

      it("returns the same lines whichever report is read first", () => {
        const denoFirst = parseLcovReports([denoRecord(1), patternRecord(0)]);
        const patternFirst = parseLcovReports([
          patternRecord(0),
          denoRecord(1),
        ]);

        expect([...denoFirst.get("/repo/a.ts")!.lineHits]).toEqual([
          ...patternFirst.get("/repo/a.ts")!.lineHits,
        ]);
      });

      it("ignores a record from Deno's coverage that names no line", () => {
        const files = parseLcovReports([
          patternRecord(0),
          "SF:/repo/a.ts\nend_of_record",
        ]);

        expect(files.get("/repo/a.ts")!.namedByDeno).toBe(false);
        expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([
          [3, 0],
          [4, 0],
          [5, 0],
        ]);
      });
    });

    it("returns every line of a file only the pattern instrumentation recorded", () => {
      const file = parseLcovReports([patternRecord(0)]).get("/repo/a.ts")!;

      expect(file.namedByDeno).toBe(false);
      expect([...file.lineHits]).toEqual([[3, 0], [4, 0], [5, 0]]);
    });

    it("reads the records the runner's pattern-coverage writer produces as the instrumentation's", () => {
      // The writer and this reader live in different packages, so this
      // drives one with the other, under every test name the runner writes.

      const collector = new PatternCoverageCollector();
      collector.registerSpan({
        fileName: "/repo/a.ts",
        id: 1,
        kind: "runtime",
        startLine: 3,
        endLine: 5,
        startColumn: 5,
        endColumn: 7,
      });
      for (
        const testName of [
          PATTERN_COVERAGE_TEST_NAME,
          PATTERN_COVERAGE_INTEGRATION_TEST_NAME,
          PATTERN_COVERAGE_MULTI_RUNTIME_TEST_NAME,
        ] as const
      ) {
        const pattern = patternCoverageReportToLcov(
          collector.report(),
          testName,
        );
        expect(pattern).toContain("DA:5,0");

        const files = parseLcovReports([pattern, denoRecord(1)]);

        expect([...files.get("/repo/a.ts")!.lineHits]).toEqual([
          [3, 1],
          [4, 1],
        ]);
      }
    });
  });

  describe("addLcovReport()", () => {
    it("throws on a test name neither producer writes", () => {
      for (
        const testName of ["multi-runtime integration", "pattern-runtimes"]
      ) {
        expect(() => addLcovReport(new Map(), patternRecord(0, testName)))
          .toThrow(`names the test "${testName}"`);
      }
    });

    it("reads an empty test name as none", () => {
      const files = new Map<string, LcovFileCoverage>();
      addLcovReport(files, `TN:\n${denoRecord(1)}`);

      expect(files.get("/repo/a.ts")!.namedByDeno).toBe(true);
    });
  });
});
