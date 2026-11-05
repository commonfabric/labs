import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const counterDeduplicatedListScenario: PatternIntegrationScenario<
  { value?: number; uniqueValues?: number[] }
> = {
  name: "counter records deduplicated history",
  module: new URL("./counter-deduplicated-list.pattern.ts", import.meta.url),
  exportName: "counterWithDeduplicatedList",
  steps: [
    {
      expect: [
        { path: "currentValue", value: 0 },
        { path: "uniqueValues", value: [] },
        { path: "sortedUnique", value: [] },
        { path: "uniqueLabel", value: "Unique values: none" },
        { path: "additions", value: 0 },
        { path: "duplicates", value: 0 },
        { path: "audit", value: { added: 0, skipped: 0 } },
      ],
    },
    {
      events: [{ stream: "add", payload: { amount: 3 } }],
      expect: [
        { path: "currentValue", value: 3 },
        { path: "uniqueValues", value: [3] },
        { path: "sortedUnique", value: [3] },
        { path: "uniqueLabel", value: "Unique values: 3" },
        { path: "additions", value: 1 },
        { path: "duplicates", value: 0 },
        { path: "audit", value: { added: 1, skipped: 0 } },
      ],
    },
    {
      events: [{ stream: "add", payload: { amount: 2 } }],
      expect: [
        { path: "currentValue", value: 5 },
        { path: "uniqueValues", value: [3, 5] },
        { path: "sortedUnique", value: [3, 5] },
        { path: "uniqueLabel", value: "Unique values: 3, 5" },
        { path: "additions", value: 2 },
        { path: "duplicates", value: 0 },
        { path: "audit", value: { added: 2, skipped: 0 } },
      ],
    },
    {
      events: [{ stream: "add", payload: { amount: 2 } }],
      expect: [
        { path: "currentValue", value: 7 },
        { path: "uniqueValues", value: [3, 5, 7] },
        { path: "sortedUnique", value: [3, 5, 7] },
        { path: "uniqueLabel", value: "Unique values: 3, 5, 7" },
        { path: "additions", value: 3 },
        { path: "duplicates", value: 0 },
        { path: "audit", value: { added: 3, skipped: 0 } },
      ],
    },
    {
      events: [{ stream: "add", payload: { amount: -2 } }],
      expect: [
        { path: "currentValue", value: 5 },
        { path: "uniqueValues", value: [3, 5, 7] },
        { path: "sortedUnique", value: [3, 5, 7] },
        { path: "uniqueLabel", value: "Unique values: 3, 5, 7" },
        { path: "additions", value: 3 },
        { path: "duplicates", value: 1 },
        { path: "audit", value: { added: 3, skipped: 1 } },
      ],
    },
    {
      events: [{ stream: "add", payload: { amount: 10 } }],
      expect: [
        { path: "currentValue", value: 15 },
        { path: "uniqueValues", value: [3, 5, 7, 15] },
        { path: "sortedUnique", value: [3, 5, 7, 15] },
        { path: "uniqueLabel", value: "Unique values: 3, 5, 7, 15" },
        { path: "additions", value: 4 },
        { path: "duplicates", value: 1 },
        { path: "audit", value: { added: 4, skipped: 1 } },
      ],
    },
  ],
};

export const scenarios = [counterDeduplicatedListScenario];

describe("counter-deduplicated-list", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
