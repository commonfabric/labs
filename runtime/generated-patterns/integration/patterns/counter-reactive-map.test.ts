import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterReactiveMapScenario: PatternIntegrationScenario<
  { value?: number; history?: number[]; labelPrefix?: string }
> = {
  name: "counter uses opaque ref map for history",
  module: new URL("./counter-reactive-map.pattern.ts", import.meta.url),
  exportName: "counterWithReactiveMap",
  argument: {
    value: 5,
    history: [2, 5],
    labelPrefix: "Count",
  },
  steps: [
    {
      expect: [
        { path: "value", value: 5 },
        { path: "labels", value: ["#0: 2", "#1: 5"] },
        { path: "count", value: 2 },
        { path: "total", value: 7 },
        { path: "headline", value: "Count 5 (2 entries)" },
      ],
    },
    {
      events: [
        { stream: "record", payload: { delta: 3 } },
      ],
      expect: [
        { path: "value", value: 8 },
        { path: "history", value: [2, 5, 8] },
        { path: "labels", value: ["#0: 2", "#1: 5", "#2: 8"] },
        { path: "count", value: 3 },
        { path: "total", value: 15 },
        { path: "headline", value: "Count 8 (3 entries)" },
      ],
    },
    {
      events: [
        { stream: "rewrite", payload: { index: 0, value: 10 } },
      ],
      expect: [
        { path: "history", value: [10, 5, 8] },
        { path: "labels", value: ["#0: 10", "#1: 5", "#2: 8"] },
        { path: "count", value: 3 },
        { path: "total", value: 23 },
        { path: "headline", value: "Count 8 (3 entries)" },
      ],
    },
  ],
};

export const scenarios = [counterReactiveMapScenario];

describe("counter-reactive-map", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
