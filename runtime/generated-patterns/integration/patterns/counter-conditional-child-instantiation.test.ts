import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterConditionalChildInstantiationScenario:
  PatternIntegrationScenario = {
    name: "counter instantiates child only when active",
    module: new URL(
      "./counter-conditional-child-instantiation.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterWithConditionalChildInstantiation",
    steps: [
      {
        expect: [
          { path: "isActive", value: false },
          { path: "childStatus", value: "absent" },
          { path: "child", value: undefined },
          { path: "current", value: 0 },
          { path: "label", value: "Parent 0 (idle) child absent" },
        ],
      },
      {
        events: [{ stream: "toggle", payload: {} }],
        expect: [
          { path: "isActive", value: true },
          { path: "childStatus", value: "present" },
          { path: "label", value: "Parent 0 (active) child present" },
        ],
      },
      {
        events: [{ stream: "increment", payload: { amount: 2 } }],
        expect: [
          { path: "current", value: 2 },
          { path: "childStatus", value: "present" },
          { path: "label", value: "Parent 2 (active) child present" },
        ],
      },
      {
        events: [{ stream: "toggle", payload: {} }],
        expect: [
          { path: "isActive", value: false },
          { path: "child", value: undefined },
          { path: "childStatus", value: "absent" },
          { path: "label", value: "Parent 2 (idle) child absent" },
        ],
      },
      {
        events: [{ stream: "toggle", payload: {} }],
        expect: [
          { path: "isActive", value: true },
          { path: "childStatus", value: "present" },
          { path: "label", value: "Parent 2 (active) child present" },
        ],
      },
    ],
  };

export const scenarios = [counterConditionalChildInstantiationScenario];

describe("counter-conditional-child-instantiation", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
