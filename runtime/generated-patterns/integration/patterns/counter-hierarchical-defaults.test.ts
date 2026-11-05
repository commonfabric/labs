import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterHierarchicalDefaultsScenario: PatternIntegrationScenario<
  {
    settings?: {
      label?: string;
      step?: number;
      formatting?: { prefix?: string; suffix?: string };
    };
  }
> = {
  name: "counter applies hierarchical defaults",
  module: new URL(
    "./counter-hierarchical-defaults.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithHierarchicalDefaults",
  argument: {
    settings: {
      step: 3,
      formatting: { prefix: "Score" },
    },
  },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "effectiveStep", value: 3 },
        { path: "resolvedSettings.label", value: "Counter" },
        { path: "resolvedSettings.formatting.prefix", value: "Score" },
        { path: "resolvedSettings.formatting.suffix", value: "items" },
        { path: "display", value: "Score 0 items" },
        { path: "summary", value: "Counter: 0" },
      ],
    },
    {
      events: [{ stream: "controls.adjust", payload: {} }],
      expect: [
        { path: "value", value: 3 },
        { path: "display", value: "Score 3 items" },
        { path: "summary", value: "Counter: 3" },
      ],
    },
    {
      events: [{ stream: "controls.adjust", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 5 },
        { path: "summary", value: "Counter: 5" },
      ],
    },
  ],
};

export const scenarios = [counterHierarchicalDefaultsScenario];

describe("counter-hierarchical-defaults", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
