import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { removeDirectory } from "@commonfabric/test-support/remove-directory";

import { PROFILE_DIRECTORY_PREFIX } from "../browser.ts";

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");

// What the failing disposal in the fixtures below throws.
const DISPOSAL_FAILURE = "the runtime would not dispose";

// What the failing close in the second fixture below throws.
const CLOSE_FAILURE = "the browser would not close";

// A test file whose `ShellIntegration` fails to dispose its page's runtime on
// the way down, with `before` run first. `bindLifecycle()` registers its hooks
// with the running test file, so only a test file of its own can watch one of
// them fail: from inside this one, the failure would be this file's.
function failsToDispose(before = ""): string {
  return `
    import { it } from "@std/testing/bdd";
    import { Browser } from ${
    JSON.stringify(new URL("../browser.ts", import.meta.url).href)
  };
    import { ShellIntegration } from ${
    JSON.stringify(new URL("../shell-utils.ts", import.meta.url).href)
  };
    ${before}
    const shell = new ShellIntegration();
    shell.disposeRuntime = () =>
      Promise.reject(new Error(${JSON.stringify(DISPOSAL_FAILURE)}));
    shell.bindLifecycle();
    it("runs between the hooks", () => {});
  `;
}

// Runs `source` as a test file with a `TMPDIR` of its own, so the profile
// directory its browser made is the only thing there carrying the prefix.
// Returns what the run printed and the profile directories still there.
async function runTestFile(
  source: string,
): Promise<{ success: boolean; printed: string; profiles: string[] }> {
  const directory = await Deno.makeTempDir({ prefix: "integration-tmpdir-" });
  try {
    const fixture = `${directory}/fails-to-dispose.test.ts`;
    await Deno.writeTextFile(fixture, source);

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

    const profiles = [...Deno.readDirSync(directory)]
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(PROFILE_DIRECTORY_PREFIX));
    return { success, printed: new TextDecoder().decode(stdout), profiles };
  } finally {
    await removeDirectory(directory);
  }
}

describe("ShellIntegration", () => {
  describe("instance members", () => {
    describe("bindLifecycle()", () => {
      it("closes the browser when disposing the page's runtime fails", async () => {
        const { success, printed, profiles } = await runTestFile(
          failsToDispose(),
        );

        expect(success).toBe(false);
        expect(printed).toContain(DISPOSAL_FAILURE);
        expect(profiles).toEqual([]);
      });

      it("reports both failures when the browser fails to close after disposing fails", async () => {
        const { success, printed } = await runTestFile(failsToDispose(`
          Browser.prototype.close = () =>
            Promise.reject(new Error(${JSON.stringify(CLOSE_FAILURE)}));
        `));

        expect(success).toBe(false);
        expect(printed).toContain(DISPOSAL_FAILURE);
        expect(printed).toContain(CLOSE_FAILURE);
      });
    });
  });
});
