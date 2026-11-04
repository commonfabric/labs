/**
 * The block a test run ends with. It says whether the run passed and how
 * many tests passed, failed and were skipped. For each failing test it
 * gives the test's name, its file, a command that runs it again, and the
 * start of its error. For each command that failed without a failing test
 * to explain it, it gives the end of that command's output. It ends with
 * where the full logs are.
 *
 * A passing run's block is one line, and a second naming what ran without
 * reporting any test, where something did.
 *
 * `tasks/workspace-tests.ts`, `tasks/integration.ts` and `tasks/ci-lane.ts`
 * each end with one.
 */

import {
  enclosingNames,
  type TestRecord,
} from "@commonfabric/test-support/records";

/** How many failing tests the block describes. */
export const DESCRIBED_FAILURES = 20;

/** How many lines of a failing test's error the block quotes. */
export const ERROR_LINES = 8;

/** How many lines of a failed command's output the block quotes. */
export const OUTPUT_LINES = 15;

/** A test a run reported, and what the block says about it if it failed. */
export interface TestResult {
  record: TestRecord;

  /** The message the test failed with. */
  message?: string;

  /** A shell command that runs the test again. */
  rerun?: string;
}

/** A command that failed with no failing test to say why. */
export interface FailedCommand {
  /** What failed, such as the package whose tests the command ran. */
  label: string;

  /** How it failed, where there is more to say than that it did. */
  reason?: string;

  /** What it printed, of which the block quotes the end. */
  output?: string;

  /** Where everything it printed is. */
  log?: string;
}

/** Everything the block says. */
export interface RunSummary {
  /** Every test the run reported, whatever its outcome. */
  tests: readonly TestResult[];

  /** Every command that failed without a failing test among `tests`. */
  commands: readonly FailedCommand[];

  /** What ran and passed without reporting any test, so is not counted. */
  unreported?: readonly string[];

  /** Lines saying anything else that kept the run from passing. */
  notes?: readonly string[];

  /** Where the run's full logs are. */
  logs?: string;

  seconds: number;
}

/**
 * The tests a JUnit report's records stand for, each failing one with the
 * message it failed with and a command that runs it again.
 */
export function testResults(
  records: readonly TestRecord[],
  failures: ReadonlyMap<TestRecord, string>,
  rerun: (record: TestRecord) => string | undefined,
): TestResult[] {
  return records.map((record) => {
    if (record.outcome !== "fail") return { record };
    const result: TestResult = { record };
    const message = failures.get(record);
    if (message !== undefined) result.message = message;
    const command = rerun(record);
    if (command !== undefined) result.rerun = command;
    return result;
  });
}

/** Whether a run with this summary passed. */
export function passed(summary: RunSummary): boolean {
  return summary.commands.length === 0 &&
    (summary.notes ?? []).length === 0 &&
    summary.tests.every(({ record }) => record.outcome !== "fail");
}

/** The block's lines. */
export function summaryLines(summary: RunSummary): string[] {
  const count = (outcome: TestRecord["outcome"]) =>
    summary.tests.filter(({ record }) => record.outcome === outcome).length;
  const failing = summary.tests.filter(({ record }) =>
    record.outcome === "fail"
  );
  const counts = [
    `${failing.length} failed`,
    `${count("pass")} passed`,
    `${count("skip")} skipped`,
  ];
  if (summary.commands.length > 0) {
    counts.push(`${plural(summary.commands.length, "command")} failed`);
  }
  const ok = passed(summary);
  const lines = [
    `${ok ? "PASSED" : "FAILED"}: ${counts.join(", ")} ` +
    `(${summary.seconds.toFixed(1)}s)`,
  ];
  const unreported = summary.unreported ?? [];
  if (unreported.length > 0) {
    lines.push(
      `Not counted, because they report no tests: ${unreported.join(", ")}`,
    );
  }
  if (ok) return lines;
  for (const test of failing.slice(0, DESCRIBED_FAILURES)) {
    const { file } = test.record;
    lines.push("", `FAIL ${testTitle(test.record)}`);
    if (file !== undefined) lines.push(`  file:  ${file}`);
    if (test.rerun !== undefined) lines.push(`  rerun: ${test.rerun}`);
    if (test.message !== undefined) {
      quote(lines, errorExcerpt(test.message));
    }
  }
  if (failing.length > DESCRIBED_FAILURES) {
    lines.push(
      "",
      `${plural(failing.length - DESCRIBED_FAILURES, "more failing test")} ` +
        `not described here; the logs name them.`,
    );
  }
  for (const command of summary.commands) {
    lines.push(
      "",
      `FAIL ${command.label}: ${
        command.reason ?? "failed with no failing test"
      }`,
    );
    if (command.log !== undefined) lines.push(`  log:   ${command.log}`);
    if (command.output !== undefined) {
      quote(lines, lastLines(command.output, OUTPUT_LINES));
    }
  }
  const notes = summary.notes ?? [];
  if (notes.length > 0) lines.push("");
  for (const note of notes) lines.push(note);
  if (summary.logs !== undefined) lines.push("", `Logs: ${summary.logs}`);
  return lines;
}

/**
 * A test as the block names it: its kind and scope, the configuration it
 * ran in where that is not the default, and its name.
 */
export function testTitle({ test }: TestRecord): string {
  const variant = test.v === undefined ? "" : ` [${test.v}]`;
  return `${test.k}/${test.s}${variant}: ${test.n}`;
}

/** Prints the block, under a rule that sets it apart from the output above. */
export function printSummary(
  summary: RunSummary,
  print: (line: string) => void = console.log,
): void {
  print("");
  print("=".repeat(24) + " test summary " + "=".repeat(24));
  for (const line of summaryLines(summary)) print(line);
}

/** `count` and `noun`, the noun made plural where the count calls for it. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Appends `quoted` to `lines`, indented and marked as quoted output. */
function quote(lines: string[], quoted: readonly string[]): void {
  for (const line of quoted) lines.push(`  | ${line}`.trimEnd());
}

// Escape sequences that set colors and styles in a terminal.
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** `text` as lines, without terminal styling or blank lines at either end. */
function plainLines(text: string): string[] {
  const lines = text.replace(ANSI, "").split("\n").map((line) =>
    line.trimEnd()
  );
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The first lines of an error message, with runs of blank lines reduced to
 * one, and a line saying how many lines were left out.
 */
export function errorExcerpt(message: string): string[] {
  const lines = plainLines(message).filter((line, index, all) =>
    line !== "" || all[index - 1] !== ""
  );
  if (lines.length > 0) lines[0] = lines[0]!.replace(/^Uncaught /, "");
  if (lines.length <= ERROR_LINES) return lines;
  return [
    ...lines.slice(0, ERROR_LINES),
    `... ${plural(lines.length - ERROR_LINES, "more line")}`,
  ];
}

/** The last `count` lines of `text`, after a line saying how many it left out. */
export function lastLines(text: string, count: number): string[] {
  const lines = plainLines(text);
  if (lines.length <= count) return lines;
  return [
    `... ${plural(lines.length - count, "earlier line")}`,
    ...lines.slice(-count),
  ];
}

/** `word` quoted for a POSIX shell. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * A command that runs a unit test of the workspace member at `member`, a
 * path as the workspace lists it, again. `deno test --filter` selects tests
 * by the name they are registered under, which for a test inside a
 * `describe()` is the outermost `describe()`, so the command runs that
 * whole block.
 */
export function unitRerun(member: string, name: string): string {
  const registered = enclosingNames(name)[0] ?? name;
  return `cd ${shellQuote(member.replace(/^\.\//, ""))} && ` +
    `deno task test --filter ${shellQuote(registered)}`;
}
