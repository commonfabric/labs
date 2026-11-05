import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const simpleCounterScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "simple counter increments",
  module: new URL("./simple-counter.pattern.ts", import.meta.url),
  exportName: "simpleCounter",
  argument: { value: 0 },
  steps: [
    { expect: [{ path: "value", value: 0 }] },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [{ path: "value", value: 1 }],
    },
    {
      events: [{ stream: "increment", payload: { amount: 2 } }],
      expect: [{ path: "value", value: 3 }],
    },
  ],
};

export const scenarios = [simpleCounterScenario];

describe("simple-counter", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
