import { assertEquals } from "@std/assert";
import { evaluateHarnessWriteFileAuthorization } from "../src/cfc/mod.ts";
import { test } from "@commonfabric/test-support/test";

test("evaluateHarnessWriteFileAuthorization warns in observe mode without direct-command authorization", () => {
  assertEquals(
    evaluateHarnessWriteFileAuthorization({
      enforcementMode: "observe",
      promptSlot: { role: "context" },
      path: "/workspace/notes/out.txt",
      mode: "replace",
    }),
    {
      allowed: true,
      warningDetail:
        "write_file would require direct-command authorization in enforce modes",
    },
  );
});

test("evaluateHarnessWriteFileAuthorization denies in enforce-explicit mode without direct-command authorization", () => {
  assertEquals(
    evaluateHarnessWriteFileAuthorization({
      enforcementMode: "enforce-explicit",
      promptSlot: { role: "context" },
      path: "/workspace/notes/out.txt",
      mode: "replace",
    }),
    {
      allowed: false,
      denialDetail:
        "write_file requires direct-command authorization in enforce-explicit",
    },
  );
});

test("evaluateHarnessWriteFileAuthorization allows direct-command writes in strict modes", () => {
  assertEquals(
    evaluateHarnessWriteFileAuthorization({
      enforcementMode: "enforce-strict",
      promptSlot: { role: "direct-command", surface: "cli" },
      path: "/workspace/notes/out.txt",
      mode: "append",
    }),
    { allowed: true },
  );
});
