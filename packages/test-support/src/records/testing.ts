/**
 * Helpers for testing the producer side of recording. Test use only: the
 * spool they point at is a temporary directory, and the environment variable
 * that names it is restored when the body returns.
 */

import { join } from "@std/path";
import { parseRecordLine, type TestRecord } from "./schema.ts";
import { RECORDS_DIR_VARIABLE } from "./paths.ts";

/**
 * Runs `body` with recording pointed at a fresh spool, and returns every
 * record it left there.
 *
 * This is how a producer's opt-in is pinned: a caller that did not ask for
 * records gets an empty array back even though recording was on for the
 * whole body.
 *
 * A record line the body spooled and the record parser refuses makes it
 * throw. Every reader of the store drops such a line, so a producer that
 * writes one is defective, and a test asserting that nothing was recorded
 * would otherwise pass over it.
 *
 * The variable it sets is the whole process's, so a test file calling this
 * runs alone. Under a runner that puts several test files on threads of one
 * process — `deno test --parallel`, which `packages/cli` runs its tests
 * under — the file belongs among the ones that runner's `--serial` option
 * names.
 */
export async function recordsSpooledBy(
  body: () => Promise<unknown>,
): Promise<TestRecord[]> {
  const dir = await Deno.makeTempDir({ prefix: "test-records-spooled-" });
  const before = Deno.env.get(RECORDS_DIR_VARIABLE);
  Deno.env.set(RECORDS_DIR_VARIABLE, dir);
  try {
    await body();
    const records: TestRecord[] = [];
    const refused: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const text = await Deno.readTextFile(join(dir, entry.name));
      for (const line of text.split("\n")) {
        const record = parseRecordLine(line);
        if (record !== undefined) records.push(record);
        else if (isRecordLine(line)) refused.push(line);
      }
    }
    if (refused.length > 0) {
      throw new Error(
        `spooled record lines that every reader drops:\n${refused.join("\n")}`,
      );
    }
    return records;
  } finally {
    if (before === undefined) {
      Deno.env.delete(RECORDS_DIR_VARIABLE);
    } else {
      Deno.env.set(RECORDS_DIR_VARIABLE, before);
    }
    await Deno.remove(dir, { recursive: true });
  }
}

/** Whether a spooled line claims to be a record, whether or not it is one. */
function isRecordLine(line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  return typeof value === "object" && value !== null && "line" in value &&
    value.line === "record";
}
