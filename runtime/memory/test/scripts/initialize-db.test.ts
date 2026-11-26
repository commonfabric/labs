import { fromFileUrl, join } from "@std/path";
import { expect } from "@std/expect";

import {
  readDenoConfig,
  runDenoCommandWithTemporaryLock,
} from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

import { checkSqliteLibrary } from "../../scripts/initialize-db.ts";

const repositoryRoot = fromFileUrl(new URL("../../../../", import.meta.url));
const script = fromFileUrl(
  new URL("../../scripts/initialize-db.ts", import.meta.url),
);

// The permissions of the root `initialize-db` task, which fetches the library
// on a machine whose cache lacks it.
const taskFlags = String(
  (await readDenoConfig(join(repositoryRoot, "deno.jsonc"))).tasks[
    "initialize-db"
  ],
).split(/\s+/).filter((word) => word.startsWith("--"));

/** Runs the script the way `deno task initialize-db` does, with `flags`. */
function runScript(flags: string[]): Promise<Deno.CommandOutput> {
  return runDenoCommandWithTemporaryLock({
    root: repositoryRoot,
    args: (lock) => ["run", "--frozen", `--lock=${lock}`, ...flags, script],
  });
}

describe("initialize-db", () => {
  describe("checkSqliteLibrary()", () => {
    it("runs statements against an in-memory database without throwing", () => {
      checkSqliteLibrary();
    });
  });

  describe("as a script", () => {
    it("exits zero under the task's permissions", async () => {
      expect(taskFlags).toContain("--allow-ffi");
      const { code, stderr } = await runScript(taskFlags);
      expect(code, new TextDecoder().decode(stderr)).toBe(0);
    });

    it("exits nonzero when it may not load the native library", async () => {
      const { code, stderr } = await runScript(
        taskFlags.filter((flag) => flag !== "--allow-ffi"),
      );
      expect(code).not.toBe(0);
      const output = new TextDecoder().decode(stderr);
      expect(output).toContain("Failed to load SQLite3 Dynamic Library");
      expect(output).toContain("--allow-ffi");
    });
  });
});
