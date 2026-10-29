import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterConditionalBranchScenario: PatternIntegrationScenario<
  { value?: number; enabled?: boolean }
> = {
  name: "counter swaps label via ifElse branch",
  module: new URL(
    "./counter-conditional-branch.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithConditionalBranch",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "active", value: false },
        { path: "branch", value: "Disabled" },
        { path: "label", value: "Disabled 0" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "current", value: 1 },
        { path: "branch", value: "Disabled" },
        { path: "label", value: "Disabled 1" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "active", value: true },
        { path: "branch", value: "Enabled" },
        { path: "current", value: 1 },
        { path: "label", value: "Enabled 1" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "current", value: 3 },
        { path: "branch", value: "Enabled" },
        { path: "label", value: "Enabled 3" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "active", value: false },
        { path: "branch", value: "Disabled" },
        { path: "current", value: 3 },
        { path: "label", value: "Disabled 3" },
      ],
    },
  ],
};

export const scenarios = [counterConditionalBranchScenario];

describe("counter-conditional-branch", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
