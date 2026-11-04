import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterNoOpEventsScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "counter ignores empty increment payloads",
  module: new URL("./counter-no-op-events.pattern.ts", import.meta.url),
  exportName: "counterNoOpEvents",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "updateCount", value: 0 },
        { path: "hasChanges", value: false },
        { path: "status", value: "no changes" },
        { path: "label", value: "Counter value 0 (no changes)" },
        { path: "lastEvent", value: "none" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "currentValue", value: 0 },
        { path: "updateCount", value: 0 },
        { path: "hasChanges", value: false },
        { path: "status", value: "no changes" },
        { path: "label", value: "Counter value 0 (no changes)" },
        { path: "lastEvent", value: "none" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: "skip" } }],
      expect: [
        { path: "currentValue", value: 0 },
        { path: "updateCount", value: 0 },
        { path: "hasChanges", value: false },
        { path: "status", value: "no changes" },
        { path: "label", value: "Counter value 0 (no changes)" },
        { path: "lastEvent", value: "none" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "currentValue", value: 3 },
        { path: "updateCount", value: 1 },
        { path: "hasChanges", value: true },
        { path: "status", value: "changed" },
        { path: "label", value: "Counter value 3 (changed)" },
        { path: "lastEvent", value: "applied 3" },
      ],
    },
    {
      events: [{ stream: "increment", payload: {} }],
      expect: [
        { path: "currentValue", value: 3 },
        { path: "updateCount", value: 1 },
        { path: "hasChanges", value: true },
        { path: "status", value: "changed" },
        { path: "label", value: "Counter value 3 (changed)" },
        { path: "lastEvent", value: "applied 3" },
      ],
    },
  ],
};

export const scenarios = [counterNoOpEventsScenario];

describe("counter-no-op-events", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
