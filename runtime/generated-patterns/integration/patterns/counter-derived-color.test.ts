import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithDerivedColorScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter derives color from value",
  module: new URL(
    "./counter-derived-color.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedColor",
  argument: { value: 0 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "color", value: "green" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { amount: 6 } }],
      expect: [{ path: "color", value: "orange" }],
    },
    {
      events: [{ stream: "adjust", payload: { amount: 5 } }],
      expect: [{ path: "color", value: "red" }],
    },
    {
      events: [{ stream: "adjust", payload: { amount: -15 } }],
      expect: [
        { path: "value", value: -4 },
        { path: "color", value: "blue" },
      ],
    },
  ],
};

export const scenarios = [counterWithDerivedColorScenario];

describe("counter-derived-color", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
