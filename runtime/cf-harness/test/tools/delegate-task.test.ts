import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
} from "../../src/contracts/subagent.ts";
import { delegateTaskTool } from "../../src/tools/delegate-task.ts";

const offered = (subagentProfiles?: readonly HarnessSubagentProfile[]) => {
  const descriptor = delegateTaskTool.descriptorForRuntime?.(
    { kind: "runsc-cfc", defaultWorkingDirectory: "/workspace" },
    {
      cfcEnforcementMode: "observe",
      ...(subagentProfiles !== undefined ? { subagentProfiles } : {}),
    },
  ) ?? delegateTaskTool.descriptor;
  const profile = ((descriptor.inputSchema as { properties: unknown })
    .properties as Record<
      string,
      { enum?: string[]; description?: string }
    >).profile;
  return {
    enum: profile.enum,
    description: profile.description ?? "",
    required: (descriptor.inputSchema as { required: string[] }).required,
    text: JSON.stringify(descriptor.inputSchema),
  };
};

describe("delegate-task", () => {
  it("offers only the subagent profiles the run allows", () => {
    expect(offered(["default", "pattern-author", "browser"]).enum).toEqual([
      "default",
      "browser",
      "pattern-author",
    ]);
  });

  it("describes pattern-author only to a run that may delegate to it", () => {
    expect(offered(["default", "pattern-author"]).description).toContain(
      '"pattern-author"',
    );
    expect(offered(["default"]).description).not.toContain("pattern-author");
  });

  it("names pattern-author nowhere in the descriptor of a run that may not delegate to it", () => {
    expect(offered(["default", "browser"]).text).not.toContain(
      "pattern-author",
    );
  });

  it("requires a profile when the default profile is not among those offered", () => {
    expect(offered(["pattern-author"]).required).toEqual(["goal", "profile"]);
    expect(offered(["default", "pattern-author"]).required).toEqual(["goal"]);
  });

  it("offers every profile to a run that names none", () => {
    expect(offered().enum).toEqual([...HARNESS_SUBAGENT_PROFILES]);
    expect(offered([]).enum).toEqual([...HARNESS_SUBAGENT_PROFILES]);
  });

  it("does not send running an indexed pattern through pattern-author", () => {
    expect(offered().description).not.toContain("Authoring or running");
  });

  it("throws when invoked directly, since the prompt loop runs a delegation", () => {
    expect(() =>
      delegateTaskTool.invoke(
        {} as Parameters<typeof delegateTaskTool.invoke>[0],
        { goal: "unused", profile: "default" },
      )
    ).toThrow("delegate_task is orchestrated by the prompt loop");
  });
});
