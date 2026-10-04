import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

Deno.test("scoped group chat pattern schema generates scoped input cells", async () => {
  const output = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    cwd: ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      "--allow-net",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      join(ROOT, "packages/cli/mod.ts"),
      "check",
      "packages/patterns/scoped-group-chat/main-with-writable-inputs.tsx",
      "--pattern-json",
      "--no-check",
    ],
  });
  assertEquals(output.code, 0);

  const stdout = new TextDecoder().decode(output.stdout);
  const jsonStart = stdout.indexOf("{");
  const pattern = JSON.parse(stdout.slice(jsonStart));
  const properties = pattern.argumentSchema.properties;

  assertEquals(properties.name.asCell, [{ kind: "cell", scope: "user" }]);
  assertEquals(properties.selectedRoom.asCell, [
    { kind: "cell", scope: "session" },
  ]);
  assertEquals(properties.conversation.asCell, [
    { kind: "cell", scope: "space" },
  ]);
  assertEquals(properties.draft.asCell, [{ kind: "cell", scope: "user" }]);
  assertEquals(properties.newRoomName.asCell, [
    { kind: "cell", scope: "session" },
  ]);
});
