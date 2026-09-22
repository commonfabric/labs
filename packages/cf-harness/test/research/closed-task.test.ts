import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isClosedResearchTask } from "../../src/research/closed-task.ts";

describe("isClosedResearchTask()", () => {
  const patternId = "v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s";

  it("returns false for an open task with no attached patterns", () => {
    expect(isClosedResearchTask("Build a counter.", { patternRefs: [] }))
      .toBe(false);
  });

  for (
    const task of [
      `Run ${patternId} and give it a slug.`,
      `Compose \`cf:pattern:${patternId}\`.`,
      "Use the skill commonfabric/labs/cf-spend-digest: run its budget script.",
      "Use commonfabric/labs/cf-spend-digest.",
      "Follow the `commonfabric/labs/cf-spend-digest` skill.",
      "Use https://skills.sh/commonfabric/labs/cf-spend-digest.",
    ]
  ) {
    it(`returns true for the explicit selection ${JSON.stringify(task)}`, () => {
      expect(isClosedResearchTask(task, {})).toBe(true);
    });
  }

  for (
    const task of [
      "Build a dinner planner from reusable pieces.",
      "Find a skill for comparing monthly spending.",
      "Read docs/common/README.md to build a counter.",
      "Use docs/common/concepts/reactivity.md to build a counter.",
      "Use the skill owner/../digest.",
      "Use the skill owner/repo.",
      `Revise the piece fid1:${patternId}.`,
      `Use the handle cfh:a:${patternId}.`,
      `Find a pattern matching ${patternId.slice(0, -1)}.`,
      `Find a pattern matching ${patternId}x.`,
      "Build a page like cf-spend-digest-extra.",
    ]
  ) {
    it(`returns false without an exact selection in ${JSON.stringify(task)}`, () => {
      expect(isClosedResearchTask(task, {})).toBe(false);
    });
  }
});
