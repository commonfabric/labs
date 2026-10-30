import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { PIECE_TARGETING_GUIDANCE } from "../src/piece-targeting.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";

describe("piece-targeting", () => {
  it("retains technical guidance without prescribing how to select a target", () => {
    expect(PIECE_TARGETING_GUIDANCE).toContain(
      "resolve_piece resolves a piece slug",
    );
    expect(PIECE_TARGETING_GUIDANCE).toContain(
      "Use a held piece reference when revising a piece",
    );
    expect(PIECE_TARGETING_GUIDANCE).not.toContain("ask the user");
    expect(PIECE_TARGETING_GUIDANCE).not.toContain("registry read");
    expect(finishTaskTool.descriptor.description).not.toContain(
      "For an unspecified piece",
    );
  });
});
