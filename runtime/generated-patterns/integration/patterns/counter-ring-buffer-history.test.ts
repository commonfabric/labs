import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterRingBufferHistoryScenario: PatternIntegrationScenario<
  { value?: number; history?: number[]; capacity?: number }
> = {
  name: "counter maintains ring buffer history",
  module: new URL(
    "./counter-ring-buffer-history.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithRingBufferHistory",
  argument: { value: 0, history: [], capacity: 3 },
  steps: [
    {
      expect: [
        { path: "value", value: 0 },
        { path: "currentValue", value: 0 },
        { path: "history", value: [] },
        { path: "historyView", value: [] },
        { path: "limit", value: 3 },
        { path: "capacity", value: 3 },
        { path: "label", value: "Value 0 | limit 3" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [
        { path: "value", value: 2 },
        { path: "currentValue", value: 2 },
        { path: "history", value: [2] },
        { path: "historyView", value: [2] },
        { path: "limit", value: 3 },
        { path: "capacity", value: 3 },
        { path: "label", value: "Value 2 | limit 3" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "value", value: 5 },
        { path: "currentValue", value: 5 },
        { path: "history", value: [2, 5] },
        { path: "historyView", value: [2, 5] },
        { path: "limit", value: 3 },
        { path: "capacity", value: 3 },
        { path: "label", value: "Value 5 | limit 3" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 4 } }],
      expect: [
        { path: "value", value: 9 },
        { path: "currentValue", value: 9 },
        { path: "history", value: [2, 5, 9] },
        { path: "historyView", value: [2, 5, 9] },
        { path: "limit", value: 3 },
        { path: "capacity", value: 3 },
        { path: "label", value: "Value 9 | limit 3" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [
        { path: "value", value: 10 },
        { path: "currentValue", value: 10 },
        { path: "history", value: [5, 9, 10] },
        { path: "historyView", value: [5, 9, 10] },
        { path: "limit", value: 3 },
        { path: "capacity", value: 3 },
        { path: "label", value: "Value 10 | limit 3" },
      ],
    },
    {
      events: [{ stream: "resize", payload: { capacity: 2 } }],
      expect: [
        { path: "value", value: 10 },
        { path: "history", value: [9, 10] },
        { path: "historyView", value: [9, 10] },
        { path: "limit", value: 2 },
        { path: "capacity", value: 2 },
        { path: "label", value: "Value 10 | limit 2" },
      ],
    },
    {
      events: [{ stream: "resize", payload: { capacity: 0 } }],
      expect: [
        { path: "value", value: 10 },
        { path: "history", value: [10] },
        { path: "historyView", value: [10] },
        { path: "limit", value: 1 },
        { path: "capacity", value: 1 },
        { path: "label", value: "Value 10 | limit 1" },
      ],
    },
    {
      events: [{ stream: "resize", payload: { capacity: "four" } }],
      expect: [
        { path: "value", value: 10 },
        { path: "history", value: [10] },
        { path: "historyView", value: [10] },
        { path: "limit", value: 1 },
        { path: "capacity", value: 1 },
        { path: "label", value: "Value 10 | limit 1" },
      ],
    },
  ],
};

export const scenarios = [counterRingBufferHistoryScenario];

describe("counter-ring-buffer-history", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
