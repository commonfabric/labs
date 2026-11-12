import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { evaluateHarnessWriteFileAuthorization } from "../../src/cfc/harness-write-policy.ts";

describe("evaluateHarnessWriteFileAuthorization()", () => {
  it("returns allowed without a warning when enforcement is disabled", () => {
    expect(evaluateHarnessWriteFileAuthorization({
      enforcementMode: "disabled",
      path: "/workspace/notes/out.txt",
    })).toEqual({ allowed: true });
  });

  it("returns a denial in enforce-strict without direct-command authorization", () => {
    for (const promptSlot of [undefined, { role: "quote" as const }]) {
      expect(evaluateHarnessWriteFileAuthorization({
        enforcementMode: "enforce-strict",
        promptSlot,
        path: "/workspace/notes/out.txt",
      })).toEqual({
        allowed: false,
        denialDetail:
          "write_file requires direct-command authorization in enforce-strict",
      });
    }
  });
});
