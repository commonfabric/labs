import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { readCoverageProfileUrls } from "@commonfabric/test-support/coverage-profiles";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("transport-web-worker-coverage", () => {
  it("keeps a complete coverage profile from a worker the process disposes of just before exiting", async () => {
    const raw = await Deno.makeTempDir();
    try {
      const run = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../../../", import.meta.url)),
        cwd: fromFileUrl(new URL("../../", import.meta.url)),
        args: (lock) => [
          "run",
          `--lock=${lock}`,
          "--frozen",
          "--no-check",
          "--allow-read",
          "--allow-env",
          "--allow-ffi",
          fromFileUrl(
            new URL("./fixtures/connect-and-dispose.ts", import.meta.url),
          ),
        ],
        env: { DENO_COVERAGE_DIR: raw },
      });
      const decoder = new TextDecoder();
      expect(
        run.success,
        decoder.decode(run.stdout) + decoder.decode(run.stderr),
      ).toBe(true);

      // Only the worker loads its entry module, so a profile naming it is one
      // the worker wrote.
      const entry =
        new URL("../../src/backends/web-worker/index.ts", import.meta.url).href;
      const urls = await readCoverageProfileUrls(raw);
      expect(urls.filter((url) => url === entry)).toHaveLength(1);
    } finally {
      await Deno.remove(raw, { recursive: true });
    }
  });
});
