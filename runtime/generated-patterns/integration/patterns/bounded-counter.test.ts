import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const boundedCounterScenario: PatternIntegrationScenario<
  { value?: number; min?: number; max?: number }
> = {
  name: "bounded counter clamps within limits",
  module: new URL("./bounded-counter.pattern.ts", import.meta.url),
  exportName: "boundedCounter",
  argument: { value: 2, min: 0, max: 5 },
  steps: [
    {
      expect: [
        { path: "value", value: 2 },
        { path: "bounds.min", value: 0 },
        { path: "bounds.max", value: 5 },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { amount: 5 } }],
      expect: [{ path: "value", value: 5 }],
    },
    {
      events: [{ stream: "adjust", payload: { amount: 1 } }],
      expect: [{ path: "value", value: 5 }],
    },
    {
      events: [{ stream: "adjust", payload: { amount: -10 } }],
      expect: [{ path: "value", value: 0 }],
    },
  ],
};

export const scenarios = [boundedCounterScenario];

describe("bounded-counter", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
