import { assertEquals } from "@std/assert";
import type { CfcSandboxResult } from "../src/cfc/mod.ts";

Deno.test("CfcSandboxResult represents observed, opaque, and denied outputs", () => {
  const result = {
    version: 1,
    stdout: {
      channel: "stdout",
      policy: "observed",
      label: { confidentiality: ["public"] },
      segments: [{
        text: "ok\n",
        label: { confidentiality: ["public"] },
        offset: 0,
        byteLength: 3,
      }],
    },
    stderr: {
      channel: "stderr",
      policy: "denied",
      label: { confidentiality: ["secret"] },
      reason: "stderr release denied by policy",
    },
    exitCode: {
      policy: "opaque",
      label: { confidentiality: ["secret"] },
    },
    diagnostics: [{
      level: "warning",
      code: "stderr-denied",
      message: "stderr was withheld",
      label: { confidentiality: ["secret"] },
      details: { channel: "stderr" },
    }],
  } satisfies CfcSandboxResult;

  assertEquals(JSON.parse(JSON.stringify(result)), result);
});
