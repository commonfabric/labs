import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { test } from "@commonfabric/test-support/test";
import { GITHUB_HOST_USAGE } from "../src/cli-options.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));

/** Run the host's entry point as its `start` task does. */
async function runMain(
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "-A",
      MAIN,
      ...args,
    ],
  });
  const decoder = new TextDecoder();
  return {
    code: output.code,
    out: decoder.decode(output.stdout),
    err: decoder.decode(output.stderr),
  };
}

test("the GitHub host entry point prints its usage and exits 0 for --help", async () => {
  const result = await runMain("--help");
  assertEquals(result.out, `${GITHUB_HOST_USAGE}\n`);
  assertEquals(result.err, "");
  assertEquals(result.code, 0);
});

test("the GitHub host entry point exits 1 for an option it does not know", async () => {
  const result = await runMain("--bogus");
  assertEquals(result.out, "");
  assertStringIncludes(
    result.err,
    "GitHub host failed: unknown option: --bogus",
  );
  assertEquals(result.code, 1);
});
