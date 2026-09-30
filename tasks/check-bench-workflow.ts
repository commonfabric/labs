/**
 * Holds the Benchmarks workflow to what the dashboard reads it for: running
 * every benchmark file the dashboard names, and checking the report it
 * uploads.
 *
 * Two of the dashboard's numbers rest on a benchmark named outright -- the
 * machine factor it divides out of every trend, and the two series the key
 * benchmarks tile trends -- and what catches a name that has stopped reaching
 * one is the check over the report. A workflow that runs neither the
 * benchmark nor the check says nothing at all, and the run that would have
 * said it is four hours away, so both are worth settling at review time.
 *
 * The workflow is parsed and its steps read one at a time, rather than
 * searched as text: a path left behind in a comment, in a step that was
 * replaced, or in one that runs only on a condition is not the scheduled job
 * running it, and a text search cannot tell those from the real thing.
 *
 * This is the half a diff can settle. What a file's benchmarks are called is
 * decided when they run, which is where `packages/dashboard/bench-report.ts`
 * reads it.
 */

import { parse as parseYaml } from "@std/yaml";
import {
  CALIBRATION_FILE,
  KEY_BENCHMARKS,
} from "../packages/dashboard/bench-report.ts";

const WORKFLOW = ".github/workflows/benchmarks.yml";
const JOB = "benchmarks";
const REPORT_CHECK = "tasks/check-bench-report.ts";
const REPORT = "bench-results/results.json";

const repoRoot = (): string => new URL("../", import.meta.url).pathname;

/** The files the dashboard names, each once, in the order it names them. */
export function namedBenchmarkFiles(): readonly string[] {
  const files = [
    CALIBRATION_FILE,
    ...KEY_BENCHMARKS.map((key) => key.slice(0, key.indexOf(" > "))),
  ];
  return [...new Set(files)];
}

/**
 * The words one step's script runs, with its line continuations joined and
 * its comments dropped, or nothing where the step runs no script of its own.
 *
 * A step carrying an `if` is passed over. Whether such a step runs is decided
 * when the workflow does, and a check that reads its script is claiming
 * something about every run that it cannot know.
 */
export function stepWords(step: unknown): readonly string[] | undefined {
  if (typeof step !== "object" || step === null) return undefined;
  const { run, if: condition } = step as { run?: unknown; if?: unknown };
  if (typeof run !== "string" || condition !== undefined) return undefined;
  return run
    .replaceAll(/\\\n/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .flatMap((line) => line.split(/\s+/))
    .filter((word) => word !== "");
}

/** Every unconditional step's words, in the order the job runs them. */
function jobSteps(workflow: string): readonly (readonly string[])[] {
  const parsed = parseYaml(workflow) as {
    jobs?: Record<string, { steps?: unknown[] }>;
  };
  const steps = parsed.jobs?.[JOB]?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map(stepWords)
    .filter((words): words is readonly string[] => words !== undefined);
}

/**
 * What the workflow and the tree fail to hold up, one line each, or nothing
 * when they hold it all.
 */
export function benchWorkflowProblems(
  workflow: string,
  exists: (file: string) => boolean,
): readonly string[] {
  const problems: string[] = [];
  const steps = jobSteps(workflow);
  const benching = steps.filter((words) => words.includes("bench"));
  const running = new Set(benching.flatMap((words) => [...words]));
  for (const file of namedBenchmarkFiles()) {
    if (!exists(file)) {
      problems.push(`${file}: named by the dashboard, absent from the tree`);
    }
    if (!running.has(file)) {
      problems.push(`${file}: named by the dashboard, not in the deno bench`);
    }
  }
  const checks = steps.some((words) =>
    words.includes(REPORT_CHECK) && words.includes(REPORT)
  );
  if (!checks) {
    problems.push(`${REPORT_CHECK}: no step runs it over ${REPORT}`);
  }
  return problems;
}

/** Runs the check over `root`, reports, and returns a process code. */
export function main(root: string = repoRoot()): number {
  const workflow = Deno.readTextFileSync(`${root}${WORKFLOW}`);
  const exists = (file: string): boolean => {
    try {
      return Deno.statSync(`${root}${file}`).isFile;
    } catch {
      return false;
    }
  };
  const problems = benchWorkflowProblems(workflow, exists);
  if (problems.length > 0) {
    console.error(
      [
        "",
        `What the ${JOB} job in ${WORKFLOW} does not do that the dashboard`,
        "reads it for:",
        "",
        ...problems.map((problem) => `  ${problem}`),
        "",
        "The names are CALIBRATION_FILE and KEY_BENCHMARKS in",
        "packages/dashboard/bench-report.ts. A benchmark that moved takes its",
        "dashboard history with it, so move the name with the file or leave",
        "the file where it is. See docs/development/BENCHMARKS.md.",
        "",
      ].join("\n"),
    );
    return 1;
  }
  console.log(
    `${WORKFLOW} runs the report check and every benchmark the dashboard ` +
      `names (${namedBenchmarkFiles().length} files).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(main());
