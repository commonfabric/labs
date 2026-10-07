import { assertEquals, assertRejects } from "@std/assert";
import {
  DenoProcessRunner,
  ProcessTimeoutError,
} from "../src/sandbox/process-runner.ts";

Deno.test("DenoProcessRunner surfaces killed timeout exits as ProcessTimeoutError", async () => {
  const runner = new DenoProcessRunner();

  await assertRejects(
    () =>
      runner.run({
        command: "/bin/sh",
        args: ["-lc", "sleep 5"],
        timeoutMs: 100,
      }),
    ProcessTimeoutError,
    "process timed out after 100ms",
  );
});

Deno.test({
  name: "DenoProcessRunner clears inherited env when requested",
  permissions: { env: true, run: true },
  async fn() {
    const runner = new DenoProcessRunner();
    const key = "SECRET_SHOULD_NOT_LEAK";
    const previous = Deno.env.get(key);
    try {
      Deno.env.set(key, "super-secret");
      const result = await runner.run({
        command: "/usr/bin/env",
        args: [],
        clearEnv: true,
        env: { PATH: "/usr/bin:/bin", SAFE_VALUE: "ok" },
      });

      assertEquals(result.exitCode, 0);
      assertEquals(result.stdout.includes("SAFE_VALUE=ok"), true);
      assertEquals(result.stdout.includes(key), false);
      assertEquals(result.stdout.includes("super-secret"), false);
    } finally {
      if (previous === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, previous);
      }
    }
  },
});

Deno.test("DenoProcessRunner stops a process its signal aborts, which ends with the status it ends with, not as a timeout", async () => {
  const runner = new DenoProcessRunner();
  const stop = new AbortController();

  // Left alone it would run for a minute.
  const running = runner.run({
    command: "/bin/sh",
    args: ["-c", "exec sleep 60"],
    signal: stop.signal,
  });
  // Nothing to wait on but the abort: a SIGTERM ends `sleep` whenever it
  // lands, before or after `exec`.
  stop.abort();
  const result = await running;

  assertEquals(result.exitCode, 143);
});

Deno.test("DenoProcessRunner refuses, running nothing, a run whose signal has already aborted", async () => {
  const runner = new DenoProcessRunner();
  const stop = new AbortController();
  stop.abort();
  const marker = await Deno.makeTempFile();
  await Deno.remove(marker);

  await assertRejects(() =>
    runner.run({
      command: "/bin/sh",
      args: ["-c", `touch ${marker}`],
      signal: stop.signal,
    })
  );
  await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
});
