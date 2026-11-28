import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";
import { USAGE } from "./retire-ingest-channels.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const TOOLSHED_DIR = fromFileUrl(new URL("../", import.meta.url));

describe("retire-ingest-channels", () => {
  describe("as a program", () => {
    it("exits with the status main returns, after printing the usage, when run without --reason", async () => {
      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        cwd: TOOLSHED_DIR,
        args: (lockPath) => [
          "run",
          "--lock",
          lockPath,
          "-A",
          "--env-file=.env.test",
          "scripts/retire-ingest-channels.ts",
          "--confirm",
        ],
      });
      const decoder = new TextDecoder();

      expect(output.code).toBe(2);
      expect(decoder.decode(output.stderr)).toContain(USAGE);
      // No plan was computed, so no summary line was printed.
      expect(decoder.decode(output.stdout)).not.toContain("channel(s)");
    });
  });
});
