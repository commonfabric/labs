import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterKeyedMapScenario: PatternIntegrationScenario<
  { counters?: Record<string, number> }
> = {
  name: "counter map updates keyed entries",
  module: new URL("./counter-keyed-map.pattern.ts", import.meta.url),
  exportName: "counterMapByKey",
  argument: { counters: { alpha: 1, beta: 2 } },
  steps: [
    {
      expect: [
        { path: "counters", value: { alpha: 1, beta: 2 } },
        { path: "keys", value: ["alpha", "beta"] },
        { path: "count", value: 2 },
        { path: "total", value: 3 },
        { path: "summary", value: "2 keys total 3" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { key: "beta", amount: 3 } }],
      expect: [
        { path: "counters", value: { alpha: 1, beta: 5 } },
        { path: "total", value: 6 },
        { path: "keys", value: ["alpha", "beta"] },
        { path: "summary", value: "2 keys total 6" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: { key: "gamma", amount: 4 } }],
      expect: [
        { path: "counters", value: { alpha: 1, beta: 5, gamma: 4 } },
        { path: "keys", value: ["alpha", "beta", "gamma"] },
        { path: "count", value: 3 },
        { path: "total", value: 10 },
        { path: "summary", value: "3 keys total 10" },
      ],
    },
    {
      events: [{ stream: "adjust", payload: {} }],
      expect: [
        {
          path: "counters",
          value: { alpha: 1, beta: 5, gamma: 4, default: 1 },
        },
        { path: "keys", value: ["alpha", "beta", "default", "gamma"] },
        { path: "count", value: 4 },
        { path: "total", value: 11 },
        { path: "summary", value: "4 keys total 11" },
      ],
    },
  ],
};

export const scenarios = [counterKeyedMapScenario];

describe("counter-keyed-map", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
