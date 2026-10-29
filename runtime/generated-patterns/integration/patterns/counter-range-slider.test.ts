import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRangeSliderSimulationScenario: PatternIntegrationScenario<
  { min?: number; max?: number; value?: number; step?: number }
> = {
  name: "counter simulates range slider interactions",
  module: new URL(
    "./counter-range-slider.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterRangeSliderSimulation",
  argument: { min: -20, max: 40, value: -10, step: 5 },
  steps: [
    {
      expect: [
        { path: "currentValue", value: -10 },
        { path: "percentage", value: 16.7 },
        { path: "label", value: "Slider at -10 (16.7%)" },
        { path: "rangeSummary", value: "Range -20 to 40" },
        { path: "interactions", value: 0 },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{
        stream: "controls.setPosition",
        payload: { percentage: 0.75 },
      }],
      expect: [
        { path: "currentValue", value: 25 },
        { path: "percentage", value: 75 },
        { path: "label", value: "Slider at 25 (75%)" },
        { path: "interactions", value: 1 },
        {
          path: "history",
          value: [{ interaction: 1, value: 25, percentage: 75 }],
        },
      ],
    },
    {
      events: [{
        stream: "controls.nudge",
        payload: { direction: "decrease", ticks: 2 },
      }],
      expect: [
        { path: "currentValue", value: 15 },
        { path: "percentage", value: 58.3 },
        { path: "label", value: "Slider at 15 (58.3%)" },
        { path: "interactions", value: 2 },
        {
          path: "history",
          value: [
            { interaction: 1, value: 25, percentage: 75 },
            { interaction: 2, value: 15, percentage: 58.3 },
          ],
        },
      ],
    },
    {
      events: [{ stream: "controls.setPosition", payload: { value: 100 } }],
      expect: [
        { path: "currentValue", value: 40 },
        { path: "percentage", value: 100 },
        { path: "label", value: "Slider at 40 (100%)" },
        { path: "interactions", value: 3 },
        {
          path: "history",
          value: [
            { interaction: 1, value: 25, percentage: 75 },
            { interaction: 2, value: 15, percentage: 58.3 },
            { interaction: 3, value: 40, percentage: 100 },
          ],
        },
      ],
    },
  ],
};

export const scenarios = [counterRangeSliderSimulationScenario];

describe("counter-range-slider", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
