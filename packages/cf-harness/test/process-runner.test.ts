import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
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

Deno.test("DenoProcessRunner surfaces a timeout as ProcessTimeoutError where the process stopped exits 0", async () => {
  const runner = new DenoProcessRunner();

  // A shell that answers SIGTERM by exiting 0, as pasta does; what it waits
  // on writes nowhere, so its output ends with the shell.
  await assertRejects(
    () =>
      runner.run({
        command: "/bin/sh",
        args: [
          "-c",
          "trap 'kill $!; exit 0' TERM; sleep 5 >/dev/null 2>&1 & wait",
        ],
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

Deno.test("DenoProcessRunner stops a process its signal aborts, and throws the signal's reason once it has ended, whatever status it ends with", async () => {
  const runner = new DenoProcessRunner();

  for (
    const script of [
      "exec sleep 60",
      // Answers SIGTERM by exiting 0, as pasta does.
      "trap 'kill $!; exit 0' TERM; sleep 60 >/dev/null 2>&1 & wait",
    ]
  ) {
    const stop = new AbortController();
    // Left alone it would run for a minute.
    const running = runner.run({
      command: "/bin/sh",
      args: ["-c", script],
      signal: stop.signal,
    });
    stop.abort(new Error("closed"));

    await assertRejects(() => running, Error, "closed");
  }
});

Deno.test("DenoProcessRunner throws the reason of a signal that stopped the process before its timeout came due, however long the process takes to end", async () => {
  const runner = new DenoProcessRunner();
  const dir = await Deno.makeTempDir();
  const ready = join(dir, "ready");
  try {
    await new Deno.Command("mkfifo", { args: [ready] }).output();
    const stop = new AbortController();
    // Takes five seconds to answer SIGTERM, past its two-second timeout,
    // and says through the FIFO once it will answer it so.
    const running = runner.run({
      command: "/bin/sh",
      args: [
        "-c",
        `trap 'sleep 5; kill $!; exit 0' TERM; echo > "$0"; sleep 60 >/dev/null 2>&1 & wait`,
        ready,
      ],
      timeoutMs: 2000,
      signal: stop.signal,
    });
    await Deno.readTextFile(ready);
    stop.abort(new Error("closed"));

    await assertRejects(() => running, Error, "closed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("DenoProcessRunner throws the reason of a signal that stopped a process its input was still being written to", async () => {
  const runner = new DenoProcessRunner();
  const stop = new AbortController();

  // More input than a pipe holds, to a process that reads none: the write is
  // still in flight when the process is stopped.
  const running = runner.run({
    command: "/bin/sh",
    args: ["-c", "exec sleep 60"],
    stdinText: "x".repeat(4 * 1024 * 1024),
    signal: stop.signal,
  });
  stop.abort(new Error("stopped by its caller"));

  await assertRejects(() => running, Error, "stopped by its caller");
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
