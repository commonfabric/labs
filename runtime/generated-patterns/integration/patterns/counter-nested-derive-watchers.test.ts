import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNestedDeriveWatchersScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter propagates nested derive watchers",
  module: new URL(
    "./counter-nested-derive-watchers.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithNestedDeriveWatchers",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "magnitude", value: 0 },
        { path: "parity", value: "even" },
        { path: "emphasis", value: "steady" },
        { path: "parityCode", value: 0 },
        { path: "parityDetail", value: "parity even emphasis steady" },
        { path: "summary", value: "value 0 magnitude 0 code 0" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "current", value: 3 },
        { path: "magnitude", value: 3 },
        { path: "parity", value: "odd" },
        { path: "emphasis", value: "swing" },
        { path: "parityCode", value: 1 },
        { path: "parityDetail", value: "parity odd emphasis swing" },
        { path: "summary", value: "value 3 magnitude 3 code 1" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [
        { path: "current", value: 4 },
        { path: "magnitude", value: 4 },
        { path: "parity", value: "even" },
        { path: "emphasis", value: "steady" },
        { path: "parityCode", value: 0 },
        { path: "parityDetail", value: "parity even emphasis steady" },
        { path: "summary", value: "value 4 magnitude 4 code 0" },
      ],
    },
    {
      events: [{ stream: "setValue", payload: { value: -2 } }],
      expect: [
        { path: "current", value: -2 },
        { path: "magnitude", value: 2 },
        { path: "parity", value: "even" },
        { path: "emphasis", value: "steady" },
        { path: "parityCode", value: 0 },
        { path: "parityDetail", value: "parity even emphasis steady" },
        { path: "summary", value: "value -2 magnitude 2 code 0" },
      ],
    },
  ],
};

export const scenarios = [counterNestedDeriveWatchersScenario];

describe("counter-nested-derive-watchers", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
