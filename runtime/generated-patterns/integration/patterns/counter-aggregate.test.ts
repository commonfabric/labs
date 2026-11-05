import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterAggregateScenario: PatternIntegrationScenario<
  { counters?: number[] }
> = {
  name: "counter aggregator sums nested counters",
  module: new URL("./counter-aggregate.pattern.ts", import.meta.url),
  exportName: "counterAggregator",
  argument: { counters: [1, 2, 3] },
  steps: [
    {
      expect: [
        { path: "counters", value: [1, 2, 3] },
        { path: "count", value: 3 },
        { path: "total", value: 6 },
        { path: "summary", value: "Total 6 across 3" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { index: 1, amount: 2 } }],
      expect: [
        { path: "counters", value: [1, 4, 3] },
        { path: "total", value: 8 },
        { path: "summary", value: "Total 8 across 3" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { index: 3, amount: 5 } }],
      expect: [
        { path: "counters", value: [1, 4, 3, 5] },
        { path: "count", value: 4 },
        { path: "total", value: 13 },
        { path: "summary", value: "Total 13 across 4" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { index: 0, amount: -1 } }],
      expect: [
        { path: "counters", value: [0, 4, 3, 5] },
        { path: "total", value: 12 },
        { path: "summary", value: "Total 12 across 4" },
      ],
    },
  ],
};

export const scenarios = [counterAggregateScenario];

describe("counter-aggregate", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
