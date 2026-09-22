import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { PIECE_TARGETING_GUIDANCE } from "../src/piece-targeting.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";

describe("piece-targeting", () => {
  it("asks for an unresolved target while retaining attached and conversation targets", () => {
    const prompt = PIECE_TARGETING_GUIDANCE;
    expect(prompt).toContain("explicit attachment or user-supplied reference");
    expect(prompt).toContain(
      "piece unambiguously selected in this conversation",
    );
    expect(prompt).toContain("make zero registry reads and ask the user");
    expect(prompt).toContain("Do not delegate discovery of an unnamed target");
    expect(prompt).toContain("parent asks with finish_task outcome question");
  });

  it("bounds named target selection to one released unique match without restricting listing tasks", () => {
    const prompt = PIECE_TARGETING_GUIDANCE;
    expect(prompt).toContain(
      "user supplied only a display name rather than a slug",
    );
    expect(prompt).toContain("at most one registry read");
    expect(prompt).toContain("across the parent and its children together");
    expect(prompt).toContain(
      "released evidence identifies exactly one matching piece",
    );
    expect(prompt).toContain(
      "Do not enumerate references and inspect candidates",
    );
    expect(prompt).toContain(
      "ask for an attachment instead of rereading the registry to repair the projection",
    );
    expect(prompt).toContain(
      "never infer an omitted value from the piece name",
    );
    expect(prompt).toContain(
      "not to an explicit request to list or analyze the space",
    );
  });

  it("resolves a user-supplied slug before delegating in fresh and continued conversations", () => {
    expect(PIECE_TARGETING_GUIDANCE).toContain(
      "call resolve_piece before any author delegation or registry read",
    );
    expect(PIECE_TARGETING_GUIDANCE).toContain("change my recent-emails list");
    expect(PIECE_TARGETING_GUIDANCE).toContain("the recent-emails one");
    expect(PIECE_TARGETING_GUIDANCE).toContain("Do not author a name matcher");
  });

  it("allows the parent to ask about an unspecified piece before inspecting grants", () => {
    expect(finishTaskTool.descriptor.description).toContain(
      "For an unspecified piece, ask the user to attach or name it without reading the registry",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "Before asking the user to connect or attach a named data source",
    );
  });
});
