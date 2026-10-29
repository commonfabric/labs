// The daemon entrypoint's option contract, exercised through a real process.
//
// main() validates its mount flags before it opens libfuse or creates the
// mountpoint, so these runs need no FUSE provider and mount nothing. The
// checks cannot run in-process: main() reports a rejected flag by exiting.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const packageDir = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(packageDir, "..", "..");
const modPath = join(packageDir, "mod.ts");
const decoder = new TextDecoder();

/** Run the daemon entrypoint and capture how it exited. */
async function runDaemon(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: repoRoot,
    // The child inherits this process's environment, and a mount reads
    // CF_CFC_MODE from it. An empty value names no mode, so a run that names
    // none gets none.
    env: { CF_CFC_MODE: "", ...env },
    args: (lockPath) => [
      "run",
      `--lock=${lockPath}`,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      modPath,
      ...args,
    ],
  });
  return {
    code: output.code,
    stderr: decoder.decode(output.stderr),
    stdout: decoder.decode(output.stdout),
  };
}

/** A mountpoint path the daemon must reject before ever creating. */
function unusedMountpoint(): string {
  return join(
    Deno.makeTempDirSync({ prefix: "cf-fuse-cli-test-" }),
    "never-mounted",
  );
}

Deno.test("daemon rejects an out-of-range attrcache-timeout", async () => {
  const mountpoint = unusedMountpoint();
  const { code, stderr } = await runDaemon([
    mountpoint,
    "--attrcache-timeout=-1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --attrcache-timeout value: -1");
  // The flags are rejected before the mountpoint is created.
  assertEquals(existsSync(mountpoint), false);
});

Deno.test("daemon rejects an attrcache-timeout whose value was dropped", async () => {
  // The argument parser does not read "-1" as this flag's value, and a mount
  // must not silently fall back to the default cache regime.
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--attrcache-timeout",
    "-1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Missing value for --attrcache-timeout");
});

Deno.test("daemon rejects a non-integer attrcache-timeout", async () => {
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--attrcache-timeout",
    "1.5",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(stderr, "Invalid --attrcache-timeout value: 1.5");
});

Deno.test("daemon rejects both cache flags together", async () => {
  const { code, stderr } = await runDaemon([
    unusedMountpoint(),
    "--noattrcache",
    "--attrcache-timeout",
    "1",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(
    stderr,
    "--noattrcache and --attrcache-timeout are mutually exclusive",
  );
});

Deno.test("daemon accepts the cache flags it supports", async () => {
  // A missing mountpoint is reported only once the flags have parsed, so
  // reaching the usage message proves the flags themselves were accepted.
  for (
    const accepted of [
      ["--noattrcache"],
      ["--attrcache-timeout", "0"],
      ["--attrcache-timeout", "86400"],
    ]
  ) {
    const { code, stderr } = await runDaemon(accepted);
    assertEquals(code, 1, `expected usage exit for ${accepted.join(" ")}`);
    assertStringIncludes(stderr, "Usage: mod.ts <mountpoint>");
  }
});

Deno.test("daemon rejects an unrecognized --cfc-mode", async () => {
  const mountpoint = unusedMountpoint();
  const { code, stderr } = await runDaemon([
    mountpoint,
    "--cfc-mode=enforce-stricct",
  ]);

  assertEquals(code, 1);
  assertStringIncludes(
    stderr,
    "--cfc-mode=enforce-stricct is not a CFC enforcement mode",
  );
  assertStringIncludes(
    stderr,
    "disabled, observe, enforce-explicit, enforce-strict",
  );
  assertEquals(existsSync(mountpoint), false);
});

Deno.test("daemon rejects an unrecognized CF_CFC_MODE", async () => {
  const mountpoint = unusedMountpoint();
  const { code, stderr } = await runDaemon(
    [mountpoint],
    { CF_CFC_MODE: "enforce-stricct" },
  );

  assertEquals(code, 1);
  assertStringIncludes(
    stderr,
    "CF_CFC_MODE=enforce-stricct is not a CFC enforcement mode",
  );
  assertStringIncludes(
    stderr,
    "disabled, observe, enforce-explicit, enforce-strict",
  );
  assertEquals(existsSync(mountpoint), false);
});

Deno.test("daemon accepts the CFC modes on the ladder", async () => {
  // Reaching the usage message proves the mode was accepted: it is reported
  // only once the flags have parsed.
  for (
    const mode of [
      "disabled",
      "observe",
      "enforce-explicit",
      "enforce-strict",
    ]
  ) {
    const { code, stderr } = await runDaemon([`--cfc-mode=${mode}`]);
    assertEquals(code, 1, `expected usage exit for --cfc-mode=${mode}`);
    assertStringIncludes(stderr, "Usage: mod.ts <mountpoint>");
  }
});

Deno.test("a rejected mount flag reaches the parent on the status channel", async () => {
  // A background mount's stderr goes nowhere its parent reads. `cf fuse mount`
  // learns why a mount did not start from the supervisor status channel.
  const statusPath = join(
    Deno.makeTempDirSync({ prefix: "cf-fuse-cli-test-" }),
    "supervisor-status.json",
  );
  const { code, stdout } = await runDaemon([
    unusedMountpoint(),
    `--supervisor-status=${statusPath}`,
    "--cfc-mode=enforce-stricct",
  ]);

  assertEquals(code, 1);
  const published = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assertEquals(published.at(-1)?.state, "failed");
  assertStringIncludes(
    String(published.at(-1)?.error),
    "--cfc-mode=enforce-stricct is not a CFC enforcement mode",
  );
  assertStringIncludes(
    String(JSON.parse(Deno.readTextFileSync(statusPath)).error),
    "--cfc-mode=enforce-stricct is not a CFC enforcement mode",
  );
});
