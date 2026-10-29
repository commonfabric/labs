import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import {
  FRAGMENT_PREFIX,
  parseRecordLine,
  RECORDS_DIR_VARIABLE,
} from "@commonfabric/test-support/records";
import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { HarnessRun, runDenoWebTest } from "./utils.ts";

// Runs the success project with a spool of this test's own rather than the
// empty one a fixture run is usually given, and returns the run and every
// line of every record fragment it left in that spool.
async function spooledBy(
  inRepository: boolean,
): Promise<{ run: HarnessRun; lines: string[] }> {
  const spool = await Deno.makeTempDir({ prefix: "deno-web-test-spool-" });
  try {
    const run = await runDenoWebTest(
      "success-project",
      { [RECORDS_DIR_VARIABLE]: spool },
      { inRepository },
    );
    const lines: string[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (!entry.isFile || !entry.name.startsWith(FRAGMENT_PREFIX)) continue;
      const text = await Deno.readTextFile(join(spool, entry.name));
      for (const line of text.split("\n")) {
        if (line.length > 0) lines.push(line);
      }
    }
    run.assert(run.success, "the run passed");
    run.assert(
      /ok \| 2 passed/.test(run.stdoutText),
      "the run ran the project's tests",
    );
    return { run, lines };
  } finally {
    await removeDirectory(spool);
  }
}

describe("runner", () => {
  it("spools a record per test of a project inside a repository", async () => {
    const { run, lines } = await spooledBy(true);
    const records = lines.flatMap((line) => parseRecordLine(line) ?? []);
    run.assert(
      records.length === 2 && lines.length === 2,
      `the spool holds ${lines.length} line(s): ${lines.join("\n")}`,
    );
    run.assert(
      records.every((record) =>
        record.test.k === "browser" &&
        record.file === "success-project/add.test.ts"
      ),
      `the records name the wrong test or file: ${lines.join("\n")}`,
    );
  });

  it("spools no record for a project inside no repository", async () => {
    const { run, lines } = await spooledBy(false);
    run.assert(
      lines.length === 0,
      `the spool holds ${lines.length} line(s): ${lines.join("\n")}`,
    );
  });
});
