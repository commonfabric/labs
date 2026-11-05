import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import { realFileGateway } from "../lib/view/filegateway.ts";
import { loadViewInput } from "../lib/view/loadinput.ts";

const PROCFS_PATH = "/proc/self/cmdline";
const CLI_PACKAGE_DIR = join(import.meta.dirname!, "..");
const REPO_ROOT = join(CLI_PACKAGE_DIR, "..", "..");

describe("view-procfs", () => {
  const linuxIt = Deno.build.os === "linux" ? it : it.skip;

  linuxIt("reads zero-sized virtual files through EOF", async () => {
    expect(Deno.statSync(PROCFS_PATH).size).toBe(0);
    const input = await loadViewInput(
      PROCFS_PATH,
      PROCFS_PATH,
      undefined,
      true,
      false,
    );

    assert(input.kind === "bytes");
    assert(input.bytes.length > 0);
    expect(input.language?.id).toBe("binary");
    expect(input.extent).toEqual({
      byteLength: input.bytes.length,
      complete: true,
    });
  });

  linuxIt("opens a zero-sized procfs file through the real gateway", () => {
    expect(Deno.statSync(PROCFS_PATH).size).toBe(0);
    const opened = realFileGateway().open(PROCFS_PATH);
    assert(opened !== null);
    assert(opened.text.length > 0);
    expect(opened.source.editable).toBe(false);
    const rendered = opened.source.render?.(
      opened.source.parse(opened.text),
    );
    assert(rendered !== undefined);
    assert(rendered.lines[0].text.startsWith("00000000  "));
    expect(rendered.lines.at(-1)?.text.includes("preview stopped")).toBe(
      false,
    );
  });

  linuxIt("renders a zero-sized procfs file through `cf view`", async () => {
    expect(Deno.statSync(PROCFS_PATH).size).toBe(0);
    const result = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      cwd: CLI_PACKAGE_DIR,
      args: (lockPath) => [
        "run",
        `--lock=${lockPath}`,
        "--frozen=true",
        "--allow-all",
        "./mod.ts",
        "view",
        "--plain",
        "--color",
        "never",
        PROCFS_PATH,
      ],
    });

    const decoder = new TextDecoder();
    expect(result.code, decoder.decode(result.stderr)).toBe(0);
    const stdout = decoder.decode(result.stdout).split("\n").filter(Boolean);
    assert(stdout[0].startsWith("00000000  "), stdout.join("\n"));
    expect(stdout.at(-1) === "00000000").toBe(false);
  });
});
