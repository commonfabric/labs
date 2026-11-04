import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterConditionalIfElseScenario: PatternIntegrationScenario<
  { value?: number; visible?: boolean }
> = {
  name: "counter toggles conditional ifElse branch",
  module: new URL(
    "./counter-conditional-ifelse.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithConditionalUiBranch",
  steps: [
    {
      expect: [
        { path: "safeValue", value: 0 },
        { path: "isVisible", value: false },
        { path: "branchKind", value: "disabled" },
        { path: "branchHeader", value: "Disabled Panel" },
        { path: "branchVariant", value: "muted" },
        { path: "branchDescription", value: "Counter is hidden" },
        { path: "view.tree.header", value: "Disabled Panel" },
        { path: "label", value: "Disabled Panel 0" },
        { path: "status", value: "disabled (muted)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "safeValue", value: 1 },
        { path: "label", value: "Disabled Panel 1" },
        { path: "branchKind", value: "disabled" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "isVisible", value: true },
        { path: "branchKind", value: "enabled" },
        { path: "branchHeader", value: "Enabled Panel" },
        { path: "branchVariant", value: "primary" },
        { path: "branchDescription", value: "Counter is interactive" },
        { path: "view.tree.variant", value: "primary" },
        { path: "label", value: "Enabled Panel 1" },
        { path: "status", value: "enabled (primary)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "safeValue", value: 3 },
        { path: "label", value: "Enabled Panel 3" },
        { path: "branchDescription", value: "Counter is interactive" },
      ],
    },
    {
      events: [{ stream: "toggle", payload: {} }],
      expect: [
        { path: "isVisible", value: false },
        { path: "branchKind", value: "disabled" },
        { path: "branchHeader", value: "Disabled Panel" },
        { path: "view.tree.header", value: "Disabled Panel" },
        { path: "safeValue", value: 3 },
        { path: "label", value: "Disabled Panel 3" },
        { path: "status", value: "disabled (muted)" },
      ],
    },
  ],
};

export const scenarios = [counterConditionalIfElseScenario];

describe("counter-conditional-ifelse", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
