import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isClosedResearchTask } from "../../src/research/closed-task.ts";
import type { HarnessSkillRegistry } from "../../src/contracts/skill.ts";

describe("isClosedResearchTask()", () => {
  const patternId = "v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s";

  it("returns false for an open task with no attached patterns", () => {
    expect(isClosedResearchTask("Build a counter.", { patternRefs: [] }))
      .toBe(false);
  });

  for (
    const task of [
      `Run cf:pattern:${patternId} and give it a slug.`,
      `Compose \`cf:pattern:${patternId}\`.`,
      `Run **cf:pattern:${patternId}**.`,
      "Revise “pattern:demo-space/monthly-bills”.",
      "Use ‘skill:commonfabric/labs/cf-spend-digest’。",
      "Run cf:pattern:pat-expenses，then name the result.",
      "Instantiate cf:pattern:pat-expenses.",
      "Use cf:pattern:pat_Expenses-1.",
      "Revise pattern:demo-space/monthly-bills.",
      "Use the named skill skill:commonfabric/labs/cf-spend-digest.",
      "Follow `skill:commonfabric/labs/cf-spend-digest`.",
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
      "Use pattern matching to build a counter.",
      `Run ${patternId} and give it a slug.`,
      "Run pattern id pat-expenses.",
      "Use the named pattern pat-expenses.",
      "Run pattern named pat-expenses.",
      'Run pattern "pat-expenses".',
      "Use the named skill commonfabric/labs/cf-spend-digest.",
      "Follow the `commonfabric/labs/cf-spend-digest` skill.",
      "Use https://skills.sh/commonfabric/labs/cf-spend-digest.",
      "Read docs/common/README.md to build a counter.",
      "Use docs/common/README.md to build a counter.",
      "Use docs/common/example to build a counter.",
      "Use docs/common/concepts/reactivity.md to build a counter.",
      "Use the skill owner/../digest.",
      "Use the skill owner/repo.",
      "Use https://skills.sh/owner/repo.",
      `Revise the piece fid1:${patternId}.`,
      `Use the handle cfh:a:${patternId}.`,
      "Use cf:pattern:bad/id.",
      "Use cf:pattern:bad+id.",
      "Use cf:pattern:.",
      "Revise pattern:demo-space.",
      "Revise pattern:/monthly-bills.",
      "Revise pattern:demo-space/.",
      "Revise pattern:demo-space/folder/monthly-bills.",
      "Use skill:owner/../digest.",
      "Use skill:owner/repo.",
      "Use skill:unknown-skill.",
      "Read https://example.com/cf:pattern:pat-expenses.",
      "Read https://example.com/*cf:pattern:pat-expenses.",
      "Read /tmp/*cf:pattern:pat-expenses.",
      "Read docs/**cf:pattern:pat-expenses**.",
      "Read https://example.com/*skill:owner/repo/digest.",
      "Use pattern id bad/id.",
      `Build a page that displays identifier ${patternId}.`,
      `Find a pattern matching ${patternId.slice(0, -1)}.`,
      `Find a pattern matching ${patternId}x.`,
      "Build a page like cf-spend-digest-extra.",
    ]
  ) {
    it(`returns false without an exact selection in ${JSON.stringify(task)}`, () => {
      expect(isClosedResearchTask(task, {})).toBe(false);
    });
  }

  it("recognizes a registered skill only with its explicit marker", () => {
    const skillRegistry: HarnessSkillRegistry = {
      type: "cf-harness.skill-registry",
      version: 1,
      skillsRoot: "/skills",
      sandboxSkillsRoot: "/skills",
      generatedAt: "2026-09-22T00:00:00Z",
      skills: [{
        name: "cf-spend-digest",
        description: "Summarize spending.",
        skillDir: "/skills/cf-spend-digest",
        skillPath: "/skills/cf-spend-digest/SKILL.md",
        sandboxSkillDir: "/skills/cf-spend-digest",
        sandboxSkillPath: "/skills/cf-spend-digest/SKILL.md",
        digest: "test-digest",
        frontmatter: {},
        resources: [],
        diagnostics: [],
      }],
      diagnostics: [],
    };
    expect(
      isClosedResearchTask("Use skill:cf-spend-digest.", { skillRegistry }),
    )
      .toBe(true);
    expect(isClosedResearchTask("Use the named skill skill:cf-spend-digest.", {
      skillRegistry,
    })).toBe(true);
    expect(isClosedResearchTask("Use cf-spend-digest.", { skillRegistry }))
      .toBe(false);
    expect(isClosedResearchTask("Use the named skill cf-spend-digest.", {
      skillRegistry,
    })).toBe(false);
    expect(isClosedResearchTask("Use the cf-spend-digest skill.", {
      skillRegistry,
    })).toBe(false);
    expect(isClosedResearchTask("Use skill:unknown-skill.", { skillRegistry }))
      .toBe(false);
    expect(
      isClosedResearchTask("Read cf-spend-digest docs.", { skillRegistry }),
    )
      .toBe(false);
    expect(isClosedResearchTask("Build a page like cf-spend-digest-extra.", {
      skillRegistry,
    })).toBe(false);
  });
});
