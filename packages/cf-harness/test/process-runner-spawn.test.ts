import { assert, assertEquals } from "@std/assert";

import { DenoProcessRunner } from "../src/sandbox/process-runner.ts";

Deno.test("DenoProcessRunner.spawn hands back a live child that kill() ends", async () => {
  const runner = new DenoProcessRunner();
  const handle = runner.spawn({ command: "/bin/sh", args: ["-c", "sleep 30"] });
  assert(handle.pid > 0);
  handle.kill("SIGTERM");
  const { exitCode } = await handle.exited;
  assert(exitCode !== 0, "a killed child does not exit 0");
  // Killing after exit is a no-op, not an error.
  handle.kill("SIGKILL");
});

Deno.test("DenoProcessRunner.spawn reports a clean exit", async () => {
  const runner = new DenoProcessRunner();
  const handle = runner.spawn({
    command: "/bin/sh",
    args: ["-c", "exit 0"],
    env: { X: "1" },
  });
  assertEquals((await handle.exited).exitCode, 0);
  handle.kill();
});
