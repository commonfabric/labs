import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TestRecord } from "@commonfabric/test-support/records";
import {
  DESCRIBED_FAILURES,
  ERROR_LINES,
  errorExcerpt,
  lastLines,
  passed,
  printSummary,
  type RunSummary,
  shellQuote,
  summaryLines,
  testResults,
  testTitle,
  unitRerun,
} from "./test-summary.ts";

function record(
  name: string,
  outcome: TestRecord["outcome"],
  file?: string,
): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "runner", n: name },
    outcome,
    durationMs: 1,
    ...(file === undefined ? {} : { file }),
  };
}

function summary(fields: Partial<RunSummary>): RunSummary {
  return { tests: [], commands: [], seconds: 1.25, ...fields };
}

describe("test-summary", () => {
  describe("summaryLines()", () => {
    it("says a passing run passed in one line, without its logs", () => {
      const lines = summaryLines(summary({
        tests: [
          { record: record("a", "pass") },
          { record: record("b", "skip") },
        ],
        logs: "/tmp/logs",
      }));

      expect(lines).toEqual(["PASSED: 0 failed, 1 passed, 1 skipped (1.3s)"]);
    });

    it("names what passed without reporting a test, even in a passing run", () => {
      const lines = summaryLines(summary({
        tests: [{ record: record("a", "pass") }],
        unreported: ["cli", "identity"],
      }));

      expect(lines).toEqual([
        "PASSED: 0 failed, 1 passed, 0 skipped (1.3s)",
        "Not counted, because they report no tests: cli, identity",
      ]);
    });

    it("describes each failing test and the logs of a failing run", () => {
      const failing = record("outer > inner", "fail", "packages/runner/a.ts");
      const lines = summaryLines(summary({
        tests: [
          { record: record("a", "pass") },
          {
            record: failing,
            message: "Uncaught Error: broken",
            rerun: "cd packages/runner && deno task test --filter outer",
          },
        ],
        logs: "/tmp/logs",
      }));

      expect(lines).toEqual([
        "FAILED: 1 failed, 1 passed, 0 skipped (1.3s)",
        "",
        "FAIL unit/runner: outer > inner",
        "  file:  packages/runner/a.ts",
        "  rerun: cd packages/runner && deno task test --filter outer",
        "  | Error: broken",
        "",
        "Logs: /tmp/logs",
      ]);
    });

    it("quotes the end of a command that failed with no failing test", () => {
      const output = Array.from({ length: 20 }, (_, i) => `line ${i}`)
        .join("\n");
      const lines = summaryLines(summary({
        commands: [{ label: "shell", output, log: "/tmp/shell.log" }],
      }));

      expect(lines.slice(0, 5)).toEqual([
        "FAILED: 0 failed, 0 passed, 0 skipped, 1 command failed (1.3s)",
        "",
        "FAIL shell: failed with no failing test",
        "  log:   /tmp/shell.log",
        "  | ... 5 earlier lines",
      ]);
      expect(lines.at(-1)).toBe("  | line 19");
    });

    it("counts the failing tests past the ones it describes", () => {
      const tests = Array.from(
        { length: DESCRIBED_FAILURES + 3 },
        (_, i) => ({ record: record(`t${i}`, "fail") }),
      );
      const lines = summaryLines(summary({ tests }));

      expect(lines.filter((line) => line.startsWith("FAIL ")).length)
        .toBe(DESCRIBED_FAILURES);
      expect(lines.at(-1)).toBe(
        "3 more failing tests not described here; the logs name them.",
      );
    });

    it("fails a run whose notes say something kept it from passing", () => {
      const lines = summaryLines(summary({
        tests: [{ record: record("a", "pass") }],
        notes: ["Not started, because a package failed: ./packages/b"],
      }));

      expect(lines).toEqual([
        "FAILED: 0 failed, 1 passed, 0 skipped (1.3s)",
        "",
        "Not started, because a package failed: ./packages/b",
      ]);
    });
  });

  describe("passed()", () => {
    it("returns true only with no failing test, command, or note", () => {
      const pass = { record: record("a", "pass") };

      expect(passed(summary({ tests: [pass] }))).toBe(true);
      expect(passed(summary({ tests: [{ record: record("b", "fail") }] })))
        .toBe(false);
      expect(passed(summary({ commands: [{ label: "x" }] }))).toBe(false);
      expect(passed(summary({ notes: ["x"] }))).toBe(false);
    });
  });

  describe("testTitle()", () => {
    it("names a test by its kind, scope and name", () => {
      expect(testTitle(record("a > b", "fail"))).toBe("unit/runner: a > b");
    });

    it("names the configuration a test ran in where it is not the default", () => {
      const variant = record("a", "fail");
      variant.test.v = "server-execution";

      expect(testTitle(variant)).toBe("unit/runner [server-execution]: a");
    });
  });

  describe("testResults()", () => {
    it("gives a message and a rerun command to failing tests alone", () => {
      const pass = record("a", "pass");
      const fail = record("b", "fail");
      const results = testResults(
        [pass, fail],
        new Map([[fail, "boom"]]),
        (r) => `rerun ${r.test.n}`,
      );

      expect(results).toEqual([
        { record: pass },
        { record: fail, message: "boom", rerun: "rerun b" },
      ]);
    });
  });

  describe("printSummary()", () => {
    it("prints the block under a rule", () => {
      const printed: string[] = [];
      printSummary(summary({}), (line) => printed.push(line));

      expect(printed[1]).toContain("test summary");
      expect(printed[2]).toMatch(/^PASSED/);
    });
  });

  describe("errorExcerpt()", () => {
    it("drops styling, the Uncaught prefix, and repeated blank lines", () => {
      expect(
        errorExcerpt(
          "\n\x1b[31mUncaught AssertionError: Values are not equal.\x1b[0m" +
            "\n\n\n    [Diff] Actual / Expected\n\n",
        ),
      ).toEqual([
        "AssertionError: Values are not equal.",
        "",
        "    [Diff] Actual / Expected",
      ]);
    });

    it("says how many lines it left out of a long error", () => {
      const message = Array.from(
        { length: ERROR_LINES + 4 },
        (_, i) => `${i}`,
      ).join("\n");
      const excerpt = errorExcerpt(message);

      expect(excerpt.length).toBe(ERROR_LINES + 1);
      expect(excerpt.at(-1)).toBe("... 4 more lines");
    });
  });

  describe("lastLines()", () => {
    it("returns short text whole", () => {
      expect(lastLines("a\nb\n", 5)).toEqual(["a", "b"]);
    });

    it("says how many lines it left out", () => {
      expect(lastLines("a\nb\nc\nd", 2)).toEqual([
        "... 2 earlier lines",
        "c",
        "d",
      ]);
    });
  });

  describe("shellQuote()", () => {
    it("leaves a plain word as it is", () => {
      expect(shellQuote("packages/runner")).toBe("packages/runner");
    });

    it("quotes a word holding spaces and apostrophes", () => {
      expect(shellQuote("it's a test")).toBe(`'it'\\''s a test'`);
    });
  });

  describe("unitRerun()", () => {
    it("filters on the outermost describe of a nested test", () => {
      expect(unitRerun("packages/runner", "Cell writes > keeps order"))
        .toBe(
          "cd packages/runner && deno task test --filter 'Cell writes'",
        );
    });

    it("takes a member path as the workspace lists it", () => {
      expect(unitRerun("./packages/runner", "a"))
        .toBe("cd packages/runner && deno task test --filter a");
    });

    it("filters on the whole name of a top-level test", () => {
      expect(unitRerun("tasks", "parses"))
        .toBe("cd tasks && deno task test --filter parses");
    });
  });
});
