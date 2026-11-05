import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRichLabelScenario: PatternIntegrationScenario<
  { value?: number; prefix?: string; step?: number; unit?: string }
> = {
  name: "counter builds rich interpolated label",
  module: new URL("./counter-rich-label.pattern.ts", import.meta.url),
  exportName: "counterWithRichLabel",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "heading", value: "Count" },
        { path: "settingsView.step", value: 2 },
        { path: "settingsView.unit", value: "items" },
        { path: "detail", value: "step 2 items" },
        { path: "label", value: "Count: 0 (step 2 items)" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "current", value: 2 },
        { path: "detail", value: "step 2 items" },
        { path: "label", value: "Count: 2 (step 2 items)" },
      ],
    },
    {
      events: [
        { stream: "settings.step", payload: 3 },
        { stream: "settings.unit", payload: "points" },
      ],
      expect: [
        { path: "detail", value: "step 3 points" },
        { path: "label", value: "Count: 2 (step 3 points)" },
        { path: "settingsView.step", value: 3 },
        { path: "settingsView.unit", value: "points" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "value", value: 5 },
        { path: "label", value: "Count: 5 (step 3 points)" },
      ],
    },
  ],
};

export const scenarios = [counterRichLabelScenario];

describe("counter-rich-label", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
