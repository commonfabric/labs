import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const MAIN = join(REPO_ROOT, "runtime/cf-harness/src/main.ts");

const runMain = async (
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lock) => [
      "run",
      "-A",
      `--lock=${lock}`,
      "--frozen",
      "--cached-only",
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
};

describe("main", () => {
  it("runs the CLI on its arguments and exits with the code it returns", async () => {
    // The entry point runs only as a program, so this spawns it, once: a
    // spawned Deno is slow to start. An undeclared flag shows both halves,
    // since the refusal names the argument and its exit code is not zero.
    // Nothing reaches a model, a sandbox, or the operator's configuration.

    const { code, stdout, stderr } = await runMain(["--no-such-flag"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("`--no-such-flag` is not a flag of the batch CLI");
  });
});
