import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterHandlerSpawnScenario: PatternIntegrationScenario<
  { children?: Array<{ value?: number }> }
> = {
  name: "handler spawns nested child patterns",
  module: new URL("./counter-handler-spawn.pattern.ts", import.meta.url),
  exportName: "counterWithHandlerSpawn",
  steps: [
    {
      expect: [
        { path: "children", value: [] },
      ],
    },
    {
      events: [{ stream: "spawn", payload: { seed: 3 } }],
      expect: [
        { path: "children.0.value", value: 3 },
        { path: "children.0.label", value: "Child value 3" },
      ],
    },
    {
      events: [{ stream: "spawn", payload: { seed: 1 } }],
      expect: [
        { path: "children.0.value", value: 3 },
        { path: "children.1.value", value: 1 },
        { path: "children.1.label", value: "Child value 1" },
      ],
    },
    {
      events: [{ stream: "children.0.increment", payload: {} }],
      expect: [
        { path: "children.0.value", value: 4 },
        { path: "children.0.label", value: "Child value 4" },
        { path: "children.1.value", value: 1 },
      ],
    },
    {
      events: [{ stream: "children.1.increment", payload: { amount: 5 } }],
      expect: [
        { path: "children.1.value", value: 6 },
        { path: "children.1.label", value: "Child value 6" },
      ],
    },
  ],
};

export const scenarios = [counterHandlerSpawnScenario];

describe("counter-handler-spawn", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
