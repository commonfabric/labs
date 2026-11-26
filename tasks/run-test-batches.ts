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

/**
 * Runs each batch as a `deno test` in `cwd`, in turn, and returns the exit
 * code of the first that fails, or zero when none does.
 * A batch that fails does not stop the ones after it, so that a run
 * reports every test it was given.
 */
export async function runTestBatches(
  batches: readonly TestBatch[],
  cwd: string = Deno.cwd(),
): Promise<number> {
  let code = 0;
  for (const batch of batches) {
    const status = await new Deno.Command(Deno.execPath(), {
      args: ["test", ...batch.flags, ...batch.files],
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    if (!status.success && code === 0) code = status.code;
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

if (import.meta.main) Deno.exit(await runMemberBatches(Deno.args, Deno.cwd()));
