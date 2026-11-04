#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Entry point for the root `deno task test`. The implementation lives in
 * workspace-tests.ts because `deno coverage` skips files whose names end in
 * test.ts, and the coverage-debt metric scores an unmeasured file as fully
 * uncovered.
 *
 * This entry point owns the run for test recording: with a personal key
 * present it stamps a spool, points its producers at it, ships it when the
 * run ends, and sweeps for orphans. Inside CI it joins the job's spool
 * instead, and with neither the whole path is inert. Recording never
 * changes the exit status.
 */

import {
  RECORDS_DIR_VARIABLE,
  recordsDir,
} from "@commonfabric/test-support/records";
import { pinShuffleSeed } from "@commonfabric/test-support/shuffle";
import { finishRunRecording, startRunRecording } from "./test-records.ts";
import { main } from "./workspace-tests.ts";

if (import.meta.main) {
  if (Deno.args.length > 0) {
    console.error(
      "The root `test` task takes no arguments, and runs every package's " +
        "tests. To pass flags such as `--filter`, run the task of the " +
        "package holding the test:\n\n" +
        "  cd packages/<package-name>\n" +
        '  deno task test --filter "test name"\n\n' +
        '"Running one test by name" in docs/development/TESTING.md says more.',
    );
    Deno.exit(2);
  }
  // Settled before any member's task starts, so every leaf of this run
  // shuffles the same way.
  pinShuffleSeed();
  const recording = await startRunRecording();
  if (recording.mode === "own" && recordsDir() === undefined) {
    // The producers of this process and every child join the owned run
    // through the inherited environment.
    Deno.env.set(RECORDS_DIR_VARIABLE, recording.spool.dir);
  }
  // The exit happens here rather than inside main(): Deno.exit skips
  // finally blocks, and a failing run's records are the interesting ones.
  let passed = false;
  try {
    passed = await main();
  } finally {
    await finishRunRecording(recording);
  }
  if (!passed) Deno.exit(1);
}
