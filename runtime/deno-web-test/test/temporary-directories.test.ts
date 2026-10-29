/**
 * What a harness run leaves in the directory it makes its temporary files in.
 *
 * The run is given a `TMPDIR` of this test's own, and does not have it to
 * itself: Chrome writes its own scratch files into the directory `TMPDIR`
 * names and leaves some of them behind, files and directories alike. What the
 * run makes for itself carries the prefix `Manifest.create()` gives it, and
 * that prefix is what the assertion reads rather than the directory being
 * empty. `manifest.test.ts` is what pins the prefix onto the directory, so
 * that a run making no such directory would fail there rather than pass
 * silently here.
 *
 * The run closes the browser before it returns. `BrowserProcess.close()`
 * waits for the browser's exit and the closure of inherited output pipes;
 * profile removal follows those waits.
 */

import { describe, it } from "@std/testing/bdd";

import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { RUN_DIRECTORY_PREFIX } from "../manifest.ts";
import { runDenoWebTest } from "./utils.ts";

describe("a harness run", () => {
  it("leaves no directory of its own in the temporary directory", async () => {
    const temporaryDirectory = await Deno.makeTempDir({
      prefix: "deno-web-test-tmpdir-",
    });
    const run = await runDenoWebTest("success-project", {
      TMPDIR: temporaryDirectory,
    });
    const left = [...Deno.readDirSync(temporaryDirectory)];

    await removeDirectory(temporaryDirectory);

    run.assert(run.success, "the run passed");
    run.assert(
      !left.some((entry) => entry.name.startsWith(RUN_DIRECTORY_PREFIX)),
      `${temporaryDirectory} still holds ${
        left.map((entry) =>
          `${entry.name} (${entry.isDirectory ? "directory" : "file"})`
        ).join(", ")
      }`,
    );
  });
});
