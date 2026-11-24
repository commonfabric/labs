import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface ComposedCounterScenarioArgs {
  left?: number;
  right?: number;
}

export const composedCounterScenario: PatternIntegrationScenario<
  ComposedCounterScenarioArgs
> = {
  name: "composed counters mirror nested child",
  module: new URL("./composed-counter.pattern.ts", import.meta.url),
  exportName: "composedCounters",
  argument: { left: 1, right: 2 },
  steps: [
    {
      expect: [
        { path: "left.value", value: 1 },
        { path: "right.value", value: 2 },
        { path: "total", value: 3 },
      ],
    },
    {
      events: [
        {
          stream: "left.increment",
          payload: { amount: 4 },
        },
      ],
      expect: [
        { path: "left.value", value: 5 },
        { path: "right.value", value: 2 },
        { path: "total", value: 7 },
      ],
    },
    {
      events: [
        {
          stream: "right.increment",
          payload: { amount: 1 },
        },
      ],
      expect: [
        { path: "left.value", value: 5 },
        { path: "right.value", value: 3 },
        { path: "total", value: 8 },
      ],
    },
    {
      events: [{ stream: "actions.mirrorRight", payload: {} }],
      expect: [
        { path: "left.value", value: 5 },
        { path: "right.value", value: 5 },
        { path: "total", value: 10 },
      ],
    },
  ],
};

export const scenarios = [composedCounterScenario];

describe("composed-counter", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
