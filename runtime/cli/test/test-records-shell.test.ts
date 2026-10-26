/**
 * The shell recording helpers the CLI's integration scripts source, driven
 * through bash the way a script drives them. What they write has to parse
 * as a record line, and a line that does not is one the reader drops
 * without saying why, so the round trip is checked rather than the shape
 * of the printf.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  parseRecordLine,
  type TestRecord,
} from "@commonfabric/test-support/records";

const HELPERS = fromFileUrl(
  new URL("../integration/test-records.sh", import.meta.url),
);

/** Runs a fragment of shell with the helpers sourced, and reads the spool. */
async function recorded(
  script: string,
  options: { recording?: boolean } = {},
): Promise<TestRecord[]> {
  const spool = await Deno.makeTempDir({ prefix: "cli-shell-records-" });
  try {
    const env: Record<string, string> = {};
    if (options.recording !== false) env.CF_TEST_RECORDS_DIR = spool;
    const run = await new Deno.Command("bash", {
      args: ["-c", `set -euo pipefail\nsource ${HELPERS}\n${script}`],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    expect(
      [run.success, new TextDecoder().decode(run.stderr)],
    ).toEqual([true, ""]);
    const records: TestRecord[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (!entry.isFile) continue;
      for (
        const line of (await Deno.readTextFile(join(spool, entry.name)))
          .split("\n")
      ) {
        if (line.length === 0) continue;
        const record = parseRecordLine(line);
        // A line that does not parse is the failure this test exists for,
        // so it is surfaced as the line rather than as a missing record.
        expect([entry.name, record === undefined ? line : "parsed"])
          .toEqual([entry.name, "parsed"]);
        if (record !== undefined) records.push(record);
      }
    }
    return records;
  } finally {
    await Deno.remove(spool, { recursive: true });
  }
}

describe("test-records-shell", () => {
  it("records a script as one test named for it", async () => {
    const records = await recorded(`
      cf_test_record_script "acl.sh"
      true
    `);
    expect(records.map((record) => record.test.n)).toEqual(["acl.sh"]);
    expect(records[0]!.outcome).toBe("pass");
    expect(records[0]!.test.k).toBe("integration");
    expect(records[0]!.test.s).toBe("cli");
  });

  it("names a step for the script it runs inside", async () => {
    const records = await recorded(`
      cf_test_record_script "integration.sh"
      cf_test_step_begin piece-values
      cf_test_step_begin piece-links
    `);
    expect(records.map((record) => record.test.n)).toEqual([
      "integration.sh piece-values",
      "integration.sh piece-links",
      "integration.sh",
    ]);
  });

  it("closes the open step as failed when the script fails", async () => {
    const spool = await Deno.makeTempDir({ prefix: "cli-shell-records-" });
    try {
      await new Deno.Command("bash", {
        args: [
          "-c",
          `set -euo pipefail\nsource ${HELPERS}\n` +
          `cf_test_record_script "integration.sh"\n` +
          `cf_test_step_begin piece-values\nfalse\n`,
        ],
        env: { CF_TEST_RECORDS_DIR: spool },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const outcomes = new Map<string, string>();
      for await (const entry of Deno.readDir(spool)) {
        for (
          const line of (await Deno.readTextFile(join(spool, entry.name)))
            .split("\n")
        ) {
          const record = parseRecordLine(line);
          if (record !== undefined) outcomes.set(record.test.n, record.outcome);
        }
      }
      expect(outcomes.get("integration.sh piece-values")).toBe("fail");
      expect(outcomes.get("integration.sh")).toBe("fail");
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("closes the open step from a script that owns its own exit trap", async () => {
    // The shape fuse-exec.sh uses: it needs its own EXIT trap for the FUSE
    // teardown, so it names itself and closes both records by hand instead of
    // registering cf_test_record_script's trap.

    const records = await recorded(`
      CF_TEST_RECORD_NAME="fuse-exec.sh"
      CF_TEST_RECORD_START_MS=$(cf_test_now_ms)
      cf_test_step_begin "mounted the filesystem"
      cf_test_step_begin "read a callable"
      cf_test_step_close 0
      cf_test_record_with_status 0
    `);
    expect(records.map((record) => record.test.n)).toEqual([
      "fuse-exec.sh mounted the filesystem",
      "fuse-exec.sh read a callable",
      "fuse-exec.sh",
    ]);
    for (const record of records) expect(record.outcome).toBe("pass");
  });

  it("keeps a name that would otherwise tear the line whole", async () => {
    const records = await recorded(`
      CF_TEST_RECORD_NAME="fuse-exec.sh"
      CF_TEST_RECORD_START_MS=$(cf_test_now_ms)
      cf_test_step_begin 'a "quoted" name with a \\ backslash'
      cf_test_step_close 0
    `);
    expect(records.map((record) => record.test.n)).toEqual([
      String.raw`fuse-exec.sh a "quoted" name with a \ backslash`,
    ]);
  });

  it("records nothing at all when recording is off", async () => {
    expect(
      await recorded(
        `
        cf_test_record_script "acl.sh"
        cf_test_step_begin piece-values
      `,
        { recording: false },
      ),
    ).toEqual([]);
  });
});
