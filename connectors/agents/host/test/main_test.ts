import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { test } from "@commonfabric/test-support/test";
import { AGENTS_HOST_USAGE } from "../src/cli-options.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../../", import.meta.url));
const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));

async function runMain(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--frozen",
      "-A",
      MAIN,
      ...args,
    ],
  });
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

test("agents-host program prints its usage and exits 0 for --help", async () => {
  const result = await runMain("--help");
  assertEquals(result.code, 0);
  assertStringIncludes(result.stdout, AGENTS_HOST_USAGE);
});

test("agents-host program exits 1 and reports an unknown option", async () => {
  const result = await runMain("--no-such-option");
  assertEquals(result.code, 1);
  assertEquals(result.stdout.includes(AGENTS_HOST_USAGE), false);
  assertStringIncludes(
    result.stderr,
    "Agent host failed: unknown option: --no-such-option",
  );
});
