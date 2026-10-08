import { assertEquals, assertThrows } from "@std/assert";
import { batchQosArgv, TASKPOLICY } from "./batch-qos.ts";

const argv = ["deno", "task", "test"];

function context(os: string, env: Record<string, string> = {}) {
  return { os, env: (name: string) => env[name] };
}

Deno.test("a Mac run is started at utility QoS", () => {
  assertEquals(batchQosArgv(argv, context("darwin")), [
    TASKPOLICY,
    "-c",
    "utility",
    ...argv,
  ]);
});

Deno.test("Linux, CI and the off switch leave the command as written", () => {
  assertEquals(batchQosArgv(argv, context("linux")), argv);
  assertEquals(batchQosArgv(argv, context("darwin", { CI: "true" })), argv);
  assertEquals(
    batchQosArgv(argv, context("darwin", { CI: "false" }))[0],
    TASKPOLICY,
  );
  assertEquals(
    batchQosArgv(argv, context("darwin", { CF_TEST_QOS: "0" })),
    argv,
  );
});

Deno.test("an empty command is refused", () => {
  assertThrows(() => batchQosArgv([], context("darwin")));
});
