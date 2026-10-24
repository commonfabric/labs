/**
 * Coverage gate for the `cf view` command's catch block: the path that
 * re-throws an unexpected, non-`ViewError` error (commands/view.ts line 102).
 *
 * A `ViewError` is printed plainly and exits 1; anything else is re-thrown so
 * the CLI surfaces it with a stack trace. The cases below feed a file argument
 * that `Deno.readTextFile` rejects with a `Deno.errors.NotFound` (a missing
 * path) or a read failure (a directory passed as a file), neither of which is a
 * `ViewError`, so the action's catch re-throws and the subprocess exits
 * non-zero with the raw error on stderr. Each runs the real CLI as a
 * subprocess, like the other `cf view` command tests.
 */

import { assert, assertEquals } from "@std/assert";
import { argv, cf } from "./utils.ts";

Deno.test("cf view re-throws a missing-file read error (not a ViewError)", async () => {
  const missing = `${Deno.makeTempDirSync()}/does-not-exist-xyz123.ts`;
  const { code, stderr } = await cf(argv`view --plain ${missing}`);
  // The catch block's `throw error;` propagates the NotFound; the CLI exits 1.
  assertEquals(code, 1);
  const text = stderr.join("\n");
  // The re-thrown error is the raw read failure, not the plain ViewError text,
  // and it names the file that was asked for.
  const notFound = stderr.find((line) => line.startsWith("NotFound:"));
  assert(notFound?.includes(missing), text);
});

Deno.test("cf view re-throws when the file argument is a directory", async () => {
  const dir = Deno.makeTempDirSync();
  try {
    // Reading a directory as text fails with a non-ViewError, taking the same
    // re-throw branch as a missing file.
    const { code, stderr } = await cf(argv`view --plain ${dir}`);
    assertEquals(code, 1);
    const text = stderr.join("\n");
    // Not the empty/no-input ViewError message — a raw read failure.
    assert(
      !text.toLowerCase().includes("no input"),
      text,
    );
    assert(text.includes("IsADirectory"), text);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
