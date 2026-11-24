import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface NestedCounterScenarioArgs {
  counters?: {
    left?: number;
    right?: number;
  };
}

export const nestedCountersScenario: PatternIntegrationScenario<
  NestedCounterScenarioArgs
> = {
  name: "nested counters maintain balance",
  module: new URL("./nested-counters.pattern.ts", import.meta.url),
  exportName: "nestedCounters",
  argument: { counters: { left: 2, right: 1 } },
  steps: [
    {
      expect: [
        { path: "counters.left", value: 2 },
        { path: "counters.right", value: 1 },
        { path: "total", value: 3 },
      ],
    },
    {
      events: [
        {
          stream: "controls.incrementLeft",
          payload: { amount: 3 },
        },
      ],
      expect: [
        { path: "counters.left", value: 5 },
        { path: "counters.right", value: 1 },
        { path: "total", value: 6 },
      ],
    },
    {
      events: [
        {
          stream: "controls.incrementRight",
          payload: { amount: 6 },
        },
      ],
      expect: [
        { path: "counters.left", value: 5 },
        { path: "counters.right", value: 7 },
        { path: "total", value: 12 },
      ],
    },
    {
      events: [{ stream: "controls.balance", payload: {} }],
      expect: [
        { path: "counters.left", value: 6 },
        { path: "counters.right", value: 6 },
        { path: "total", value: 12 },
      ],
    },
  ],
};

export const scenarios = [nestedCountersScenario];

describe("nested-counters", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
