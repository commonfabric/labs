import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterSortDirectionToggleScenario: PatternIntegrationScenario<
  {
    count?: number;
    entries?: number[];
    direction?: "asc" | "desc";
  }
> = {
  name: "counter toggles sort direction across updates",
  module: new URL(
    "./counter-sort-direction-toggle.pattern.ts",
    import.meta.url,
  ),
  exportName: "counterWithSortDirectionToggle",
  steps: [
    {
      expect: [
        { path: "current", value: 0 },
        { path: "values", value: [] },
        { path: "sortedValues", value: [] },
        { path: "direction", value: "asc" },
        { path: "directionLabel", value: "ascending" },
        { path: "sortedValuesLabel", value: "[]" },
        { path: "label", value: "Sorted ascending: []" },
        { path: "directionHistory", value: [] },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 3 } }],
      expect: [
        { path: "current", value: 3 },
        { path: "values", value: [3] },
        { path: "sortedValues", value: [3] },
        { path: "label", value: "Sorted ascending: [3]" },
        { path: "sortedValuesLabel", value: "[3]" },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: -1 } }],
      expect: [
        { path: "current", value: 2 },
        { path: "values", value: [3, 2] },
        { path: "sortedValues", value: [2, 3] },
        { path: "sortedValuesLabel", value: "[2, 3]" },
        { path: "label", value: "Sorted ascending: [2, 3]" },
      ],
    },
    {
      events: [{ stream: "toggleDirection", payload: {} }],
      expect: [
        { path: "direction", value: "desc" },
        { path: "directionLabel", value: "descending" },
        { path: "sortedValues", value: [3, 2] },
        { path: "sortedValuesLabel", value: "[3, 2]" },
        { path: "label", value: "Sorted descending: [3, 2]" },
        { path: "directionHistory", value: ["desc"] },
      ],
    },
    {
      events: [{ stream: "increment", payload: { amount: 5 } }],
      expect: [
        { path: "current", value: 7 },
        { path: "values", value: [3, 2, 7] },
        { path: "sortedValues", value: [7, 3, 2] },
        { path: "sortedValuesLabel", value: "[7, 3, 2]" },
        { path: "label", value: "Sorted descending: [7, 3, 2]" },
        { path: "directionHistory", value: ["desc"] },
      ],
    },
    {
      events: [{ stream: "toggleDirection", payload: { direction: "asc" } }],
      expect: [
        { path: "direction", value: "asc" },
        { path: "directionLabel", value: "ascending" },
        { path: "sortedValues", value: [2, 3, 7] },
        { path: "sortedValuesLabel", value: "[2, 3, 7]" },
        { path: "label", value: "Sorted ascending: [2, 3, 7]" },
        { path: "directionHistory", value: ["desc", "asc"] },
      ],
    },
  ],
};

export const scenarios = [counterSortDirectionToggleScenario];

describe("counter-sort-direction-toggle", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
