import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterWithDynamicStepScenario: PatternIntegrationScenario<
  { value?: number; step?: number }
> = {
  name: "counter updates step dynamically",
  module: new URL(
    "./counter-dynamic-step.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDynamicStep",
  argument: { value: 0, step: 1 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "step", value: 1 },
      ],
    },
    {
      events: [{ stream: "controls.increment", payload: {} }],
      expect: [{ path: "value", value: 1 }],
    },
    {
      events: [{ stream: "controls.setStep", payload: { size: 3 } }],
      expect: [{ path: "step", value: 3 }],
    },
    {
      events: [{ stream: "controls.increment", payload: {} }],
      expect: [{ path: "value", value: 4 }],
    },
  ],
};

export const scenarios = [counterWithDynamicStepScenario];

describe("counter-dynamic-step", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
