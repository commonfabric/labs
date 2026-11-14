/**
 * Starts the server entry point in a fresh process, where it runs as the main
 * module, against a port another listener holds.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const packageRoot = fromFileUrl(new URL("./", import.meta.url));
const repositoryRoot = fromFileUrl(new URL("../../", import.meta.url));

/**
 * Runs `index.ts` with `args` until it exits, serving from a fresh memory
 * directory on a port another listener holds, and returns its status, its
 * stderr and the port.
 */
async function runAgainstTakenPort(
  args: (scratch: string) => string[],
): Promise<{ code: number; stderr: string; port: number }> {
  using taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = taken.addr.port;
  const scratch = await Deno.makeTempDir({ prefix: "toolshed-index-" });
  try {
    const output = await runDenoCommandWithTemporaryLock({
      root: repositoryRoot,
      cwd: packageRoot,
      env: {
        HOST: "127.0.0.1",
        PORT: String(port),
        MEMORY_DIR: toFileUrl(`${scratch}/`).href,
      },
      args: (lockPath) => [
        "run",
        "--no-check",
        "--cached-only",
        "--frozen=true",
        `--lock=${lockPath}`,
        "-A",
        "--env-file=.env.test",
        "index.ts",
        ...args(scratch),
      ],
    });
    return {
      code: output.code,
      stderr: new TextDecoder().decode(output.stderr),
      port,
    };
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

describe("index", () => {
  it("exits with status 3, naming the port, when the port is already in use", async () => {
    const { code, stderr, port } = await runAgainstTakenPort(() => []);

    expect({ code, stderr }).toEqual({
      code: 3,
      stderr: expect.stringContaining(`Port ${port} is already in use`),
    });
  });

  it("exits a background launch with its server's status 3, and reports the server's log", async () => {
    const { code, stderr, port } = await runAgainstTakenPort((scratch) => [
      "--background",
      `--log-file=${join(scratch, "server.log")}`,
    ]);

    expect({ code, stderr }).toEqual({
      code: 3,
      stderr: expect.stringContaining(
        "toolshed failed to start (the server exited with code 3).",
      ),
    });
    // The server half writes its console output to the log, which the launch
    // reports.
    expect(stderr).toContain(`Port ${port} is already in use`);
  });
});
