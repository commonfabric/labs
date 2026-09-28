import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { shuffleFlag, shuffleSeed } from "@commonfabric/test-support/shuffle";

/** How many workers the nested file starts and disposes of. */
const WORKER_COUNT = 3;

// A terminated runtime worker writes its coverage profiles on its own thread,
// after the test that disposed of it has moved on. `WorkerExitBarrier` makes the
// test process wait for that; without it, a `deno test` that ends soon after
// disposing of a worker exits under the write, and the worker's profiles are
// lost or, when the exit lands mid-file, truncated. One truncated profile makes
// `deno coverage` refuse the whole directory. This runs a file that disposes of
// its workers and ends at once, which is the arrangement that loses them, and
// requires a complete profile of the worker entry from every worker.
describe("runtime worker coverage", () => {
  it("keeps a complete coverage profile from every runtime worker a test file disposes of", async () => {
    const raw = await Deno.makeTempDir({ prefix: "runtime-worker-coverage-" });
    try {
      const run = await runDenoCommandWithTemporaryLock({
        root: fromFileUrl(new URL("../../../", import.meta.url)),
        cwd: fromFileUrl(new URL("../", import.meta.url)),
        args: (lock) => [
          "test",
          shuffleFlag(shuffleSeed()),
          `--lock=${lock}`,
          "--frozen",
          "--no-check",
          "-A",
          fromFileUrl(
            new URL("./fixtures/worker-exit-nested.ts", import.meta.url),
          ),
        ],
        env: {
          DENO_COVERAGE_DIR: raw,
          CF_TEST_RECORDS_DIR: "",
          CF_TEST_SKIP_LIST: "",
          WORKER_COUNT: String(WORKER_COUNT),
        },
      });
      const decoder = new TextDecoder();
      expect(
        run.success,
        decoder.decode(run.stdout) + decoder.decode(run.stderr),
      ).toBe(true);

      // Each worker runs the fixture entry as its main module, so every worker
      // that finished writing leaves exactly one profile naming it.
      // The entry's URL carries its barrier's lock file as a search parameter.
      const entry =
        new URL("./fixtures/runtime-worker.ts", import.meta.url).href + "?";
      let entryProfiles = 0;
      for await (const file of Deno.readDir(raw)) {
        const text = await Deno.readTextFile(`${raw}/${file.name}`);
        let profile: { url: string };
        try {
          profile = JSON.parse(text);
        } catch (error) {
          throw new Error(
            `coverage profile ${file.name} is incomplete (${text.length} bytes)`,
            { cause: error },
          );
        }
        if (profile.url.startsWith(entry)) entryProfiles++;
      }
      expect(entryProfiles).toBe(WORKER_COUNT);
    } finally {
      await Deno.remove(raw, { recursive: true });
    }
  });
});
