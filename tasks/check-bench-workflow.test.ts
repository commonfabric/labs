/**
 * These pin a gate that fails CI, so it has to be exact in both directions:
 * a file the job stopped running has to fail, and a file named somewhere the
 * job does not run -- a comment, a conditional step -- has to fail too.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  benchWorkflowProblems,
  main,
  namedBenchmarkFiles,
  stepWords,
} from "./check-bench-workflow.ts";
import {
  CALIBRATION_FILE,
  KEY_BENCHMARKS,
} from "../packages/dashboard/bench-report.ts";

/** Helper for the tests below, which builds a workflow around its steps. */
const workflowWith = (steps: string[]): string =>
  ["name: Benchmarks", "jobs:", "  benchmarks:", "    steps:", ...steps, ""]
    .join("\n");

/** Helper for the tests below, which builds a `deno bench` step. */
const benchStep = (files: readonly string[]): string =>
  [
    "      - name: 🏋️ Run benchmarks",
    "        run: |",
    "          deno bench --json -A \\",
    ...files.map((file) => `            ${file} \\`),
    "            > bench-results/results.json",
  ].join("\n");

const checkStep = [
  "      - name: ✅ Validate benchmark results",
  "        run: >",
  "          deno run --allow-read tasks/check-bench-report.ts",
  "          bench-results/results.json",
].join("\n");

const everything = (): string =>
  workflowWith([benchStep(namedBenchmarkFiles()), checkStep]);

const all = () => true;

/** Helper for the tests below, which runs `body` with console output captured. */
function captureConsole(body: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("check-bench-workflow", () => {
  describe("namedBenchmarkFiles()", () => {
    it("returns the calibration file and each key benchmark's file", () => {
      expect([...namedBenchmarkFiles()]).toEqual([
        CALIBRATION_FILE,
        "packages/patterns/integration/topic-board-navigation.bench.ts",
        "packages/patterns/integration/topic-board-scale.bench.ts",
      ]);
    });

    it("returns one entry for two key benchmarks sharing a file", () => {
      // The two key benchmarks are in two files today. Nothing stops them
      // sharing one, and a file named twice would be reported twice.
      const files = namedBenchmarkFiles();
      expect(files.length).toBe(new Set(files).size);
      expect(files.length).toBeLessThanOrEqual(KEY_BENCHMARKS.length + 1);
    });
  });

  describe("stepWords()", () => {
    it("returns the words of a script with its continuations joined", () => {
      expect(stepWords({ run: "deno bench \\\n  one.ts \\\n  two.ts\n" }))
        .toEqual(["deno", "bench", "one.ts", "two.ts"]);
    });

    it("returns no word a comment line carried", () => {
      expect(stepWords({ run: "# see one.ts\ndeno bench two.ts\n" }))
        .toEqual(["deno", "bench", "two.ts"]);
    });

    it("returns `undefined` for a step that runs on a condition", () => {
      expect(stepWords({ run: "deno bench one.ts", if: "always()" }))
        .toBe(undefined);
    });

    it("returns `undefined` for a step that runs no script", () => {
      expect(stepWords({ uses: "actions/checkout@v7" })).toBe(undefined);
      expect(stepWords("- not a step")).toBe(undefined);
      expect(stepWords(null)).toBe(undefined);
    });
  });

  describe("benchWorkflowProblems()", () => {
    it("returns nothing for a job running every named file", () => {
      expect(benchWorkflowProblems(everything(), all)).toEqual([]);
    });

    it("returns the file a job no longer runs", () => {
      const dropped = namedBenchmarkFiles().filter((file) =>
        file !== CALIBRATION_FILE
      );
      const workflow = workflowWith([benchStep(dropped), checkStep]);
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        `${CALIBRATION_FILE}: named by the dashboard, not in the deno bench`,
      ]);
    });

    it("returns every file a job running none of them left out", () => {
      const workflow = workflowWith([benchStep([]), checkStep]);
      expect(benchWorkflowProblems(workflow, all))
        .toHaveLength(namedBenchmarkFiles().length);
    });

    it("returns the file the tree no longer holds", () => {
      const [file] = namedBenchmarkFiles();
      expect(benchWorkflowProblems(everything(), (at) => at !== file)).toEqual([
        `${file}: named by the dashboard, absent from the tree`,
      ]);
    });

    it("returns the file a job names only in a comment", () => {
      const [file] = namedBenchmarkFiles();
      const rest = namedBenchmarkFiles().filter((other) => other !== file);
      const workflow = workflowWith([
        [
          "      - name: 🏋️ Run benchmarks",
          "        run: |",
          `          # ${file} runs near the end`,
          "          deno bench --json -A \\",
          ...rest.map((other) => `            ${other} \\`),
          "            > bench-results/results.json",
        ].join("\n"),
        checkStep,
      ]);
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        `${file}: named by the dashboard, not in the deno bench`,
      ]);
    });

    it("returns the file only a step running on a condition names", () => {
      // A step behind an `if` runs on some runs and not others, so it is not
      // the scheduled job running the benchmark.
      const [file] = namedBenchmarkFiles();
      const rest = namedBenchmarkFiles().filter((other) => other !== file);
      const workflow = workflowWith([
        benchStep(rest),
        [
          "      - name: 🏋️ Run the slow benchmark",
          "        if: github.event_name == 'workflow_dispatch'",
          `        run: deno bench ${file}`,
        ].join("\n"),
        checkStep,
      ]);
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        `${file}: named by the dashboard, not in the deno bench`,
      ]);
    });

    it("returns every file for a workflow with no such job", () => {
      const workflow = [
        "name: Benchmarks",
        "jobs:",
        "  other:",
        "    steps: []",
      ]
        .join("\n");
      expect(benchWorkflowProblems(workflow, all))
        .toHaveLength(namedBenchmarkFiles().length + 1);
    });

    it("returns the report check a job stopped running", () => {
      const workflow = workflowWith([benchStep(namedBenchmarkFiles())]);
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        "tasks/check-bench-report.ts: no step runs it over " +
        "bench-results/results.json",
      ]);
    });

    it("returns the report check a step runs over another file", () => {
      const workflow = workflowWith([
        benchStep(namedBenchmarkFiles()),
        [
          "      - name: ✅ Validate benchmark results",
          "        run: deno run --allow-read tasks/check-bench-report.ts /tmp/x",
        ].join("\n"),
      ]);
      expect(benchWorkflowProblems(workflow, all)).toEqual([
        "tasks/check-bench-report.ts: no step runs it over " +
        "bench-results/results.json",
      ]);
    });
  });

  describe("as a program", () => {
    // The gate's contract with CI is its exit code, which only running it as a
    // program states. It is started through `Deno.execPath()` rather than
    // through `deno` on the PATH, since a coverage profile one Deno version
    // writes cannot be reported by another, and with `--frozen` so that the
    // spawn resolves the checked-in dependency graph rather than a new one.

    it("exits 0 over this repository", async () => {
      const { code, stdout } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--frozen",
          "--allow-read",
          "tasks/check-bench-workflow.ts",
        ],
        cwd: new URL("../", import.meta.url),
        stderr: "null",
      }).output();
      expect(code).toBe(0);
      expect(new TextDecoder().decode(stdout)).toContain("names (3 files)");
    });
  });

  describe("main()", () => {
    it("returns 0 and counts the files for this repository", () => {
      let code = -1;
      const { out, err } = captureConsole(() => {
        code = main();
      });
      expect(code).toBe(0);
      expect(out).toContain("names (3 files)");
      expect(err).toBe("");
    });

    it("returns 1 and names the files for a job running none of them", () => {
      const root = Deno.makeTempDirSync({ prefix: "check-bench-workflow-" });
      Deno.mkdirSync(`${root}/.github/workflows`, { recursive: true });
      Deno.writeTextFileSync(
        `${root}/.github/workflows/benchmarks.yml`,
        workflowWith([benchStep([]), checkStep]),
      );
      let code = -1;
      const { out, err } = captureConsole(() => {
        code = main(`${root}/`);
      });
      Deno.removeSync(root, { recursive: true });
      expect(code).toBe(1);
      expect(out).toBe("");
      for (const file of namedBenchmarkFiles()) expect(err).toContain(file);
    });
  });
});
