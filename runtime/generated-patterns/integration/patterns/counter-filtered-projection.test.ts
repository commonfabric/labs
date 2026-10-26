import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterFilteredProjectionScenario: PatternIntegrationScenario<
  { counters?: number[]; threshold?: number }
> = {
  name: "counter filtered projection responds to threshold shifts",
  module: new URL("./counter-filtered-projection.pattern.ts", import.meta.url),
  exportName: "counterWithFilteredProjection",
  argument: { counters: [1, 4, -2, 6, 3], threshold: 3 },
  steps: [
    {
      expect: [
        { path: "counters", value: [1, 4, -2, 6, 3] },
        { path: "sanitizedCounters", value: [1, 4, -2, 6, 3] },
        { path: "filtered", value: [4, 6, 3] },
        { path: "excluded", value: [1, -2] },
        { path: "filteredLabel", value: "4, 6, 3" },
        { path: "excludedLabel", value: "1, -2" },
        { path: "summary", value: "Filtered 3 of 5 >= 3" },
      ],
    },
    {
      events: [{ stream: "append", payload: { value: 8 } }],
      expect: [
        { path: "counters", value: [1, 4, -2, 6, 3, 8] },
        { path: "sanitizedCounters", value: [1, 4, -2, 6, 3, 8] },
        { path: "filtered", value: [4, 6, 3, 8] },
        { path: "excluded", value: [1, -2] },
        { path: "summary", value: "Filtered 4 of 6 >= 3" },
      ],
    },
    {
      events: [{ stream: "setThreshold", payload: { value: 5 } }],
      expect: [
        { path: "thresholdValue", value: 5 },
        { path: "filtered", value: [6, 8] },
        { path: "excluded", value: [1, 4, -2, 3] },
        { path: "filteredLabel", value: "6, 8" },
        { path: "summary", value: "Filtered 2 of 6 >= 5" },
      ],
    },
    {
      events: [{ stream: "append", payload: { value: 2 } }],
      expect: [
        { path: "counters", value: [1, 4, -2, 6, 3, 8, 2] },
        { path: "sanitizedCounters", value: [1, 4, -2, 6, 3, 8, 2] },
        { path: "filtered", value: [6, 8] },
        { path: "excluded", value: [1, 4, -2, 3, 2] },
        { path: "summary", value: "Filtered 2 of 7 >= 5" },
      ],
    },
    {
      events: [{ stream: "replace", payload: { index: 1, value: 10 } }],
      expect: [
        { path: "counters", value: [1, 10, -2, 6, 3, 8, 2] },
        { path: "sanitizedCounters", value: [1, 10, -2, 6, 3, 8, 2] },
        { path: "filtered", value: [10, 6, 8] },
        { path: "excluded", value: [1, -2, 3, 2] },
        { path: "filteredLabel", value: "10, 6, 8" },
        { path: "summary", value: "Filtered 3 of 7 >= 5" },
      ],
    },
    {
      events: [{ stream: "setThreshold", payload: { value: -2 } }],
      expect: [
        { path: "thresholdValue", value: -2 },
        { path: "filtered", value: [1, 10, -2, 6, 3, 8, 2] },
        { path: "excluded", value: [] },
        { path: "summary", value: "Filtered 7 of 7 >= -2" },
      ],
    },
  ],
};

export const scenarios = [counterFilteredProjectionScenario];

describe("counter-filtered-projection", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
