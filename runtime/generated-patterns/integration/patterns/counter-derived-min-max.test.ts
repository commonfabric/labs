import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDerivedMinMaxScenario: PatternIntegrationScenario<
  { value?: number; history?: number[] }
> = {
  name: "counter derives min and max from history",
  module: new URL(
    "./counter-derived-min-max.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithDerivedMinMax",
  argument: { value: 4, history: [4] },
  steps: [
    {
      expect: [
        { path: "value", value: 4 },
        { path: "history", value: [4] },
        { path: "minValue", value: 4 },
        { path: "maxValue", value: 4 },
        { path: "label", value: "Min: 4, Max: 4" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { amount: -2 } }],
      expect: [
        { path: "value", value: 2 },
        { path: "history", value: [4, 2] },
        { path: "minValue", value: 2 },
        { path: "maxValue", value: 4 },
        { path: "label", value: "Min: 2, Max: 4" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { amount: -7.9 } }],
      expect: [
        { path: "value", value: -5 },
        { path: "history", value: [4, 2, -5] },
        { path: "minValue", value: -5 },
        { path: "maxValue", value: 4 },
        { path: "label", value: "Min: -5, Max: 4" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { amount: 12 } }],
      expect: [
        { path: "value", value: 7 },
        { path: "history", value: [4, 2, -5, 7] },
        { path: "minValue", value: -5 },
        { path: "maxValue", value: 7 },
        { path: "label", value: "Min: -5, Max: 7" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: {} }],
      expect: [
        { path: "value", value: 8 },
        { path: "history", value: [4, 2, -5, 7, 8] },
        { path: "minValue", value: -5 },
        { path: "maxValue", value: 8 },
        { path: "label", value: "Min: -5, Max: 8" },
      ],
    },
  ],
};

export const scenarios = [counterDerivedMinMaxScenario];

describe("counter-derived-min-max", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
