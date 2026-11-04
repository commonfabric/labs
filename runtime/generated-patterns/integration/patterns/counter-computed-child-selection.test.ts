import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterComputedChildSelectionScenario: PatternIntegrationScenario =
  {
    name: "counter derives child selection from computed index",
    module: new URL(
      "./counter-computed-child-selection.pattern.ts",
      import.meta.url,
    ),
    exportName: "counterComputedChildSelection",
    steps: [
      {
        expect: [
          { path: "counts.0", value: 2 },
          { path: "counts.1", value: 5 },
          { path: "counts.2", value: 3 },
          { path: "selectedIndex", value: 1 },
          { path: "selectedName", value: "Counter 2" },
          { path: "selectedValue", value: 5 },
          { path: "selectedLabel", value: "Counter 2 value 5" },
          { path: "summary", value: "Displaying Counter 2 (5)" },
        ],
      },
      {
        events: [{ stream: "adjust", payload: { index: 0, amount: 4 } }],
        expect: [
          { path: "counts.0", value: 6 },
          { path: "selectedIndex", value: 0 },
          { path: "selectedName", value: "Counter 1" },
          { path: "selectedValue", value: 6 },
          { path: "selectedLabel", value: "Counter 1 value 6" },
          { path: "summary", value: "Displaying Counter 1 (6)" },
          { path: "children.0.label", value: "Counter 1 value 6" },
        ],
      },
      {
        events: [{ stream: "adjust", payload: { index: 2, amount: 5 } }],
        expect: [
          { path: "counts.2", value: 8 },
          { path: "selectedIndex", value: 2 },
          { path: "selectedName", value: "Counter 3" },
          { path: "selectedValue", value: 8 },
          { path: "selectedLabel", value: "Counter 3 value 8" },
          { path: "summary", value: "Displaying Counter 3 (8)" },
          { path: "children.2.label", value: "Counter 3 value 8" },
        ],
      },
    ],
  };

export const scenarios = [counterComputedChildSelectionScenario];

describe("counter-computed-child-selection", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
