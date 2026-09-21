import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { buildCfHarnessBaseSystemPrompt } from "../src/cli.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";

describe("orientation", () => {
  it("gives the parent a shared inspection path for calendar and document requests before asking for the source", () => {
    const prompt = buildCfHarnessBaseSystemPrompt();
    expect(prompt).toContain(
      "inspect unresolved relevant handles with describe_handle before asking the user to connect or attach that source",
    );
    expect(prompt).toContain("A grant's name is a lead, not its contents");
    expect(prompt).toContain("not given does not mean absent");
    expect(prompt).toContain(
      "The parent can run an indexed pattern with run_pattern",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "any applicable bounded discovery route over the granted scope",
    );
  });

  it("checks the send path before asking for a recipient in the landlord-email rehearsal", () => {
    const prompt = buildCfHarnessBaseSystemPrompt();
    expect(prompt).toContain(
      "Before asking for a recipient or other execution detail, establish that an available tool, skill, or pattern can perform the action with the held authority",
    );
    expect(prompt).toContain(
      "If sending is unavailable, say so immediately and offer a draft",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "rather than asking for an address as though that enables sending",
    );
  });

  it("keeps discovery scoped and a release refusal out of the question path", () => {
    const prompt = buildCfHarnessBaseSystemPrompt();
    expect(prompt).toContain("resolve_piece first for a slug");
    expect(prompt).toContain("zero registry reads for an unnamed target");
    expect(prompt).toContain("at most one lookup for a display name");
    expect(prompt).toContain(
      "Explicit requests to list or analyze the space are not missing-target lookups",
    );
    expect(prompt).toContain(
      "An unavailable, refused, or pending read stays unknown",
    );
    expect(prompt).toContain(
      "Inspect run_pattern outputConcerns and the declared error branch",
    );
    expect(prompt).toContain(
      "describe only the successfully applied change, say the result could not be inspected",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "Never ask for a nonexistent permission to release results",
    );
  });
});
