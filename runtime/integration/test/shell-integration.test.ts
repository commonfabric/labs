import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { removeDirectory } from "@commonfabric/test-support/remove-directory";

import { PROFILE_DIRECTORY_PREFIX } from "../browser.ts";

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");

// What the failing disposal in the fixture below throws.
const DISPOSAL_FAILURE = "the runtime would not dispose";

// A test file whose `ShellIntegration` fails to dispose its page's runtime on
// the way down. `bindLifecycle()` registers its hooks with the running test
// file, so only a test file of its own can watch one of them fail: from inside
// this one, the failure would be this file's.
const FAILS_TO_DISPOSE = `
  import { it } from "@std/testing/bdd";
  import { ShellIntegration } from ${
  JSON.stringify(new URL("../shell-utils.ts", import.meta.url).href)
};
  const shell = new ShellIntegration();
  shell.disposeRuntime = () =>
    Promise.reject(new Error(${JSON.stringify(DISPOSAL_FAILURE)}));
  shell.bindLifecycle();
  it("runs between the hooks", () => {});
`;

describe("ShellIntegration", () => {
  describe("instance members", () => {
    describe("bindLifecycle()", () => {
      it("closes the browser when disposing the page's runtime fails", async () => {
        // The child gets a `TMPDIR` of its own, so the profile directory its
        // browser made is the only thing here carrying the prefix.
        const directory = await Deno.makeTempDir({
          prefix: "integration-tmpdir-",
        });
        try {
          const fixture = `${directory}/fails-to-dispose.test.ts`;
          await Deno.writeTextFile(fixture, FAILS_TO_DISPOSE);

          const { success, stdout } = await runDenoCommandWithTemporaryLock({
            root: REPO_ROOT,
            env: { TMPDIR: directory },
            args: (lockPath) => [
              "test",
              "--no-check",
              "-A",
              "--lock",
              lockPath,
              "--frozen=true",
              "--config",
              `${REPO_ROOT}/deno.jsonc`,
              fixture,
            ],
          });

          expect(success).toBe(false);
          expect(new TextDecoder().decode(stdout)).toContain(DISPOSAL_FAILURE);
          const profiles = [...Deno.readDirSync(directory)]
            .map((entry) => entry.name)
            .filter((name) => name.startsWith(PROFILE_DIRECTORY_PREFIX));
          expect(profiles).toEqual([]);
        } finally {
          await removeDirectory(directory);
        }
      });
    });
  });
});
