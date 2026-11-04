// The daemon's supervisor readiness handshake, exercised through a real process.
//
// A background mount's parent holds the read end of the daemon's stdout and
// blocks on it for a readiness line; `cf fuse status` later reads the status
// file the daemon keeps beside the mount state. Both are driven by main()'s
// writeSupervisorStatus / publishSupervisorState, which run only when
// --supervisor-status names a path. Drive a deterministic startup failure with
// that path set and assert the daemon both announces "failed" on its stdout
// channel and records it in the status file.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const packageDir = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(packageDir, "..", "..");
const modPath = join(packageDir, "mod.ts");
const decoder = new TextDecoder();

interface SupervisorStatus {
  state?: string;
  pid?: number;
  mountpoint?: string;
  error?: string;
}

/** Run the daemon entrypoint and capture stdout, stderr, and exit code. */
async function runDaemon(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: repoRoot,
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
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/** The last JSON readiness line the daemon announced on its stdout channel. */
function lastReadinessLine(stdout: string): SupervisorStatus | null {
  let last: SupervisorStatus | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SupervisorStatus;
      if (typeof parsed.state === "string") last = parsed;
    } catch {
      // Not a readiness line.
    }
  }
  return last;
}

Deno.test(
  "daemon announces and records a startup failure through the supervisor status path",
  async () => {
    const tmp = Deno.makeTempDirSync({ prefix: "cf-fuse-status-test-" });
    try {
      // A regular file stands where the mountpoint's parent directory would be,
      // so creating the mountpoint under it fails deterministically — before the
      // daemon opens libfuse or touches the network — and the failure path runs
      // anywhere the tests do.
      const blocker = join(tmp, "not-a-dir");
      Deno.writeTextFileSync(blocker, "x");
      const mountpoint = join(blocker, "mnt");
      const statusPath = join(tmp, "status.json");

      const { code, stdout } = await runDaemon([
        mountpoint,
        "--supervisor-status",
        statusPath,
      ]);

      assertEquals(code, 1);

      // The handshake channel: the daemon announced its terminal state on stdout,
      // which is the pipe `cf fuse mount --background` blocks on.
      const announced = lastReadinessLine(stdout);
      assert(announced, `no readiness line on stdout; got: ${stdout}`);
      assertEquals(announced.state, "failed");
      assertEquals(announced.mountpoint, mountpoint);
      assertEquals(typeof announced.pid, "number");
      assert(
        typeof announced.error === "string" && announced.error.length > 0,
        "announced failure carries an error",
      );

      // The record `cf fuse status` reads: the same terminal state, persisted to
      // the status file the daemon writes beside the mount state.
      const recorded = JSON.parse(
        Deno.readTextFileSync(statusPath),
      ) as SupervisorStatus;
      assertEquals(recorded.state, "failed");
      assertEquals(recorded.mountpoint, mountpoint);
      assert(
        typeof recorded.error === "string" && recorded.error.length > 0,
        "recorded failure carries an error",
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);
