#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * Runs a workspace member's test files as the `deno test` runs their flags
 * need.
 *
 *     run-test-batches.ts ROOT [OPTION]... -- FLAGS...
 *
 * `readBatchRunnerArguments()` in the test topology reads those arguments
 * for this runner and for a lane pointed at the same files, so the two agree
 * on which files the member has and which flags each of them runs under.
 * The files a `--serial` or `--all-access` option names run apart from the
 * rest, grouped by `testBatches()` there into one `deno test` for each set
 * of flags. Every glob those options and `--ignore` give has to match a
 * test file of the member, so that a renamed file is reported rather than
 * run under the wrong flags.
 */

import {
  memberTestFiles,
  readBatchRunnerArguments,
  type TestBatch,
  testBatches,
  unmatchedGlobs,
} from "./test-topology/deno-task.ts";

/** The flag that names where `deno test` writes its JUnit report. */
const JUNIT_PATH_FLAG = "--junit-path=";

/**
 * Merges JUnit reports that `deno test` wrote into one report holding every
 * suite of each, in the order given, with the counts and time of the root
 * element summed. Throws on a report with no `testsuites` element, which is
 * not one `deno test` writes.
 */
export function mergeJUnitReports(reports: readonly string[]): string {
  const totals = { tests: 0, failures: 0, errors: 0, time: 0 };
  const suites: string[] = [];
  for (const report of reports) {
    const root = /<testsuites\b([^>]*)>/.exec(report);
    const end = report.lastIndexOf("</testsuites>");
    if (root === null || end < root.index) {
      throw new Error("Not a JUnit report: no `testsuites` element.");
    }
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      const value = new RegExp(`\\b${key}="([^"]*)"`).exec(root[1]!)?.[1];
      totals[key] += Number(value ?? 0);
    }
    suites.push(report.slice(root.index + root[0].length, end));
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="deno test" tests="${totals.tests}" ` +
    `failures="${totals.failures}" errors="${totals.errors}" ` +
    `time="${totals.time.toFixed(3)}">` +
    suites.join("") + "</testsuites>\n";
}

/**
 * Like `flags`, except that a report path written as two words,
 * `--junit-path PATH`, is written as the one word `--junit-path=PATH`.
 */
function joinedReportPath(flags: readonly string[]): string[] {
  const joined: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "--junit-path" && index + 1 < flags.length) {
      joined.push(`${JUNIT_PATH_FLAG}${flags[++index]}`);
    } else {
      joined.push(flag);
    }
  }
  return joined;
}

/**
 * Runs each batch as a `deno test` in `cwd`, in turn, and returns the exit
 * code of the first that fails, or zero when none does.
 * A batch that fails does not stop the ones after it, so that a run
 * reports every test it was given.
 *
 * Every batch is handed the same `--junit-path`, where the flags hold one.
 * With two batches or more, each writes its report beside that path, and
 * once the run ends the reports the batches wrote are merged into it and
 * removed. A batch that stopped before writing one contributes nothing to
 * the merge, which is what its own report would have contributed.
 */
export async function runTestBatches(
  batches: readonly TestBatch[],
  cwd: string = Deno.cwd(),
): Promise<number> {
  let junitPath: string | undefined;
  const reports: string[] = [];
  let code = 0;
  for (const [index, batch] of batches.entries()) {
    const flags = batches.length === 1
      ? batch.flags
      : joinedReportPath(batch.flags).map((flag) => {
        if (!flag.startsWith(JUNIT_PATH_FLAG)) return flag;
        junitPath = flag.slice(JUNIT_PATH_FLAG.length);
        reports.push(`${junitPath}.${index}`);
        return `${JUNIT_PATH_FLAG}${reports.at(-1)}`;
      });
    const status = await new Deno.Command(Deno.execPath(), {
      args: ["test", ...flags, ...batch.files],
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!status.success && code === 0) code = status.code;
  }
  if (junitPath !== undefined) {
    const written: string[] = [];
    for (const report of reports) {
      try {
        written.push(await Deno.readTextFile(report));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      await Deno.remove(report);
    }
    if (written.length > 0) {
      await Deno.writeTextFile(junitPath, mergeJUnitReports(written));
    }
  }
  return code;
}

/**
 * Runs every test file of the member at `memberDir` that the runner's
 * arguments name, and returns the exit code of the first `deno test` that
 * failed, or zero when none did.
 *
 * Throws on arguments it cannot read, on a `--serial`, `--all-access` or
 * `--ignore` glob that names no test file, and on a member holding no test
 * file.
 */
export async function runMemberBatches(
  args: readonly string[],
  memberDir: string,
): Promise<number> {
  const test = readBatchRunnerArguments(args);
  if (test === undefined) {
    throw new Error(
      "Usage: run-test-batches.ts ROOT " +
        "[--serial=GLOBS] [--all-access=GLOBS] -- TEST_FLAGS...",
    );
  }
  const unmatched = await unmatchedGlobs(memberDir, test.paths, [
    ...test.serial,
    ...test.allAccess,
    ...test.ignores,
  ]);
  if (unmatched.length > 0) {
    throw new Error(
      `No test file matches ${
        unmatched.map((glob) => `\`${glob}\``).join(", ")
      }.`,
    );
  }
  const files = await memberTestFiles(memberDir, test);
  if (files.length === 0) throw new Error("No test file to run.");
  return await runTestBatches(testBatches(test, files), memberDir);
}

async function main(): Promise<void> {
  const code = await runMemberBatches(Deno.args, Deno.cwd());
  if (code !== 0) Deno.exit(code);
}

if (import.meta.main) await main();
