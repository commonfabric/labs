import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const doubleCounterWithSharedIncrementScenario:
  PatternIntegrationScenario<{ left?: number; right?: number }> = {
    name: "double counter shares increment handler",
    module: new URL(
      "./double-counter-shared-increment.pattern.ts",
      import.meta.url,
    ),
    exportName: "doubleCounterWithSharedIncrement",
    argument: { left: 0, right: 0 },
    steps: [
      {
        expect: [
          { path: "left", value: 0 },
          { path: "right", value: 0 },
          { path: "total", value: 0 },
        ],
      },
      {
        events: [{ stream: "controls.increment", payload: { amount: 2 } }],
        expect: [
          { path: "left", value: 2 },
          { path: "right", value: 2 },
          { path: "total", value: 4 },
        ],
      },
      {
        events: [{ stream: "controls.increment", payload: {} }],
        expect: [
          { path: "left", value: 3 },
          { path: "right", value: 3 },
          { path: "total", value: 6 },
        ],
      },
    ],
  };

export const scenarios = [doubleCounterWithSharedIncrementScenario];

describe("double-counter-shared-increment", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
