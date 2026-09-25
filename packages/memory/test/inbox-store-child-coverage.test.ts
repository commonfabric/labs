import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { shuffleFlag, shuffleSeed } from "@commonfabric/test-support/shuffle";

describe("inbox-store-child-coverage", () => {
  it("keeps a complete coverage profile from every writer process the InboxStore tests start", async () => {
    const raw = await Deno.makeTempDir();
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
          "--allow-read",
          "--allow-write",
          "--allow-net",
          "--allow-ffi",
          "--allow-env",
          "--allow-run",
          fromFileUrl(new URL("./inbox-store.test.ts", import.meta.url)),
        ],
        env: {
          DENO_COVERAGE_DIR: raw,
          CF_TEST_RECORDS_DIR: "",
          CF_TEST_SKIP_LIST: "",
        },
      });
      const decoder = new TextDecoder();
      expect(
        run.success,
        decoder.decode(run.stdout) + decoder.decode(run.stderr),
      ).toBe(true);

      // Each writer process runs the fixture as its main module, so every one
      // that exits normally leaves exactly one profile naming it.
      const writer =
        new URL("./fixtures/inbox-write-lock.ts", import.meta.url).href;
      let writerProfiles = 0;
      for await (const entry of Deno.readDir(raw)) {
        const text = await Deno.readTextFile(`${raw}/${entry.name}`);
        let profile: { url: string };
        try {
          profile = JSON.parse(text);
        } catch (error) {
          throw new Error(
            `coverage profile ${entry.name} is incomplete (${text.length} bytes)`,
            { cause: error },
          );
        }
        if (profile.url === writer) writerProfiles++;
      }
      expect(writerProfiles).toBe(4);
    } finally {
      await Deno.remove(raw, { recursive: true });
    }
  });
});
