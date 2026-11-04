import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRollingAverageScenario: PatternIntegrationScenario<
  { value?: number; history?: number[]; window?: number }
> = {
  name: "counter tracks rolling average over window",
  module: new URL("./counter-rolling-average.pattern.ts", import.meta.url),
  exportName: "counterWithRollingAverage",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "historyView", value: [] },
        { path: "average", value: 0 },
        { path: "label", value: "Average 0" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 4 } }],
      expect: [
        { path: "currentValue", value: 4 },
        { path: "historyView", value: [4] },
        { path: "average", value: 4 },
        { path: "label", value: "Average 4" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "currentValue", value: 6 },
        { path: "historyView", value: [4, 6] },
        { path: "average", value: 5 },
        { path: "label", value: "Average 5" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: -1 } }],
      expect: [
        { path: "currentValue", value: 5 },
        { path: "historyView", value: [4, 6, 5] },
        { path: "average", value: 5 },
        { path: "label", value: "Average 5" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 10 } }],
      expect: [
        { path: "currentValue", value: 15 },
        { path: "historyView", value: [4, 6, 5, 15] },
        { path: "average", value: 7.5 },
        { path: "label", value: "Average 7.5" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [
        { path: "currentValue", value: 16 },
        { path: "historyView", value: [4, 6, 5, 15, 16] },
        { path: "average", value: 9.2 },
        { path: "label", value: "Average 9.2" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 10 } }],
      expect: [
        { path: "currentValue", value: 26 },
        { path: "historyView", value: [6, 5, 15, 16, 26] },
        { path: "average", value: 13.6 },
        { path: "label", value: "Average 13.6" },
      ],
    },
  ],
};

export const scenarios = [counterRollingAverageScenario];

describe("counter-rolling-average", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
