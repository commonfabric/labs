import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithResetScenario: PatternIntegrationScenario<
  { value?: number; baseline?: number }
> = {
  name: "counter resets to baseline",
  module: new URL("./counter-reset.pattern.ts", import.meta.url),
  exportName: "counterWithReset",
  argument: { value: 0, baseline: 0 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "baseline", value: 0 },
        { path: "label", value: "Value 0" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 4 } }],
      expect: [{ path: "value", value: 4 }],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [{ path: "value", value: 6 }],
    },
    {
      events: [{ stream: "reset", payload: {} }],
      expect: [
        { path: "value", value: 0 },
        { path: "label", value: "Value 0" },
      ],
    },
  ],
};

export const scenarios = [counterWithResetScenario];

describe("counter-reset", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
