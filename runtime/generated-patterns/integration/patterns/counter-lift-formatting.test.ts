import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithLiftFormattingScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter formats label with lift",
  module: new URL(
    "./counter-lift-formatting.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithLiftFormatting",
  argument: { value: 0 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "formatted", value: "Value: 0.00" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [{ path: "formatted", value: "Value: 1.00" }],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2.5 } }],
      expect: [{ path: "formatted", value: "Value: 3.50" }],
    },
  ],
};

export const scenarios = [counterWithLiftFormattingScenario];

describe("counter-lift-formatting", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
